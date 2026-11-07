import { describe, expect, it } from 'vitest';
import {
  ConnectionLostError,
  ConnectionPool,
  FakeConnectionFactory,
  ManualClock,
  PoolClosedError,
  PoolTimeoutError,
  type DbConnection,
  type PoolOptions,
} from './object-pool';

const setup = (opts: Partial<Omit<PoolOptions, 'clock'>> = {}) => {
  const clock = new ManualClock(0);
  const factory = new FakeConnectionFactory();
  const pool = new ConnectionPool(factory, { min: 0, max: 2, maxWaitMs: 1_000, leakThresholdMs: 5_000, clock, ...opts });
  return { clock, factory, pool };
};

/** Let pending promise callbacks run. No timers involved. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('ConnectionPool', () => {
  it('warms up to min and reuses connections instead of opening new ones', async () => {
    const { pool, factory } = setup({ min: 1 });
    await pool.warmUp();
    expect(factory.created).toBe(1);
    const first = await pool.acquire();
    pool.release(first);
    const second = await pool.acquire();
    expect(second).toBe(first);
    expect(factory.created).toBe(1);
  });

  it('blocks at max size until a connection is released, then hands that one over', async () => {
    const { pool, factory } = setup({ max: 2 });
    const c1 = await pool.acquire();
    await pool.acquire();
    let third: DbConnection | undefined;
    void pool.acquire().then((c) => (third = c));
    await flush();
    expect(third).toBeUndefined();
    expect(pool.stats()).toMatchObject({ inUse: 2, waiting: 1, total: 2 });
    pool.release(c1);
    await flush();
    expect(third).toBe(c1);
    expect(factory.created).toBe(2);
  });

  it('serves waiters in FIFO order', async () => {
    const { pool } = setup({ max: 1 });
    const conn = await pool.acquire('a');
    const order: string[] = [];
    const b = pool.acquire('b').then((c) => (order.push('b'), c));
    const c = pool.acquire('c').then((x) => (order.push('c'), x));
    pool.release(conn);
    pool.release(await b);
    await c;
    expect(order).toEqual(['b', 'c']);
  });

  it('rejects a waiter that exceeds maxWaitMs, measured on the injected clock', async () => {
    const { pool, clock } = setup({ max: 1 });
    await pool.acquire();
    const waiting = pool.acquire('report');
    clock.advance(999);
    expect(pool.sweep().timedOut).toBe(0);
    clock.advance(1);
    expect(pool.sweep().timedOut).toBe(1);
    await expect(waiting).rejects.toThrow(PoolTimeoutError);
    expect(pool.stats().waiting).toBe(0);
  });

  it('destroys a broken connection on release and opens a replacement for the waiter', async () => {
    const { pool, factory } = setup({ max: 1 });
    const broken = await pool.acquire();
    const next = pool.acquire();
    broken.breakConnection();
    pool.release(broken);
    const fresh = await next;
    expect(fresh).not.toBe(broken);
    expect(broken.isClosed).toBe(true);
    expect(factory.created).toBe(2);
    expect(pool.stats().destroyed).toBe(1);
  });

  it('validates idle connections on acquire and never lends out a dead one', async () => {
    const { pool } = setup({ min: 1 });
    await pool.warmUp();
    const conn = await pool.acquire();
    pool.release(conn);
    conn.breakConnection(); // the server dropped it while it sat idle
    const lent = await pool.acquire();
    expect(lent).not.toBe(conn);
    expect(await lent.query('SELECT 1')).toBe('conn-2 ran: SELECT 1');
  });

  it('withConnection always releases, even when the callback throws', async () => {
    const { pool } = setup();
    await expect(
      pool.withConnection(async (c) => {
        await c.query('UPDATE invoices SET status = $1');
        throw new Error('constraint violation');
      }),
    ).rejects.toThrow('constraint violation');
    expect(pool.stats()).toMatchObject({ inUse: 0, idle: 1 });

    await expect(
      pool.withConnection(async (c) => {
        c.breakConnection();
        return c.query('SELECT 1');
      }),
    ).rejects.toThrow(ConnectionLostError);
    expect(pool.stats()).toMatchObject({ inUse: 0, idle: 0, destroyed: 1 });
  });

  it('reports connections held longer than the leak threshold, with their holder', async () => {
    const { pool, clock } = setup({ leakThresholdMs: 5_000 });
    await pool.acquire('nightly-report');
    clock.advance(2_000);
    const quick = await pool.acquire('checkout');
    pool.release(quick);
    clock.advance(4_000);
    expect(pool.sweep().leaks).toEqual([{ connectionId: 'conn-1', holder: 'nightly-report', heldMs: 6_000 }]);
  });

  it('rejects double release, and close() rejects everyone still waiting', async () => {
    const { pool } = setup({ max: 1 });
    const conn = await pool.acquire();
    const waiting = pool.acquire();
    pool.close();
    await expect(waiting).rejects.toThrow(PoolClosedError);
    pool.release(conn);
    expect(conn.isClosed).toBe(true);
    expect(() => pool.release(conn)).toThrow(/double release/);
  });
});
