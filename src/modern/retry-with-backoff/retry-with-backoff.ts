/**
 * RETRY WITH BACKOFF
 * Re-run a call that failed for a transient reason, waiting exponentially longer (and randomly) between attempts so retrying clients do not hammer a recovering service in lockstep.
 */

/* Example domain: creating a charge on a payment API that answers 503/429 under load. Amounts are in paise. */

/** Random number in [0, 1). Injected so delay sequences are deterministic in tests. */
export type Rng = () => number;
/** Injected so tests do not wait; production passes a setTimeout-based sleep. */
export type Sleep = (ms: number) => Promise<void>;

export interface Clock {
  now(): number;
}

/** Test double: sleeping advances the clock instantly and records the delay. */
export class VirtualTime {
  private t = 0;
  readonly slept: number[] = [];
  readonly clock: Clock = { now: () => this.t };
  readonly sleep: Sleep = async (ms) => {
    this.slept.push(ms);
    this.t += ms;
  };
  advance(ms: number): void {
    this.t += ms;
  }
}

/* ------------------------------------------------------------------------ */
/* Backoff policies, after Marc Brooker's AWS Architecture Blog post         */
/* "Exponential Backoff And Jitter". `retry` is 0 for the first retry.       */
/* ------------------------------------------------------------------------ */

export interface BackoffPolicy {
  readonly name: string;
  readonly baseMs: number;
  readonly capMs: number;
  /** previousDelayMs is the delay chosen for the previous retry (baseMs before the first). */
  delayFor(retry: number, previousDelayMs: number, rng: Rng): number;
}

const exponentialCeiling = (baseMs: number, capMs: number, retry: number): number =>
  Math.min(capMs, baseMs * 2 ** retry);

/** sleep = min(cap, base * 2^retry). No jitter: clients that failed together retry together. */
export class ExponentialBackoff implements BackoffPolicy {
  readonly name = 'exponential';
  constructor(
    readonly baseMs: number,
    readonly capMs: number,
  ) {}
  delayFor(retry: number): number {
    return exponentialCeiling(this.baseMs, this.capMs, retry);
  }
}

/** sleep = random_between(0, min(cap, base * 2^retry)). Least total work in Brooker's simulation. */
export class FullJitterBackoff implements BackoffPolicy {
  readonly name = 'full-jitter';
  constructor(
    readonly baseMs: number,
    readonly capMs: number,
  ) {}
  delayFor(retry: number, _previousDelayMs: number, rng: Rng): number {
    return Math.floor(rng() * exponentialCeiling(this.baseMs, this.capMs, retry));
  }
}

/** temp = min(cap, base * 2^retry); sleep = temp/2 + random_between(0, temp/2). Never waits near zero. */
export class EqualJitterBackoff implements BackoffPolicy {
  readonly name = 'equal-jitter';
  constructor(
    readonly baseMs: number,
    readonly capMs: number,
  ) {}
  delayFor(retry: number, _previousDelayMs: number, rng: Rng): number {
    const half = exponentialCeiling(this.baseMs, this.capMs, retry) / 2;
    return Math.floor(half + rng() * half);
  }
}

/** sleep = min(cap, random_between(base, previous_sleep * 3)). Grows from the last delay, not the attempt number. */
export class DecorrelatedJitterBackoff implements BackoffPolicy {
  readonly name = 'decorrelated-jitter';
  constructor(
    readonly baseMs: number,
    readonly capMs: number,
  ) {}
  delayFor(_retry: number, previousDelayMs: number, rng: Rng): number {
    const upper = previousDelayMs * 3;
    return Math.min(this.capMs, Math.floor(this.baseMs + rng() * (upper - this.baseMs)));
  }
}

/** Idiomatic TS: the delay schedule as an infinite generator. Easy to print, test and take(n) from. */
export function* backoffDelays(policy: BackoffPolicy, rng: Rng): Generator<number, never, undefined> {
  let previous = policy.baseMs;
  for (let retry = 0; ; retry++) {
    const delay = policy.delayFor(retry, previous, rng);
    previous = delay;
    yield delay;
  }
}

/* ------------------------------------------------------------------------ */
/* Retry budget: caps retries as a share of requests, so a fleet-wide outage */
/* cannot multiply load by maxAttempts. Real ones decay over a time window.  */
/* ------------------------------------------------------------------------ */

export class RetryBudget {
  private requests = 0;
  private retries = 0;

  constructor(
    private readonly ratio = 0.1,
    private readonly minRetries = 10,
  ) {}

  recordRequest(): void {
    this.requests++;
  }

  tryAcquireRetry(): boolean {
    const allowed = Math.max(this.minRetries, Math.floor(this.requests * this.ratio));
    if (this.retries >= allowed) return false;
    this.retries++;
    return true;
  }
}

/* ------------------------------------------------------------------------ */
/* The retrier                                                               */
/* ------------------------------------------------------------------------ */

export class RetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`gave up after ${attempts} attempts`, { cause: lastError });
    this.name = 'RetryExhaustedError';
  }
}

export class RetryDeadlineError extends Error {
  constructor(
    readonly attempts: number,
    readonly elapsedMs: number,
    readonly lastError: unknown,
  ) {
    super(`next retry would pass the deadline (${attempts} attempts, ${elapsedMs} ms elapsed)`, { cause: lastError });
    this.name = 'RetryDeadlineError';
  }
}

export class RetryBudgetExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super('retry budget exhausted; failing fast', { cause: lastError });
    this.name = 'RetryBudgetExhaustedError';
  }
}

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  source: 'backoff' | 'retry-after';
  error: unknown;
}

