import { describe, expect, it } from 'vitest';
import {
  AnonymousCustomer,
  CheckoutService,
  CustomerDirectory,
  InMemoryMetrics,
  MapCache,
  MemoryLogger,
  NoopMetrics,
  NullCache,
  NullLogger,
  PriceCatalog,
  PricingService,
  PricingServiceBefore,
  RegisteredCustomer,
  UnknownSkuError,
  noopLogger,
  wiringReport,
  type Permission,
} from './null-object';

const catalog = () => new PriceCatalog({ 'sku-kbd': 2_499_00, 'sku-mouse': 999_00 });
const gold = new RegisteredCustomer('cus_1', 'Asha', ['orders:create', 'credit:use'], 'gold');

describe('services work with null objects and need no null checks', () => {
  it('prices an order with no logger, metrics or cache wired at all', () => {
    const quote = new PricingService(catalog()).quote(gold, 'sku-kbd', 2);
    expect(quote).toMatchObject({ unitPriceMinor: 2_499_00, discountMinor: 249_90, totalMinor: 4_748_10 });
  });

  it('gives the same business result as real collaborators; only the side effects differ', () => {
    const logger = new MemoryLogger();
    const metrics = new InMemoryMetrics();
    const real = new PricingService(catalog(), logger, metrics, new MapCache<number>());
    const nulls = new PricingService(catalog(), NullLogger.instance, NoopMetrics.instance, new NullCache<number>());
    expect(nulls.quote(gold, 'sku-mouse', 3)).toEqual(real.quote(gold, 'sku-mouse', 3));
    expect(logger.lines).toHaveLength(1);
    expect(metrics.counter('price.cache_miss')).toBe(1);
  });

  it('matches the old null-checking service when everything is absent', () => {
    const before = new PricingServiceBefore(catalog()).quote(null, 'sku-kbd', 1);
    const after = new PricingService(catalog()).quote(AnonymousCustomer.instance, 'sku-kbd', 1);
    expect(after).toEqual(before);
  });

  it('a NullCache behaves exactly like having no cache: every quote hits the catalog', () => {
    const uncached = catalog();
    const cached = catalog();
    const a = new PricingService(uncached, undefined, undefined, new NullCache<number>());
    const b = new PricingService(cached, undefined, undefined, new MapCache<number>());
    for (let i = 0; i < 3; i++) {
      a.quote(gold, 'sku-kbd', 1);
      b.quote(gold, 'sku-kbd', 1);
    }
    expect(uncached.lookups).toBe(3);
    expect(cached.lookups).toBe(1);
  });
});

describe('AnonymousCustomer (the null customer)', () => {
  it('has no permissions and no discount, and is resolved instead of null', () => {
    const all: Permission[] = ['orders:create', 'orders:view', 'credit:use', 'refunds:issue'];
    const guest = new CustomerDirectory(new Map([['tok_1', gold]])).resolve(undefined);
    expect(guest).toBe(AnonymousCustomer.instance);
    expect(all.some((p) => guest.can(p))).toBe(false);
    expect(guest.discountBasisPoints()).toBe(0);
    expect(new CustomerDirectory(new Map()).resolve('expired')).toBe(AnonymousCustomer.instance);
  });

  it('can check out at list price but is refused store credit, through the normal code path', () => {
    const logger = new MemoryLogger();
    const checkout = new CheckoutService(new PricingService(catalog()), logger);
    const guest = AnonymousCustomer.instance;
    expect(checkout.checkout(guest, 'sku-mouse', 1)).toMatchObject({ ok: true, quote: { totalMinor: 999_00 } });
    expect(checkout.checkout(guest, 'sku-mouse', 1, true)).toMatchObject({ ok: false });
    expect(checkout.checkout(gold, 'sku-mouse', 1, true).ok).toBe(true);
    expect(logger.lines).toEqual(['WARN store credit refused {"customer":"anonymous"}']);
  });
});

describe('where null objects stop', () => {
  it('a missing price is still an error, not a silent zero', () => {
    expect(() => new PricingService(catalog()).quote(gold, 'sku-ghost', 1)).toThrow(UnknownSkuError);
  });

  it('the composition root can report which collaborators are null objects', () => {
    expect(wiringReport({ logger: noopLogger, metrics: NoopMetrics.instance, cache: new MapCache<number>() })).toEqual([
      'logger: null object (logs discarded)',
      'metrics: null object (no metrics emitted)',
    ]);
    expect(wiringReport({ logger: new MemoryLogger(), metrics: new InMemoryMetrics(), cache: new MapCache<number>() })).toEqual([]);
  });
});
