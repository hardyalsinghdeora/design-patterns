import {
  CachingHttpClient,
  InMemoryHttpClient,
  InMemoryMetrics,
  LoggingHttpClient,
  MetricsHttpClient,
  RetryHttpClient,
  decorate,
  type HttpResponse,
} from './decorator';

// A flaky FX-rate service: the first two calls fail with 503.
let calls = 0;
const fxService = new InMemoryHttpClient((): HttpResponse => {
  calls++;
  return calls <= 2 ? { status: 503, headers: {}, body: '' } : { status: 200, headers: {}, body: '{"USD-INR":8312}' };
});

// Fake time: the demo never waits, sleep just moves the clock.
let now = 0;
const clock = () => now;
const sleep = async (ms: number) => {
  now += ms;
};
const metrics = new InMemoryMetrics();

const client = decorate(
  fxService,
  (c) => new MetricsHttpClient(c, metrics, clock),
  (c) => new LoggingHttpClient(c, (line) => console.log('  [log]', line), clock),
  (c) => new CachingHttpClient(c, { ttlMs: 60_000, clock }),
  (c) => new RetryHttpClient(c, { maxAttempts: 3, sleep }),
);
const GET = { method: 'GET' as const, url: 'https://fx.example.com/rates/USD-INR' };

console.log('\nStack: Metrics -> Logging -> Cache -> Retry -> service\n');
console.log('First call (service fails twice, retry absorbs it, logged once):');
const first = await client.send(GET);
console.log(`  status ${first.status} x-cache=${first.headers['x-cache']} body ${first.body}; service calls so far: ${calls}`);

console.log('\nSecond call (cache hit, retry and service never run):');
const second = await client.send(GET);
console.log(`  status ${second.status} x-cache=${second.headers['x-cache']}; service calls so far: ${calls}`);

now += 60_000;
console.log('\nAfter the 60s TTL (miss again):');
const third = await client.send(GET);
console.log(`  status ${third.status} x-cache=${third.headers['x-cache']}; service calls so far: ${calls}`);

console.log('\nMetrics (outermost layer sees every call, hits included):');
for (const [key, value] of metrics.counters) console.log(`  ${key} = ${value}`);

const naked = new LoggingHttpClient(new RetryHttpClient(fxService, { maxAttempts: 1, sleep }), (l) => console.log('  [log]', l), clock);
console.log('\nSame component, different stack (no cache, no retries):');
await naked.send(GET);
console.log();