export interface AttemptContext {
  attempt: number;
  /** Time left before the overall deadline; pass it on as the per-attempt timeout. */
  remainingMs: number;
}

export interface RetryOptions {
  /** Total attempts including the first call. */
  maxAttempts: number;
  policy: BackoffPolicy;
  isRetryable: (error: unknown) => boolean;
  /** Server hint (Retry-After) in ms; when present it replaces the computed delay. */
  retryAfterMs?: (error: unknown) => number | undefined;
  /** Overall budget measured from the first attempt; never sleep past it. */
  deadlineMs?: number;
  budget?: RetryBudget;
  onRetry?: (event: RetryEvent) => void;
  sleep: Sleep;
  rng: Rng;
  clock: Clock;
}

export class Retrier {
  constructor(private readonly options: RetryOptions) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
  }

  async run<T>(operation: (ctx: AttemptContext) => Promise<T>): Promise<T> {
    const { maxAttempts, clock, sleep, isRetryable, budget } = this.options;
    const startedAt = clock.now();
    const deadline = this.options.deadlineMs === undefined ? Infinity : startedAt + this.options.deadlineMs;
    const delays = backoffDelays(this.options.policy, this.options.rng);
    budget?.recordRequest();

    for (let attempt = 1; ; attempt++) {
      try {
        return await operation({ attempt, remainingMs: deadline - clock.now() });
      } catch (error) {
        // Order matters: a non-retryable error is rethrown untouched, so callers can still match on it.
        if (!isRetryable(error)) throw error;
        if (attempt >= maxAttempts) throw new RetryExhaustedError(attempt, error);

        const computed = delays.next().value;
        const hinted = this.options.retryAfterMs?.(error);
        const delayMs = hinted ?? computed;
        if (clock.now() + delayMs > deadline) {
          throw new RetryDeadlineError(attempt, clock.now() - startedAt, error);
        }
        if (budget && !budget.tryAcquireRetry()) throw new RetryBudgetExhaustedError(attempt, error);

        this.options.onRetry?.({ attempt, delayMs, source: hinted === undefined ? 'backoff' : 'retry-after', error });
        await sleep(delayMs);
      }
    }
  }
}

/** Functional form: decorate a function once; every call gets the retry policy. */
export function withRetry<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  options: RetryOptions,
): (...args: A) => Promise<R> {
  const retrier = new Retrier(options);
  return (...args: A) => retrier.run(() => fn(...args));
}

/* ------------------------------------------------------------------------ */
/* HTTP classification and a payment API fake with idempotency keys          */
/* ------------------------------------------------------------------------ */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

export class NetworkError extends Error {
  constructor(readonly code: 'ECONNRESET' | 'ETIMEDOUT') {
    super(code);
    this.name = 'NetworkError';
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Transient: connection problems, throttling, gateway errors. Not transient: 400, 401, 402, 404, 409, 422. */
export const isTransient = (error: unknown): boolean =>
  error instanceof NetworkError || (error instanceof HttpError && RETRYABLE_STATUS.has(error.status));

/** Retry-After is either delay-seconds ("120") or an HTTP-date. Returns ms, or undefined if absent or invalid. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

export const retryAfterFromHttp =
  (clock: Clock) =>
  (error: unknown): number | undefined =>
    error instanceof HttpError ? parseRetryAfter(error.headers['retry-after'], clock.now()) : undefined;

export interface Charge {
  id: string;
  amountMinor: number;
  idempotencyKey: string;
}

/** Discriminated union: each scripted reply carries exactly the data it needs. */
export type ScriptedReply =
  | { kind: 'ok' }
  | { kind: 'http'; status: number; retryAfter?: string }
  /** The charge was committed, then the connection reset before we saw the response. */
  | { kind: 'lost-response' };

export class FakePaymentApi {
  readonly receivedKeys: string[] = [];
  private readonly chargesByKey = new Map<string, Charge>();
  private readonly script: ScriptedReply[] = [];

  reply(...replies: ScriptedReply[]): this {
    this.script.push(...replies);
    return this;
  }

  get chargeCount(): number {
    return this.chargesByKey.size;
  }

  async createCharge(input: { idempotencyKey: string; amountMinor: number }): Promise<Charge> {
    this.receivedKeys.push(input.idempotencyKey);
    const reply = this.script.shift() ?? { kind: 'ok' };
    if (reply.kind === 'http') {
      const headers: Record<string, string> = reply.retryAfter === undefined ? {} : { 'retry-after': reply.retryAfter };
      throw new HttpError(reply.status, headers);
    }
    // Same key, same charge: this is what makes the retry safe.
    let charge = this.chargesByKey.get(input.idempotencyKey);
    if (!charge) {
      charge = { id: `ch_${this.chargesByKey.size + 1}`, amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey };
      this.chargesByKey.set(input.idempotencyKey, charge);
    }
    if (reply.kind === 'lost-response') throw new NetworkError('ECONNRESET');
    return charge;
  }
}

/** The client: one idempotency key per logical charge, reused on every attempt. */
export class PaymentClient {
  constructor(
    private readonly api: FakePaymentApi,
    private readonly retrier: Retrier,
    private readonly newKey: () => string,
  ) {}

  charge(amountMinor: number): Promise<Charge> {
    const idempotencyKey = this.newKey(); // generated ONCE, outside the retry loop
    return this.retrier.run(() => this.api.createCharge({ idempotencyKey, amountMinor }));
  }
}
