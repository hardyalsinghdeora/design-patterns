import { describe, expect, it } from 'vitest';
import {
  type Execute,
  InMemoryOrderRepository,
  Order,
  type OrderRow,
  OrderService,
  type SqlRow,
  type SqlValue,
  SqlOrderRepository,
  allOf,
  byCustomer,
  orderToRow,
  withStatus,
} from './repository';

const HOUR = 3_600_000;

function fixedClock(start = 1_000 * HOUR) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function sequentialIds(prefix = 'ord_') {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function stubDb(rowsFor: (sql: string, params: readonly SqlValue[]) => SqlRow[] = () => []) {
  const calls: { sql: string; params: readonly SqlValue[] }[] = [];
  const execute: Execute = async (sql, params) => {
    calls.push({ sql, params });
    return rowsFor(sql, params);
  };
  return { calls, execute };
}

const COLS = 'id, customer_id, status, total_minor, created_at_ms';

describe('OrderService against the in-memory repository', () => {
  it('places and pays an order with no database involved', async () => {
    const clock = fixedClock();
    const service = new OrderService(new InMemoryOrderRepository(), clock.now, sequentialIds());
    const order = await service.place('cus_1', 49_900);
    expect(order).toMatchObject({ id: 'ord_1', status: 'pending', createdAtMs: clock.now() });
    expect((await service.pay('ord_1')).status).toBe('paid');
    await expect(service.pay('ord_1')).rejects.toThrow(/is paid, cannot be paid/);
    await expect(service.pay('ord_404')).rejects.toThrow(/not found/);
  });

  it('finds stale pending orders by specification and cancels only those', async () => {
    const clock = fixedClock();
    const service = new OrderService(new InMemoryOrderRepository(), clock.now, sequentialIds());
    await service.place('cus_1', 10_000); // ord_1: will go stale
    await service.place('cus_2', 20_000); // ord_2: paid, never stale
    await service.pay('ord_2');
    clock.advance(25 * HOUR);
    await service.place('cus_1', 30_000); // ord_3: fresh
    expect(await service.cancelStalePending(24 * HOUR)).toEqual(['ord_1']);
    expect(await service.lifetimeSpendMinor('cus_2')).toBe(20_000);
    expect(await service.lifetimeSpendMinor('cus_1')).toBe(0);
  });

  it('preserves identity and does not leak unsaved changes into the store', async () => {
    const store = new Map<string, OrderRow>();
    const repoA = new InMemoryOrderRepository(store);
    await repoA.save(new Order('ord_1', 'cus_1', 'pending', 10_000, 0));
    const first = await repoA.findById('ord_1');
    const [viaSpec] = await repoA.findBy(byCustomer('cus_1'));
    expect(viaSpec).toBe(first); // one id, one object
    first?.markPaid(); // not saved yet
    expect((await new InMemoryOrderRepository(store).findById('ord_1'))?.status).toBe('pending');
    if (first) await repoA.save(first);
    expect((await new InMemoryOrderRepository(store).findById('ord_1'))?.status).toBe('paid');
  });
});

describe('SqlOrderRepository emits SQL through the injected executor', () => {
  const row = (id: string, status: string): SqlRow => ({ id, customer_id: 'cus_1', status, total_minor: 10_000, created_at_ms: 5 });

  it('translates a specification into a parameterised WHERE clause', async () => {
    const db = stubDb(() => [row('ord_1', 'paid')]);
    const found = await new SqlOrderRepository(db.execute).findBy(allOf(byCustomer('cus_1'), withStatus('paid')));
    expect(db.calls).toEqual([
      { sql: `SELECT ${COLS} FROM orders WHERE customer_id = $1 AND status = $2 ORDER BY created_at_ms, id`, params: ['cus_1', 'paid'] },
    ]);
    expect(found.map((o) => o.id)).toEqual(['ord_1']);
  });

  it('saves with an upsert and deletes by id', async () => {
    const db = stubDb();
    const repo = new SqlOrderRepository(db.execute);
    const order = new Order('ord_9', 'cus_1', 'pending', 25_000, 42);
    await repo.save(order);
    await repo.delete('ord_9');
    expect(db.calls).toEqual([
      {
        sql:
          `INSERT INTO orders (${COLS}) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET ` +
          'customer_id = EXCLUDED.customer_id, status = EXCLUDED.status, total_minor = EXCLUDED.total_minor, created_at_ms = EXCLUDED.created_at_ms',
        params: ['ord_9', 'cus_1', 'pending', 25_000, 42],
      },
      { sql: 'DELETE FROM orders WHERE id = $1', params: ['ord_9'] },
    ]);
  });

  it('returns the same object for the same id and skips the second round trip', async () => {
    const db = stubDb((sql) => (sql.includes('WHERE id') ? [row('ord_1', 'pending')] : [row('ord_1', 'pending'), row('ord_2', 'paid')]));
    const repo = new SqlOrderRepository(db.execute);
    const a = await repo.findById('ord_1');
    const b = await repo.findById('ord_1');
    const list = await repo.findBy(byCustomer('cus_1'));
    expect(b).toBe(a);
    expect(list[0]).toBe(a);
    expect(db.calls.map((c) => c.sql.split(' WHERE ')[1])).toEqual(['id = $1', 'customer_id = $1 ORDER BY created_at_ms, id']);
  });

  it('runs the same service unchanged when the SQL repository is swapped in', async () => {
    const db = stubDb((_sql, params) => (params[0] === 'ord_1' && params.length === 1 ? [row('ord_1', 'pending')] : []));
    const service = new OrderService(new SqlOrderRepository(db.execute), () => 0, sequentialIds());
    await service.pay('ord_1');
    expect(db.calls.map((c) => c.sql.split(' ')[0])).toEqual(['SELECT', 'INSERT']);
    expect(db.calls[1]?.params).toEqual(Object.values(orderToRow(new Order('ord_1', 'cus_1', 'paid', 10_000, 5))));
  });

  it('rejects malformed rows instead of building a half-valid Order', async () => {
    const db = stubDb(() => [{ id: 'ord_1', customer_id: 'cus_1', status: 'lost', total_minor: 1, created_at_ms: 0 }]);
    await expect(new SqlOrderRepository(db.execute).findById('ord_1')).rejects.toThrow(/Malformed orders row/);
  });
});
