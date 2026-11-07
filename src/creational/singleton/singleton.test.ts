import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ConfigService,
  ConnectionPool,
  ConnectionPoolRegistry,
  LegacyOrderRepository,
  OrderRepository,
  config,
  type PoolProvider,
} from './singleton';

beforeEach(() => ConnectionPoolRegistry.resetForTests());
afterEach(() => config.clearOverrides());

describe('ConnectionPoolRegistry (classic lazy singleton)', () => {
  it('builds the instance lazily, once, and returns it to every caller', () => {
    const before = ConnectionPoolRegistry.instancesCreated;
    const fromCheckout = ConnectionPoolRegistry.getInstance();
    const fromReports = ConnectionPoolRegistry.getInstance();

    expect(fromReports).toBe(fromCheckout);
    expect(ConnectionPoolRegistry.instancesCreated - before).toBe(1);
    // The private constructor is what stops a second instance at compile time.
    expectTypeOf<typeof ConnectionPoolRegistry>().not.toExtend<new () => ConnectionPoolRegistry>();
  });

  it('shares state: every caller sees the same pools and the same connection budget', () => {
    const checkoutPool = ConnectionPoolRegistry.getInstance().pool('orders', { maxConnections: 2 });
    const reportsPool = ConnectionPoolRegistry.getInstance().pool('orders');

    expect(reportsPool).toBe(checkoutPool);
    checkoutPool.acquire();
    reportsPool.acquire();
    expect(reportsPool.inUse).toBe(2);
    expect(() => ConnectionPoolRegistry.getInstance().pool('orders').acquire()).toThrow(/exhausted/);
  });

  it('fails loudly when a later caller asks for different options instead of ignoring them', () => {
    ConnectionPoolRegistry.getInstance().pool('orders', { maxConnections: 5 });
    expect(() => ConnectionPoolRegistry.getInstance().pool('orders', { maxConnections: 50 })).toThrow(
      /already exists with maxConnections=5/,
    );
  });

  it('resetForTests() isolates tests: leaked connections do not reach the next test', () => {
    const leaky = ConnectionPoolRegistry.getInstance().pool('orders', { maxConnections: 1 });
    leaky.acquire(); // a test that forgets to release

    ConnectionPoolRegistry.resetForTests();
    const fresh = ConnectionPoolRegistry.getInstance().pool('orders', { maxConnections: 1 });

    expect(fresh).not.toBe(leaky);
    expect(fresh.acquire().id).toBe('orders#1');
    expect(() => leaky.acquire()).toThrow(/closed/);
  });
});

describe('module-scope singleton (export const config)', () => {
  it('gives every importer the same object, so an override is visible everywhere', async () => {
    const secondImport = await import('./singleton');

    expect(secondImport.config).toBe(config);
    config.override('FEATURE_FAST_CHECKOUT', 'on');
    expect(secondImport.config.get('FEATURE_FAST_CHECKOUT')).toBe('on');
  });

  it('is reset by re-evaluating the module: vi.resetModules() plus a fresh import', async () => {
    config.override('FEATURE_INVOICE_V2', 'on');
    vi.resetModules();
    const fresh = await import('./singleton');

    expect(fresh.config).not.toBe(config);
    expect(fresh.config.get('FEATURE_INVOICE_V2')).toBeUndefined();
  });
});

describe('consumers: getInstance() vs dependency injection', () => {
  it('a getInstance() consumer can only be steered by mutating process-wide state', () => {
    config.override('ORDERS_DB_POOL', 'orders-legacy');

    expect(new LegacyOrderRepository().findById('ord_7').servedBy).toBe('orders-legacy#1');
    // The side effect outlives the call: the global registry now owns a pool this test created.
    expect(ConnectionPoolRegistry.getInstance().names()).toEqual(['orders-legacy']);
  });

  it('an injected consumer takes fresh instances and never touches the globals', () => {
    const before = ConnectionPoolRegistry.instancesCreated;
    const pools: PoolProvider = { pool: (name) => new ConnectionPool(name, { maxConnections: 1 }) };
    const repo = new OrderRepository(new ConfigService({ ORDERS_DB_POOL: 'orders-replica' }), pools);

    expect(repo.findById('ord_42')).toEqual({ orderId: 'ord_42', servedBy: 'orders-replica#1' });
    expect(ConnectionPoolRegistry.instancesCreated).toBe(before);
  });

  it('production wiring injects the shared instances, so both styles see the same pool', () => {
    const repo = new OrderRepository(config, ConnectionPoolRegistry.getInstance());
    repo.findById('ord_1');
    new LegacyOrderRepository().findById('ord_2');

    expect(ConnectionPoolRegistry.getInstance().names()).toEqual(['orders']);
  });
});
