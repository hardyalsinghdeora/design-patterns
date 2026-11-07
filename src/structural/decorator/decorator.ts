/**
 * DECORATOR
 * Attach responsibilities to an object at runtime by wrapping it in another
 * object with the same interface; wrappers stack in any order, per instance.
 *
 * Example domain: an HttpClient wrapped by Logging, Caching, Retry and Metrics.
 * Time and sleeping are injected, so the library code never starts a timer.
 */

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The component interface. Every decorator is also one of these. */
export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

/* ------------------------------------------------------------------------ */
/* Concrete components.                                                      */
/* ------------------------------------------------------------------------ */

/** The subset of `fetch` we use, so tests can inject a fake. */
export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; headers: { forEach(cb: (value: string, key: string) => void): void }; text(): Promise<string> }>;

export class FetchHttpClient implements HttpClient {
  constructor(private readonly fetchFn: FetchLike = (url, init) => globalThis.fetch(url, init)) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const res = await this.fetchFn(request.url, {
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, headers, body: await res.text() };
  }
}

/** An in-process component for tests and demos: answers from a handler, records every call. */
export class InMemoryHttpClient implements HttpClient {
  readonly calls: HttpRequest[] = [];

  constructor(private readonly handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(request);
    return this.handler(request);
  }
}

/* ------------------------------------------------------------------------ */
/* The decorators. The base class forwards; each subclass adds one concern.  */
/* ------------------------------------------------------------------------ */

export abstract class HttpClientDecorator implements HttpClient {
  constructor(protected readonly inner: HttpClient) {}

  send(request: HttpRequest): Promise<HttpResponse> {
    return this.inner.send(request);
  }
}

export class LoggingHttpClient extends HttpClientDecorator {
  constructor(
    inner: HttpClient,
    private readonly log: (line: string) => void,
    private readonly clock: Clock = Date.now,
  ) {
    super(inner);
  }

  override async send(request: HttpRequest): Promise<HttpResponse> {
    const started = this.clock();
    const what = `${request.method} ${request.url}`;
    this.log(`-> ${what}`);
    try {
      const response = await this.inner.send(request);
      this.log(`<- ${response.status} ${what} (${this.clock() - started}ms)`);
      return response;
    } catch (e) {
      this.log(`x- ${what} failed: ${e instanceof Error ? e.message : String(e)} (${this.clock() - started}ms)`);
      throw e;
    }
  }
}

export interface CacheOptions {
  ttlMs: number;
  clock: Clock;
}

/** Caches successful GETs for `ttlMs`. Marks responses with `x-cache: HIT|MISS`. */
export class CachingHttpClient extends HttpClientDecorator {
  private readonly entries = new Map<string, { response: HttpResponse; expiresAt: number }>();
  readonly stats = { hits: 0, misses: 0 };

  constructor(
    inner: HttpClient,
    private readonly options: CacheOptions,
  ) {
    super(inner);
  }

  override async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.method !== 'GET') return this.inner.send(request);
    const key = `${request.method} ${request.url}`;
    const now = this.options.clock();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      this.stats.hits++;
      return copy(cached.response, 'HIT');
    }
    this.stats.misses++;
    const response = await this.inner.send(request);
    // Only cache successes: caching a 503 would turn a blip into an outage for ttlMs.
    if (response.status >= 200 && response.status < 300) {
      this.entries.set(key, { response: copy(response), expiresAt: now + this.options.ttlMs });
    }
    return copy(response, 'MISS');
  }
}

/** Callers get their own copy so mutating a response cannot corrupt the cache. */
function copy(response: HttpResponse, cache?: 'HIT' | 'MISS'): HttpResponse {
  return { ...response, headers: { ...response.headers, ...(cache ? { 'x-cache': cache } : {}) } };
}

export interface RetryOptions {
  maxAttempts: number;
  sleep: Sleep;
  backoffMs?: (attempt: number) => number;
  retryOnStatus?: (status: number) => boolean;
}

