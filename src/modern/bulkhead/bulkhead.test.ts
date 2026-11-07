import { describe, expect, it } from 'vitest';
import {
  Bulkhead,
  BulkheadAbortedError,
  BulkheadFullError,
  BulkheadRegistry,
  CheckoutService,
  FakeInventoryApi,
  FakePaymentsApi,
  createLimiter,
  deferred,
} from './bulkhead';

/** Let queued promise continuations run. Microtasks only: no timers. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const reserve = (n: number) => ({ orderId: `ord_${n}`, sku: 'SKU-1', quantity: 1 });

function setup(inventory = { maxConcurrent: 3, maxQueue: 10 }, payments = { maxConcurrent: 2, maxQueue: 2 }) {
  const inventoryApi = new FakeInventoryApi();
  const paymentsApi = new FakePaymentsApi();
  const registry = new BulkheadRegistry({ inventory, payments });
  const checkout = new CheckoutService(inventoryApi, paymentsApi, registry);
  return { inventoryApi, paymentsApi, registry, checkout };
}

describe('Bulkhead', () => {
  it('never lets more than maxConcurrent calls reach the dependency', async () => {
    const { inventoryApi, registry, checkout } = setup();
    const calls = Array.from({ length: 10 }, (_, i) => checkout.reserveStock(reserve(i)));
    await flush();
    expect(inventoryApi.inFlight).toBe(3);
    expect(registry.get('inventory').metrics()).toMatchObject({ active: 3, queued: 7 });
    for (let i = 0; i < 10; i++) {
      inventoryApi.resolveOldest({ reservationId: `res_${i}` });
      await flush();
      expect(inventoryApi.inFlight).toBeLessThanOrEqual(3);
    }
    await Promise.all(calls);
    expect(inventoryApi.peakInFlight).toBe(3);
    expect(registry.get('inventory').metrics()).toMatchObject({ active: 0, queued: 0, completed: 10 });
  });

  it('rejects immediately with BulkheadFullError when the queue is full, without calling the dependency', async () => {
    const { inventoryApi, registry, checkout } = setup({ maxConcurrent: 2, maxQueue: 1 });
    void [checkout.reserveStock(reserve(1)), checkout.reserveStock(reserve(2)), checkout.reserveStock(reserve(3))];
    await expect(checkout.reserveStock(reserve(4))).rejects.toBeInstanceOf(BulkheadFullError);
    await flush();
    expect(inventoryApi.started).toBe(2);
    expect(registry.get('inventory').metrics()).toMatchObject({ active: 2, queued: 1, rejected: 1 });
  });

  it('isolates pools: a saturated inventory pool does not starve payments', async () => {
    const { inventoryApi, paymentsApi, registry, checkout } = setup({ maxConcurrent: 2, maxQueue: 2 });
    for (let i = 0; i < 4; i++) void checkout.reserveStock(reserve(i));
    await expect(checkout.reserveStock(reserve(5))).rejects.toBeInstanceOf(BulkheadFullError);

    const payment = checkout.charge({ orderId: 'ord_9', amountMinor: 49_900 });
    await flush();
    expect(paymentsApi.inFlight).toBe(1); // started at once, no waiting behind inventory
    paymentsApi.resolveOldest({ chargeId: 'ch_1' });
    expect(await payment).toEqual({ chargeId: 'ch_1' });
    expect(inventoryApi.inFlight).toBe(2);
    expect(registry.get('payments').metrics()).toMatchObject({ rejected: 0, completed: 1 });
  });

  it('releases the permit when a call throws, including synchronously', async () => {
    const bulkhead = new Bulkhead('inventory', { maxConcurrent: 1, maxQueue: 2 });
    const first = bulkhead.execute(() => Promise.reject(new Error('503 from inventory')));
    const second = bulkhead.execute(() => {
      throw new Error('bug before the await');
    });
    const third = bulkhead.execute(async () => 'reserved');
    await expect(first).rejects.toThrow('503');
    await expect(second).rejects.toThrow('bug');
    expect(await third).toBe('reserved');
    expect(bulkhead.metrics()).toMatchObject({ active: 0, queued: 0, failed: 2, completed: 1 });
  });

  it('serves the queue in FIFO order', async () => {
    const { inventoryApi, checkout } = setup({ maxConcurrent: 1, maxQueue: 5 });
    for (let i = 1; i <= 4; i++) void checkout.reserveStock(reserve(i));
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      await flush();
      order.push(inventoryApi.resolveOldest({ reservationId: `r${i}` }).orderId);
    }
    expect(order).toEqual(['ord_1', 'ord_2', 'ord_3', 'ord_4']);
  });

  it('lets a queued caller give up through an AbortSignal and frees its queue slot', async () => {
    const { inventoryApi, registry, checkout } = setup({ maxConcurrent: 1, maxQueue: 1 });
    void checkout.reserveStock(reserve(1));
    const controller = new AbortController();
    const waiting = checkout.reserveStock(reserve(2), controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(BulkheadAbortedError);
    void checkout.reserveStock(reserve(3)); // the freed slot is usable
    expect(registry.get('inventory').metrics()).toMatchObject({ queued: 1, rejected: 0, abandoned: 1 });
    inventoryApi.resolveOldest({ reservationId: 'r1' });
    await flush();
    expect(inventoryApi.pending.map((p) => p.request.orderId)).toEqual(['ord_3']);
  });

  it('works as a functional p-limit style limiter', async () => {
    const limit = createLimiter(2, 0);
    const gates = [deferred<number>(), deferred<number>()];
    const running = gates.map((g) => limit(() => g.promise));
    await expect(limit(async () => 3)).rejects.toBeInstanceOf(BulkheadFullError);
    gates.forEach((g, i) => g.resolve(i));
    expect(await Promise.all(running)).toEqual([0, 1]);
    expect(await limit(async () => 3)).toBe(3);
  });
});
