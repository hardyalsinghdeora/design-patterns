/**
 * PROXY
 * A stand-in with the same interface as the real object, which controls access to it:
 * load it lazily, cache it, check permissions, or limit the call rate, without the client noticing.
 *
 * Example domain: a product catalogue backed by a database, wrapped in a stack of proxies.
 * Amounts are integers in minor units (paise). Clocks are injected; nothing here uses timers.
 */

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly stock: number;
}

/** The subject interface. Every proxy and the real catalogue implement exactly this. */
export interface ProductCatalog {
  getProduct(id: string): Promise<Product | undefined>;
  search(term: string): Promise<Product[]>;
  updatePrice(id: string, priceMinor: number): Promise<Product>;
}

export type Clock = () => number;

/** The real subject: expensive to create (connection pool, warm-up) and every call is a query. */
export class DatabaseCatalog implements ProductCatalog {
  private readonly rows = new Map<string, Product>();
  private queryCount = 0;

  constructor(rows: readonly Product[]) {
    for (const row of rows) this.rows.set(row.id, row);
  }

  get queries(): number {
    return this.queryCount;
  }

  async getProduct(id: string): Promise<Product | undefined> {
    this.queryCount += 1;
    return this.rows.get(id);
  }

  async search(term: string): Promise<Product[]> {
    this.queryCount += 1;
    const needle = term.toLowerCase();
    return [...this.rows.values()].filter((p) => p.name.toLowerCase().includes(needle));
  }

  async updatePrice(id: string, priceMinor: number): Promise<Product> {
    this.queryCount += 1;
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`No product ${id}`);
    if (!Number.isInteger(priceMinor) || priceMinor < 0) throw new Error(`Invalid price ${priceMinor}`);
    const updated = { ...existing, priceMinor };
    this.rows.set(id, updated);
    return updated;
  }
}

/** Virtual proxy: the real catalogue is created on first use, once, even under concurrent first calls. */
export class LazyLoadingProxy implements ProductCatalog {
  private loading: Promise<ProductCatalog> | undefined;

  constructor(private readonly load: () => Promise<ProductCatalog>) {}

  get loaded(): boolean {
    return this.loading !== undefined;
  }

  private subject(): Promise<ProductCatalog> {
    // Store the promise, not the result: two callers arriving before the load finishes share it.
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = undefined; // a failed load must not be cached forever
      throw error;
    });
    return this.loading;
  }

  async getProduct(id: string): Promise<Product | undefined> {
    return (await this.subject()).getProduct(id);
  }

  async search(term: string): Promise<Product[]> {
    return (await this.subject()).search(term);
  }

  async updatePrice(id: string, priceMinor: number): Promise<Product> {
    return (await this.subject()).updatePrice(id, priceMinor);
  }
}

/** Caching proxy: reads within the TTL never reach the subject; writes invalidate. */
export class CachingProxy implements ProductCatalog {
  private readonly entries = new Map<string, { readonly product: Product; readonly expiresAt: number }>();
  private hitCount = 0;
  private missCount = 0;

  constructor(private readonly inner: ProductCatalog, private readonly clock: Clock, private readonly ttlMs: number) {}

  get stats(): { readonly hits: number; readonly misses: number } {
    return { hits: this.hitCount, misses: this.missCount };
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const entry = this.entries.get(id);
    if (entry && this.clock() < entry.expiresAt) {
      this.hitCount += 1;
      return entry.product;
    }
    this.missCount += 1;
    const product = await this.inner.getProduct(id);
    // Only found products are cached; caching "not found" needs its own, shorter TTL.
    if (product) this.entries.set(id, { product, expiresAt: this.clock() + this.ttlMs });
    else this.entries.delete(id);
    return product;
  }

  /** Search results depend on every row, so they pass straight through. */
  search(term: string): Promise<Product[]> {
    return this.inner.search(term);
  }

  async updatePrice(id: string, priceMinor: number): Promise<Product> {
    const updated = await this.inner.updatePrice(id, priceMinor);
    this.entries.delete(id); // invalidate after the write succeeds, not before
    return updated;
  }
}

export type Role = 'viewer' | 'merchandiser' | 'admin';

export interface Principal {
  readonly userId: string;
  readonly roles: readonly Role[];
}

export class AccessDeniedError extends Error {
  constructor(readonly userId: string, readonly operation: string) {
    super(`${userId} may not ${operation}`);
    this.name = 'AccessDeniedError';
  }
}

/** Protection proxy: the subject stays free of auth code; the check happens before the call. */
export class AccessControlProxy implements ProductCatalog {
  private static readonly WRITERS: readonly Role[] = ['merchandiser', 'admin'];

