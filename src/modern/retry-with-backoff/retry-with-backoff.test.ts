import { describe, expect, it } from 'vitest';
import {
  DecorrelatedJitterBackoff,
  EqualJitterBackoff,
  ExponentialBackoff,
  FakePaymentApi,
  FullJitterBackoff,
  HttpError,
  PaymentClient,
  Retrier,
  RetryBudget,
  RetryBudgetExhaustedError,
  RetryDeadlineError,
  RetryExhaustedError,
  VirtualTime,
  backoffDelays,
  isTransient,
  parseRetryAfter,
  retryAfterFromHttp,
  type BackoffPolicy,
  type Rng,
  type RetryOptions,
} from './retry-with-backoff';

/** Cycles through the given values: a scripted random number generator. */
const scriptedRng = (...values: number[]): Rng => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};
const take = (gen: Generator<number>, n: number) => Array.from({ length: n }, () => gen.next().value as number);
const unavailable = { kind: 'http', status: 503 } as const;

function setup(overrides: Partial<RetryOptions> = {}, policy: BackoffPolicy = new EqualJitterBackoff(100, 1_000)) {
  const time = new VirtualTime();
  const api = new FakePaymentApi();
  let n = 0;
  const retrier = new Retrier({
    maxAttempts: 5,
    policy,
    isRetryable: isTransient,
    retryAfterMs: retryAfterFromHttp(time.clock),
    sleep: time.sleep,
    rng: scriptedRng(0.5),
    clock: time.clock,
    ...overrides,
  });
  const client = new PaymentClient(api, retrier, () => `idem_${++n}`);
  return { time, api, client };
}

describe('backoff policies (AWS "Exponential Backoff And Jitter")', () => {
  it('produce the exact delay sequences for a scripted rng', () => {
    const half = scriptedRng(0.5);
    expect(take(backoffDelays(new ExponentialBackoff(100, 1_000), half), 6)).toEqual([100, 200, 400, 800, 1_000, 1_000]);
    expect(take(backoffDelays(new FullJitterBackoff(100, 1_000), half), 6)).toEqual([50, 100, 200, 400, 500, 500]);
    expect(take(backoffDelays(new EqualJitterBackoff(100, 1_000), half), 6)).toEqual([75, 150, 300, 600, 750, 750]);
    expect(take(backoffDelays(new DecorrelatedJitterBackoff(100, 1_000), half), 6)).toEqual([200, 350, 575, 912, 1_000, 1_000]);
    expect(take(backoffDelays(new FullJitterBackoff(100, 1_000), scriptedRng(0.1, 0.9, 0)), 3)).toEqual([10, 180, 0]);
  });
});

describe('Retrier', () => {
  it('returns the value on a later success, sleeping the policy delays in between', async () => {
    const { time, api, client } = setup();
    api.reply(unavailable, unavailable, { kind: 'ok' });
    expect(await client.charge(49_900)).toMatchObject({ id: 'ch_1', amountMinor: 49_900 });
    expect(time.slept).toEqual([75, 150]);
    expect(api.receivedKeys).toEqual(['idem_1', 'idem_1', 'idem_1']);
  });

  it('stops immediately on a non-retryable error and rethrows it untouched', async () => {
    const { time, api, client } = setup();
    api.reply({ kind: 'http', status: 402 });
    const error = await client.charge(100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(402);
    expect(api.receivedKeys).toHaveLength(1);
    expect(time.slept).toEqual([]);
  });

  it('respects maxAttempts', async () => {
    const { api, client } = setup({ maxAttempts: 3 });
    api.reply(unavailable, unavailable, unavailable, unavailable);
    const error = await client.charge(100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect((error as RetryExhaustedError).attempts).toBe(3);
    expect((error as RetryExhaustedError).cause).toBeInstanceOf(HttpError);
    expect(api.receivedKeys).toHaveLength(3);
  });

  it('never sleeps past the overall deadline', async () => {
    const { time, api, client } = setup({ maxAttempts: 10, deadlineMs: 500 }, new ExponentialBackoff(100, 1_000));
    api.reply(unavailable, unavailable, unavailable, unavailable);
    const error = await client.charge(100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryDeadlineError); // 100 + 200 slept; another 400 would end at 700 > 500
    expect(time.slept).toEqual([100, 200]);
    expect(api.receivedKeys).toHaveLength(3);
  });

  it('honours Retry-After in seconds and as an HTTP-date', async () => {
    const { time, api, client } = setup();
    api.reply({ kind: 'http', status: 429, retryAfter: '2' }, { kind: 'http', status: 503, retryAfter: new Date(5_000).toUTCString() });
    await client.charge(100);
    expect(time.slept).toEqual([2_000, 3_000]); // the date is 5 s, we are at 2 s
    expect(parseRetryAfter('soon', 0)).toBeUndefined();
  });

  it('is safe to retry a lost response because the idempotency key is reused', async () => {
    const { api, client } = setup();
    api.reply({ kind: 'lost-response' }, { kind: 'ok' });
    const charge = await client.charge(49_900);
    expect(api.receivedKeys).toEqual(['idem_1', 'idem_1']);
    expect(api.chargeCount).toBe(1); // charged once, not twice
    expect(charge.id).toBe('ch_1');
  });

  it('fails fast once the retry budget is spent', async () => {
    const { api, client } = setup({ budget: new RetryBudget(0, 1) });
    api.reply(unavailable, { kind: 'ok' }, unavailable);
    await client.charge(100); // uses the only retry
    await expect(client.charge(100)).rejects.toBeInstanceOf(RetryBudgetExhaustedError);
  });
});
