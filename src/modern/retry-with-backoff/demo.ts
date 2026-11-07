import {
  DecorrelatedJitterBackoff,
  EqualJitterBackoff,
  ExponentialBackoff,
  FakePaymentApi,
  FullJitterBackoff,
  PaymentClient,
  Retrier,
  RetryExhaustedError,
  VirtualTime,
  backoffDelays,
  isTransient,
  retryAfterFromHttp,
} from './retry-with-backoff';

// A small seeded generator so the demo prints the same numbers every run.
let seed = 42;
const rng = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);

console.log('\nFirst 8 delays (ms), base 100, cap 5000:');
for (const policy of [
  new ExponentialBackoff(100, 5_000),
  new FullJitterBackoff(100, 5_000),
  new EqualJitterBackoff(100, 5_000),
  new DecorrelatedJitterBackoff(100, 5_000),
]) {
  const gen = backoffDelays(policy, rng);
  const delays = Array.from({ length: 8 }, () => gen.next().value);
  console.log(`  ${policy.name.padEnd(20)} ${delays.join(', ')}`);
}

const time = new VirtualTime();
const api = new FakePaymentApi();
let keys = 0;
const retrier = new Retrier({
  maxAttempts: 4,
  policy: new FullJitterBackoff(200, 5_000),
  isRetryable: isTransient,
  retryAfterMs: retryAfterFromHttp(time.clock),
  deadlineMs: 10_000,
  onRetry: (e) => console.log(`  attempt ${e.attempt} failed (${(e.error as Error).message}); waiting ${e.delayMs} ms [${e.source}]`),
  sleep: time.sleep,
  rng,
  clock: time.clock,
});
const client = new PaymentClient(api, retrier, () => `idem_${++keys}`);

console.log('\nCharge Rs 499: 503, then 429 with Retry-After: 3, then the response is lost, then OK:');
api.reply({ kind: 'http', status: 503 }, { kind: 'http', status: 429, retryAfter: '3' }, { kind: 'lost-response' });
const charge = await client.charge(49_900);
console.log(`  -> ${charge.id} after ${time.clock.now()} ms virtual time; charges created: ${api.chargeCount}; keys sent: ${api.receivedKeys.join(', ')}`);

console.log('\nCharge Rs 10 while the API stays at 503:');
api.reply(...Array.from({ length: 4 }, () => ({ kind: 'http' as const, status: 503 })));
try {
  await client.charge(1_000);
} catch (error) {
  if (error instanceof RetryExhaustedError) console.log(`  -> ${error.message}`);
}

console.log('\nCharge with a 402 Payment Required: not transient, no retry:');
api.reply({ kind: 'http', status: 402 });
await client.charge(1_000).catch((error: Error) => console.log(`  -> ${error.message}, attempts made: 1`));
console.log();