const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

/** Retries idempotent requests on thrown errors and on 429/502/503/504, with backoff. */
export class RetryHttpClient extends HttpClientDecorator {
  private readonly backoffMs: (attempt: number) => number;
  private readonly retryOnStatus: (status: number) => boolean;

  constructor(
    inner: HttpClient,
    private readonly options: RetryOptions,
  ) {
    super(inner);
    this.backoffMs = options.backoffMs ?? ((attempt) => 100 * 2 ** (attempt - 1));
    this.retryOnStatus = options.retryOnStatus ?? ((s) => s === 429 || s === 502 || s === 503 || s === 504);
  }

  override async send(request: HttpRequest): Promise<HttpResponse> {
    // Retrying a POST can charge a card twice. Without an idempotency key, do not.
    const attempts = IDEMPOTENT.has(request.method) ? this.options.maxAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= attempts;
      try {
        const response = await this.inner.send(request);
        if (last || !this.retryOnStatus(response.status)) return response;
      } catch (e) {
        if (last) throw e;
      }
      await this.options.sleep(this.backoffMs(attempt));
    }
  }
}

export interface MetricsSink {
  increment(name: string, tags: Record<string, string>): void;
  observe(name: string, value: number, tags: Record<string, string>): void;
}

export class InMemoryMetrics implements MetricsSink {
  readonly counters = new Map<string, number>();
  readonly observations: Array<{ name: string; value: number; tags: Record<string, string> }> = [];

  increment(name: string, tags: Record<string, string>): void {
    const key = `${name}${JSON.stringify(tags)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observe(name: string, value: number, tags: Record<string, string>): void {
    this.observations.push({ name, value, tags });
  }

  count(name: string, tags: Record<string, string>): number {
    return this.counters.get(`${name}${JSON.stringify(tags)}`) ?? 0;
  }
}

export class MetricsHttpClient extends HttpClientDecorator {
  constructor(
    inner: HttpClient,
    private readonly sink: MetricsSink,
    private readonly clock: Clock = Date.now,
  ) {
    super(inner);
  }

  override async send(request: HttpRequest): Promise<HttpResponse> {
    const started = this.clock();
    let status = 'error';
    try {
      const response = await this.inner.send(request);
      status = String(response.status);
      return response;
    } finally {
      const tags = { method: request.method, status };
      this.sink.increment('http_client_requests_total', tags);
      this.sink.observe('http_client_duration_ms', this.clock() - started, tags);
    }
  }
}

/** Stack layers around a base client. The FIRST layer is the OUTERMOST. */
export function decorate(base: HttpClient, ...layers: Array<(inner: HttpClient) => HttpClient>): HttpClient {
  return layers.reduceRight<HttpClient>((client, wrap) => wrap(client), base);
}

/* ------------------------------------------------------------------------ */
/* Idiomatic TypeScript: decorators as higher-order functions. A "client" is */
/* just a send function, and a middleware maps one send to another.          */
/* ------------------------------------------------------------------------ */

export type Send = (request: HttpRequest) => Promise<HttpResponse>;
export type Middleware = (next: Send) => Send;

export const fromClient =
  (client: HttpClient): Send =>
  (request) =>
    client.send(request);

export const toClient = (send: Send): HttpClient => ({ send });

/** First middleware is the outermost, matching `decorate`. */
export function pipe(send: Send, ...middlewares: Middleware[]): Send {
  return middlewares.reduceRight<Send>((next, mw) => mw(next), send);
}

export const withHeader =
  (name: string, value: string): Middleware =>
  (next) =>
  (request) =>
    next({ ...request, headers: { ...request.headers, [name]: value } });

export const withLogging =
  (log: (line: string) => void): Middleware =>
  (next) =>
  async (request) => {
    log(`-> ${request.method} ${request.url}`);
    const response = await next(request);
    log(`<- ${response.status} ${request.method} ${request.url}`);
    return response;
  };
