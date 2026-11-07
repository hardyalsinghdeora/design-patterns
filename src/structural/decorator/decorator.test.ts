import { describe, expect, it } from 'vitest';
import {
  CachingHttpClient,
  FetchHttpClient,
  InMemoryHttpClient,
  InMemoryMetrics,
  LoggingHttpClient,
  MetricsHttpClient,
  RetryHttpClient,
  decorate,
  fromClient,
  pipe,
  withHeader,
  withLogging,
  type HttpResponse,
} from './decorator';

const ok = (body = '{"rate":83}'): HttpResponse => ({ status: 200, headers: {}, body });
const status = (code: number): HttpResponse => ({ status: code, headers: {}, body: '' });
const GET = { method: 'GET' as const, url: 'https://fx.example.com/rates/USD-INR' };

/** Replays scripted outcomes in order; an Error is thrown like a dropped socket. */
const scripted = (...outcomes: Array<HttpResponse | Error>) =>
  new InMemoryHttpClient(() => {
    const next = outcomes.shift() ?? ok();
    if (next instanceof Error) throw next;
    return next;
  });

/** A manual clock and a sleep that only records. Nothing real waits. */
const fakeTime = () => {
  let now = 0;
  const slept: number[] = [];
  return {
    clock: () => now,
    advance: (ms: number) => (now += ms),
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
};

describe('each decorator in isolation', () => {
  it('logging records request and response without changing the result', async () => {
    const lines: string[] = [];
    const t = fakeTime();
    const client = new LoggingHttpClient(new InMemoryHttpClient(() => (t.advance(12), ok())), (l) => lines.push(l), t.clock);
    expect(await client.send(GET)).toEqual(ok());
    expect(lines).toEqual([`-> GET ${GET.url}`, `<- 200 GET ${GET.url} (12ms)`]);
  });

  it('caching: a hit skips the inner call until the TTL expires', async () => {
    const t = fakeTime();
    const inner = scripted(ok('a'), ok('b'));
    const client = new CachingHttpClient(inner, { ttlMs: 60_000, clock: t.clock });
    expect((await client.send(GET)).headers['x-cache']).toBe('MISS');
    expect(await client.send(GET)).toMatchObject({ body: 'a', headers: { 'x-cache': 'HIT' } });
    expect(inner.calls).toHaveLength(1);
    t.advance(60_000);
    expect(await client.send(GET)).toMatchObject({ body: 'b', headers: { 'x-cache': 'MISS' } });
    expect(inner.calls).toHaveLength(2);
  });

  it('caching ignores POSTs and failed responses', async () => {
    const inner = scripted(status(503), ok());
    const client = new CachingHttpClient(inner, { ttlMs: 60_000, clock: () => 0 });
    await client.send(GET);
    await client.send(GET);
    await client.send({ ...GET, method: 'POST' });
    await client.send({ ...GET, method: 'POST' });
    expect(inner.calls).toHaveLength(4);
  });

  it('retry: retries 503 with backoff and stops at the first success', async () => {
    const t = fakeTime();
    const inner = scripted(status(503), new Error('ECONNRESET'), ok());
    const client = new RetryHttpClient(inner, { maxAttempts: 4, sleep: t.sleep });
    expect((await client.send(GET)).status).toBe(200);
    expect(inner.calls).toHaveLength(3);
    expect(t.slept).toEqual([100, 200]);
  });

  it('retry: gives up after maxAttempts and never retries a POST', async () => {
    const t = fakeTime();
    const failing = scripted(new Error('down'), new Error('down'), new Error('down'));
    await expect(new RetryHttpClient(failing, { maxAttempts: 3, sleep: t.sleep }).send(GET)).rejects.toThrow('down');
    expect(failing.calls).toHaveLength(3);

    const post = scripted(status(503));
    expect((await new RetryHttpClient(post, { maxAttempts: 3, sleep: t.sleep }).send({ ...GET, method: 'POST' })).status).toBe(503);
    expect(post.calls).toHaveLength(1);
  });

  it('metrics: counts by method and status and observes duration', async () => {
    const t = fakeTime();
    const metrics = new InMemoryMetrics();
    const client = new MetricsHttpClient(new InMemoryHttpClient(() => (t.advance(30), ok())), metrics, t.clock);
    await client.send(GET);
    await new MetricsHttpClient(scripted(new Error('x')), metrics, t.clock).send(GET).catch(() => undefined);
    expect(metrics.count('http_client_requests_total', { method: 'GET', status: '200' })).toBe(1);
    expect(metrics.count('http_client_requests_total', { method: 'GET', status: 'error' })).toBe(1);
    expect(metrics.observations[0]).toMatchObject({ name: 'http_client_duration_ms', value: 30 });
  });
});

describe('stacking', () => {
  it('order is observable: logging outside retry logs once, inside retry logs every attempt', async () => {
    const t = fakeTime();
    const outside: string[] = [];
    await decorate(
      scripted(status(503), status(503), ok()),
      (c) => new LoggingHttpClient(c, (l) => outside.push(l), t.clock),
      (c) => new RetryHttpClient(c, { maxAttempts: 3, sleep: t.sleep }),
    ).send(GET);

    const inside: string[] = [];
    await decorate(
      scripted(status(503), status(503), ok()),
      (c) => new RetryHttpClient(c, { maxAttempts: 3, sleep: t.sleep }),
      (c) => new LoggingHttpClient(c, (l) => inside.push(l), t.clock),
    ).send(GET);

    expect(outside.filter((l) => l.startsWith('->'))).toHaveLength(1);
    expect(inside.filter((l) => l.startsWith('->'))).toHaveLength(3);
  });

  it('metrics outside the cache see hits, metrics inside see only misses', async () => {
    const outer = new InMemoryMetrics();
    const innerMetrics = new InMemoryMetrics();
    const base = scripted(ok());
    const client = decorate(
      base,
      (c) => new MetricsHttpClient(c, outer, () => 0),
      (c) => new CachingHttpClient(c, { ttlMs: 1_000, clock: () => 0 }),
      (c) => new MetricsHttpClient(c, innerMetrics, () => 0),
    );
    for (let i = 0; i < 3; i++) await client.send(GET);
    const tags = { method: 'GET', status: '200' };
    expect([outer.count('http_client_requests_total', tags), innerMetrics.count('http_client_requests_total', tags)]).toEqual([3, 1]);
    expect(base.calls).toHaveLength(1);
  });

  it('functional middlewares compose the same way and wrap a real component', async () => {
    const lines: string[] = [];
    const fetchFn = async (url: string, init: { method: string; headers?: Record<string, string> }) => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ url, method: init.method, auth: init.headers?.['authorization'] }),
    });
    const send = pipe(fromClient(new FetchHttpClient(fetchFn)), withLogging((l) => lines.push(l)), withHeader('authorization', 'Bearer t0k'));
    const res = await send(GET);
    expect(JSON.parse(res.body)).toEqual({ url: GET.url, method: 'GET', auth: 'Bearer t0k' });
    expect(res.headers['content-type']).toBe('application/json');
    expect(lines).toHaveLength(2);
  });
});
