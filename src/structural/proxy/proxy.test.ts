import { describe, expect, it } from 'vitest';
import {
  AccessControlProxy,
  AccessDeniedError,
  CachingProxy,
  DatabaseCatalog,
  LazyLoadingProxy,
  RateLimitError,
  RateLimitingProxy,
  buildCatalog,
  validatedDraft,
  withCallLog,
  type CallRecord,
  type Product,
  type ProductCatalog,
} from './proxy';

const ROWS: Product[] = [
  { id: 'p1', name: 'Assam Tea 250g', priceMinor: 34_900, stock: 12 },
  { id: 'p2', name: 'Green Tea 100g', priceMinor: 24_900, stock: 0 },
  { id: 'p3', name: 'Steel Kettle', priceMinor: 1_49_900, stock: 3 },
];

const manualClock = (start = 0) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
};

/** Client code: it only knows the interface, so it works the same with or without proxies. */
const priceOf = async (catalog: ProductCatalog, id: string) => (await catalog.getProduct(id))?.priceMinor;

describe('LazyLoadingProxy', () => {
  it('loads the real catalogue on first use, exactly once, even for concurrent first calls', async () => {
    let loads = 0;
    const proxy = new LazyLoadingProxy(async () => {
      loads += 1;
      return new DatabaseCatalog(ROWS);
    });
    expect(proxy.loaded).toBe(false);
    expect(loads).toBe(0);

    const [a, b, c] = await Promise.all([proxy.getProduct('p1'), proxy.search('tea'), priceOf(proxy, 'p3')]);
    expect(a?.name).toBe('Assam Tea 250g');
    expect(b).toHaveLength(2);
    expect(c).toBe(1_49_900);
    expect(loads).toBe(1);
  });

  it('retries the load after a failure instead of caching the error', async () => {
    let attempts = 0;
    const proxy = new LazyLoadingProxy(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection refused');
      return new DatabaseCatalog(ROWS);
    });
    await expect(proxy.getProduct('p1')).rejects.toThrow('connection refused');
    await expect(priceOf(proxy, 'p1')).resolves.toBe(34_900);
    expect(attempts).toBe(2);
  });
});

describe('CachingProxy', () => {
  it('serves repeat reads from cache until the TTL expires', async () => {
    const db = new DatabaseCatalog(ROWS);
    const clock = manualClock();
    const cache = new CachingProxy(db, clock.now, 60_000);

    await cache.getProduct('p1');
    clock.advance(59_999);
    await cache.getProduct('p1');
    expect(db.queries).toBe(1);

    clock.advance(1);
    await cache.getProduct('p1');
    expect(db.queries).toBe(2);
    expect(cache.stats).toEqual({ hits: 1, misses: 2 });
  });

  it('invalidates an entry when the price is written through it', async () => {
    const db = new DatabaseCatalog(ROWS);
    const cache = new CachingProxy(db, manualClock().now, 60_000);
    expect(await priceOf(cache, 'p1')).toBe(34_900);
    await cache.updatePrice('p1', 29_900);
    expect(await priceOf(cache, 'p1')).toBe(29_900);
  });
});

describe('AccessControlProxy and RateLimitingProxy', () => {
  it('lets a viewer read but not write, and the subject never sees the denied call', async () => {
    const db = new DatabaseCatalog(ROWS);
    const asViewer = new AccessControlProxy(db, { userId: 'u_support', roles: ['viewer'] });
    expect(await priceOf(asViewer, 'p2')).toBe(24_900);

    await expect(asViewer.updatePrice('p2', 1)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(db.queries).toBe(1);
    const asMerch = new AccessControlProxy(db, { userId: 'u_merch', roles: ['merchandiser'] });
    await expect(asMerch.updatePrice('p2', 19_900)).resolves.toMatchObject({ priceMinor: 19_900 });
  });

  it('rejects calls over the limit with a retry hint, and allows them again in the next window', async () => {
    const db = new DatabaseCatalog(ROWS);
    const clock = manualClock(10_000);
    const limited = new RateLimitingProxy(db, { limit: 3, windowMs: 1_000 }, clock.now);

    await limited.getProduct('p1');
    await limited.search('tea');
    clock.advance(400);
    await limited.getProduct('p2');
    const rejected = limited.getProduct('p3');
    await expect(rejected).rejects.toBeInstanceOf(RateLimitError);
    await expect(rejected).rejects.toMatchObject({ retryAfterMs: 600 });
    expect(db.queries).toBe(3);

    clock.advance(600);
    await expect(priceOf(limited, 'p3')).resolves.toBe(1_49_900);
  });

  it('stacks transparently: the client cannot tell the proxied catalogue from the real one', async () => {
    const clock = manualClock();
    const db = new DatabaseCatalog(ROWS);
    const catalog = buildCatalog({
      load: async () => db,
      principal: { userId: 'u_web', roles: ['viewer'] },
      clock: clock.now,
      cacheTtlMs: 30_000,
      rateLimit: { limit: 100, windowMs: 1_000 },
    });
    for (let i = 0; i < 10; i++) expect(await priceOf(catalog, 'p1')).toBe(await priceOf(new DatabaseCatalog(ROWS), 'p1'));
    expect(db.queries).toBe(1); // nine of ten reads were cache hits
    await expect(catalog.updatePrice('p1', 1)).rejects.toThrow(/may not change prices/);
  });
});

describe('JavaScript Proxy object', () => {
  it('logs every method call through a get trap without a class per interface', async () => {
    const log: CallRecord[] = [];
    const db = new DatabaseCatalog(ROWS);
    const logged = withCallLog(db, log);
    await logged.getProduct('p1');
    await logged.search('kettle');
    expect(logged.queries).toBe(2); // plain properties pass through untouched
    expect(log).toEqual([
      { method: 'getProduct', args: ['p1'] },
      { method: 'search', args: ['kettle'] },
    ]);
  });

  it('validates writes through a set trap', () => {
    const draft = validatedDraft({ name: 'Clay Cup', priceMinor: 9_900, stock: 10 });
    draft.priceMinor = 8_900;
    expect(draft.priceMinor).toBe(8_900);
    expect(() => {
      draft.priceMinor = 89.5;
    }).toThrow(/non-negative integer/);
    expect(() => {
      draft.name = ' ';
    }).toThrow(/non-empty/);
    expect(() => Reflect.deleteProperty(draft, 'stock')).toThrow(/Cannot delete/);
    expect(() => Object.assign(draft, { colour: 'red' })).toThrow(/Unknown field/);
  });
});