  constructor(private readonly inner: ProductCatalog, private readonly principal: Principal) {}

  private require(allowed: readonly Role[], operation: string): void {
    if (!this.principal.roles.some((role) => allowed.includes(role))) {
      throw new AccessDeniedError(this.principal.userId, operation);
    }
  }

  async getProduct(id: string): Promise<Product | undefined> {
    this.require(['viewer', ...AccessControlProxy.WRITERS], 'read products');
    return this.inner.getProduct(id);
  }

  async search(term: string): Promise<Product[]> {
    this.require(['viewer', ...AccessControlProxy.WRITERS], 'search products');
    return this.inner.search(term);
  }

  async updatePrice(id: string, priceMinor: number): Promise<Product> {
    this.require(AccessControlProxy.WRITERS, 'change prices');
    return this.inner.updatePrice(id, priceMinor);
  }
}

export class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Rate limit exceeded, retry in ${retryAfterMs} ms`);
    this.name = 'RateLimitError';
  }
}

/** Rate-limiting proxy: a fixed window of `limit` calls per `windowMs`, shared by all methods. */
export class RateLimitingProxy implements ProductCatalog {
  private windowStart = Number.NEGATIVE_INFINITY;
  private used = 0;

  constructor(
    private readonly inner: ProductCatalog,
    private readonly options: { readonly limit: number; readonly windowMs: number },
    private readonly clock: Clock,
  ) {}

  private take(): void {
    const now = this.clock();
    const window = Math.floor(now / this.options.windowMs) * this.options.windowMs;
    if (window !== this.windowStart) {
      this.windowStart = window;
      this.used = 0;
    }
    if (this.used >= this.options.limit) throw new RateLimitError(window + this.options.windowMs - now);
    this.used += 1;
  }

  async getProduct(id: string): Promise<Product | undefined> {
    this.take();
    return this.inner.getProduct(id);
  }

  async search(term: string): Promise<Product[]> {
    this.take();
    return this.inner.search(term);
  }

  async updatePrice(id: string, priceMinor: number): Promise<Product> {
    this.take();
    return this.inner.updatePrice(id, priceMinor);
  }
}

/**
 * Order matters. Rate limiting is outermost so rejected calls cost nothing; access control
 * sits before the cache so a cached product is never served to someone who may not read it.
 */
export function buildCatalog(options: {
  readonly load: () => Promise<ProductCatalog>;
  readonly principal: Principal;
  readonly clock: Clock;
  readonly cacheTtlMs: number;
  readonly rateLimit: { readonly limit: number; readonly windowMs: number };
}): ProductCatalog {
  const lazy = new LazyLoadingProxy(options.load);
  const cached = new CachingProxy(lazy, options.clock, options.cacheTtlMs);
  const guarded = new AccessControlProxy(cached, options.principal);
  return new RateLimitingProxy(guarded, options.rateLimit, options.clock);
}

/* ------------------------------------------------------------------------ */
/* Idiomatic JavaScript: the built-in Proxy object. One handler covers every */
/* method and property, which suits cross-cutting concerns (logging, metrics, */
/* validation) where writing a class per interface would be boilerplate.     */
/* ------------------------------------------------------------------------ */

export interface CallRecord {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Logs every method call on any object, without knowing its interface. */
export function withCallLog<T extends object>(target: T, log: CallRecord[]): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        log.push({ method: String(prop), args });
        return Reflect.apply(value, obj, args); // `this` is the real target, so private state still works
      };
    },
  });
}

export interface ProductDraft {
  name: string;
  priceMinor: number;
  stock: number;
}

const isNonNegativeInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Validation on assignment: the `set` trap rejects bad writes at the moment they happen. */
export function validatedDraft(initial: ProductDraft): ProductDraft {
  return new Proxy<ProductDraft>(
    { ...initial },
    {
      set(obj, prop, value: unknown, receiver) {
        if ((prop === 'priceMinor' || prop === 'stock') && !isNonNegativeInteger(value)) {
          throw new TypeError(`${prop} must be a non-negative integer, got ${String(value)}`);
        }
        if (prop === 'name' && (typeof value !== 'string' || value.trim() === '')) {
          throw new TypeError('name must be a non-empty string');
        }
        if (!(prop in obj)) throw new TypeError(`Unknown field ${String(prop)}`);
        return Reflect.set(obj, prop, value, receiver);
      },
      deleteProperty(_obj, prop) {
        throw new TypeError(`Cannot delete ${String(prop)}`);
      },
    },
  );
}
