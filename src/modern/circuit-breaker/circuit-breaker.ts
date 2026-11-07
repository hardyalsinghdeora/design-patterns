/**
 * CIRCUIT BREAKER
 * Wrap calls to a remote dependency; once too many recent calls fail, stop calling it for a while (fail fast), then let a few trial calls decide whether it has recovered.
 */

/* Example domain: a checkout charging cards through a flaky payment gateway. Amounts are in paise. */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Injected so the open duration can be tested without real time passing. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface StateChange {
  breaker: string;
  from: CircuitState;
  to: CircuitState;
  at: number;
  reason: string;
}

/** Thrown (or handed to the fallback) when a call is not permitted. The inner call never ran. */
export class CircuitOpenError extends Error {
  constructor(
    readonly breaker: string,
    readonly retryAfterMs: number,
  ) {
    super(`Circuit "${breaker}" is open; retry in ${retryAfterMs} ms`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  name: string;
  /** Percentage of failed calls in the window (1-100) that opens the circuit. */
  failureRateThreshold: number;
  /** How many of the most recent calls the window remembers. */
  slidingWindowSize: number;
  /** Do not judge the failure rate on fewer calls than this: 1 failure out of 1 is not 100 %. */
  minimumNumberOfCalls: number;
  /** How long to stay OPEN before allowing trial calls. */
  openDurationMs: number;
  /** Trial calls allowed in HALF_OPEN; all must succeed to close again. */
  permittedCallsInHalfOpen: number;
  /** Which errors say "the dependency is sick". Default: every error. */
  isFailure?: (error: unknown) => boolean;
  clock?: Clock;
}

export interface CircuitMetrics {
  state: CircuitState;
  failureRatePercent: number;
  bufferedCalls: number;
  notPermittedCalls: number;
}

/**
 * Count-based sliding window: a ring buffer of the last N outcomes with a
 * running failure count, so recording and reading the rate are both O(1).
 */
export class CountBasedWindow {
  private readonly outcomes: boolean[] = []; // true = failure
  private next = 0;
  private failures = 0;

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('window size must be a positive integer');
  }

  record(failed: boolean): void {
    if (this.outcomes.length < this.size) {
      this.outcomes.push(failed);
    } else {
      if (this.outcomes[this.next]) this.failures--; // evict the oldest outcome
      this.outcomes[this.next] = failed;
    }
    if (failed) this.failures++;
    this.next = (this.next + 1) % this.size;
  }

  get calls(): number {
    return this.outcomes.length;
  }

  get failureRatePercent(): number {
    return this.calls === 0 ? 0 : (this.failures * 100) / this.calls;
  }

  reset(): void {
    this.outcomes.length = 0;
    this.next = 0;
    this.failures = 0;
  }
}

type Listener = (change: StateChange) => void;

/**
 * The breaker. It is a small state machine wrapped around any async call:
 *   CLOSED    calls pass through, outcomes go into the window
 *   OPEN      calls are rejected without touching the dependency
 *   HALF_OPEN a limited number of trial calls decide CLOSED or OPEN again
 */
export class CircuitBreaker {
  private current: CircuitState = 'CLOSED';
  private readonly window: CountBasedWindow;
  private readonly isFailure: (error: unknown) => boolean;
  private readonly clock: Clock;
  private readonly listeners: Listener[] = [];
  private openedAt = 0;
  private trialPermits = 0;
  private trialSuccesses = 0;
  private notPermitted = 0;
  /**
   * Bumped on every transition. A slow call that started in an earlier state
   * must not count in the new one (e.g. a CLOSED-era timeout arriving during HALF_OPEN).
   */
  private generation = 0;

  constructor(private readonly options: CircuitBreakerOptions) {
    if (options.failureRateThreshold <= 0 || options.failureRateThreshold > 100) {
      throw new RangeError('failureRateThreshold must be in (0, 100]');
    }
    if (options.minimumNumberOfCalls < 1 || options.permittedCallsInHalfOpen < 1) {
      throw new RangeError('minimumNumberOfCalls and permittedCallsInHalfOpen must be >= 1');
    }
    this.window = new CountBasedWindow(options.slidingWindowSize);
    this.isFailure = options.isFailure ?? (() => true);
    this.clock = options.clock ?? systemClock;
  }

  get name(): string {
    return this.options.name;
  }

  /** Reading the state applies the time-based OPEN -> HALF_OPEN move, so it is never stale. */
  get state(): CircuitState {
    this.moveToHalfOpenIfCoolDownElapsed();
    return this.current;
  }

  onStateChange(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  metrics(): CircuitMetrics {
    return {
      state: this.state,
      failureRatePercent: this.window.failureRatePercent,
      bufferedCalls: this.window.calls,
      notPermittedCalls: this.notPermitted,
    };
  }

  /**
   * Run `call` through the breaker. The fallback runs when the call is not
   * permitted or fails with a counted error; errors the predicate does not
   * count (a 400 for a bad card number) are the caller's problem and propagate.
   */
  async execute<T>(call: () => Promise<T>, fallback?: (error: unknown) => T | Promise<T>): Promise<T> {
    let generation: number;
    try {
      generation = this.acquirePermission();
    } catch (error) {
      this.notPermitted++;
      if (fallback) return await fallback(error);
      throw error;
    }

    let result: T;
    try {
      result = await call();
    } catch (error) {
      if (!this.isFailure(error)) {
        // The dependency answered correctly; it was the request that was bad.
        this.recordSuccess(generation);
        throw error;
      }
      this.recordFailure(generation);
      if (fallback) return await fallback(error);
      throw error;
    }
    this.recordSuccess(generation);
    return result;
  }

  /** Idiomatic TS: wrap a function once and get back one with the same signature. */
  wrap<A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
    fallback?: (error: unknown, ...args: A) => R | Promise<R>,
  ): (...args: A) => Promise<R> {
    return (...args: A) => this.execute(() => fn(...args), fallback && ((error) => fallback(error, ...args)));
  }

  private acquirePermission(): number {
    this.moveToHalfOpenIfCoolDownElapsed();
    if (this.current === 'CLOSED') return this.generation;
    if (this.current === 'HALF_OPEN' && this.trialPermits < this.options.permittedCallsInHalfOpen) {
      this.trialPermits++;
      return this.generation;
    }
    throw new CircuitOpenError(this.options.name, this.retryAfterMs());
  }

  private retryAfterMs(): number {
    if (this.current !== 'OPEN') return 0;
    return Math.max(0, this.openedAt + this.options.openDurationMs - this.clock.now());
  }

  private recordSuccess(generation: number): void {
    if (generation !== this.generation) return;
    if (this.current === 'HALF_OPEN') {
      this.trialSuccesses++;
      if (this.trialSuccesses >= this.options.permittedCallsInHalfOpen) {
        this.transition('CLOSED', `${this.trialSuccesses} trial calls succeeded`);
      }
      return;
    }
    this.window.record(false);
    this.evaluate(); // 4 failures then 1 success can still cross the threshold at the minimum
  }

  private recordFailure(generation: number): void {
    if (generation !== this.generation) return;
    if (this.current === 'HALF_OPEN') {
      this.transition('OPEN', 'trial call failed');
      return;
    }
    this.window.record(true);
    this.evaluate();
  }

  private evaluate(): void {
    if (this.window.calls < this.options.minimumNumberOfCalls) return;
    const rate = this.window.failureRatePercent;
    if (rate >= this.options.failureRateThreshold) {
      this.transition('OPEN', `failure rate ${rate.toFixed(0)}% over last ${this.window.calls} calls`);
    }
  }

  private moveToHalfOpenIfCoolDownElapsed(): void {
    if (this.current === 'OPEN' && this.clock.now() - this.openedAt >= this.options.openDurationMs) {
      this.transition('HALF_OPEN', 'open duration elapsed');
    }
  }

  private transition(to: CircuitState, reason: string): void {
    const from = this.current;
    this.current = to;
    this.generation++;
    this.window.reset(); // every state starts with a clean slate
    this.trialPermits = 0;
    this.trialSuccesses = 0;
    if (to === 'OPEN') this.openedAt = this.clock.now();
    const change: StateChange = { breaker: this.options.name, from, to, at: this.clock.now(), reason };
    for (const listener of [...this.listeners]) listener(change);
  }
}

/* ------------------------------------------------------------------------ */
/* The protected dependency: a payment gateway fake with scripted replies.   */
/* ------------------------------------------------------------------------ */

export interface ChargeRequest {
  paymentId: string;
  amountMinor: number;
  currency: 'INR';
}

export interface ChargeReceipt {
  paymentId: string;
  status: 'captured' | 'queued';
  gatewayRef?: string;
}

export class GatewayTimeoutError extends Error {
  constructor(message = 'gateway did not answer within 2000 ms') {
    super(message);
    this.name = 'GatewayTimeoutError';
  }
}

export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`${status} ${message}`);
    this.name = 'GatewayHttpError';
  }
}

export type GatewayReply = 'ok' | 'timeout' | 'server-error' | 'bad-request';

export class FlakyPaymentGateway {
  calls = 0;
  private readonly script: GatewayReply[] = [];

  constructor(private defaultReply: GatewayReply = 'ok') {}

  /** Queue the next replies; once the script runs out the default reply is used. */
  willReply(...replies: GatewayReply[]): this {
    this.script.push(...replies);
    return this;
  }

  setDefault(reply: GatewayReply): void {
    this.defaultReply = reply;
  }

  async charge(request: ChargeRequest): Promise<ChargeReceipt> {
    this.calls++;
    const reply = this.script.shift() ?? this.defaultReply;
    switch (reply) {
      case 'ok':
        return { paymentId: request.paymentId, status: 'captured', gatewayRef: `gw_${this.calls}` };
      case 'timeout':
        throw new GatewayTimeoutError();
      case 'server-error':
        throw new GatewayHttpError(503, 'Service Unavailable');
      case 'bad-request':
        throw new GatewayHttpError(400, 'invalid card number');
    }
  }
}

/** Timeouts and 5xx mean the gateway is sick. 4xx means our request was wrong: do not trip. */
export const countsAgainstGateway = (error: unknown): boolean =>
  error instanceof GatewayTimeoutError || (error instanceof GatewayHttpError && error.status >= 500);

export function createGatewayBreaker(clock: Clock, overrides: Partial<CircuitBreakerOptions> = {}): CircuitBreaker {
  return new CircuitBreaker({
    name: 'payment-gateway',
    failureRateThreshold: 50,
    slidingWindowSize: 10,
    minimumNumberOfCalls: 5,
    openDurationMs: 30_000,
    permittedCallsInHalfOpen: 2,
    isFailure: countsAgainstGateway,
    clock,
    ...overrides,
  });
}

/**
 * The client. Its fallback is a degraded mode, not an error page: accept the
 * order, park the charge for a capture job, and tell the customer it is pending.
 */
export class PaymentService {
  readonly parked: ChargeRequest[] = [];

  constructor(
    private readonly gateway: FlakyPaymentGateway,
    readonly breaker: CircuitBreaker,
  ) {}

  charge(request: ChargeRequest): Promise<ChargeReceipt> {
    return this.breaker.execute(
      () => this.gateway.charge(request),
      () => {
        this.parked.push(request);
        return { paymentId: request.paymentId, status: 'queued' };
      },
    );
  }
}
