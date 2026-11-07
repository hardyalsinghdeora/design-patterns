import { describe, expect, it } from 'vitest';
import { InMemoryDatabase, Order, Payment, PaymentService, UnitOfWork, type WriteOp, orderMapper, paymentMapper } from './unit-of-work';

const seeded = (failWhen?: (w: WriteOp) => boolean) =>
  new InMemoryDatabase(failWhen)
    .seed('orders', [orderMapper.toRow(new Order('ord_1', 'cus_1', 50_000)), orderMapper.toRow(new Order('ord_2', 'cus_2', 20_000, 'paid'))])
    .seed('payments', [paymentMapper.toRow(new Payment('pay_old', 'ord_2', 20_000))]);

const ids = () => {
  let n = 0;
  return () => `pay_${++n}`;
};

describe('UnitOfWork', () => {
  it('writes nothing before commit, only tracks', async () => {
    const db = seeded();
    const uow = new UnitOfWork(db);
    (await uow.orders.get('ord_1')).markPaid();
    uow.payments.add(new Payment('pay_1', 'ord_1', 50_000));
    expect(uow.pendingChanges()).toEqual({ inserts: ['payments/pay_1'], updates: ['orders/ord_1'], deletes: [] });
    expect(db.log).toEqual([]);
    expect(db.rows('orders').find((r) => r.id === 'ord_1')?.status).toBe('pending');
  });

  it('commits every new, dirty and removed aggregate exactly once in one transaction', async () => {
    const db = seeded();
    const uow = new UnitOfWork(db);
    const order = await uow.orders.get('ord_1');
    order.markPaid();
    await uow.orders.get('ord_2'); // loaded, never changed: clean
    uow.payments.add(new Payment('pay_1', 'ord_1', 50_000));
    uow.payments.remove(await uow.payments.get('pay_old'));
    await uow.commit();
    expect(db.log).toEqual(['BEGIN', 'INSERT payments/pay_1', 'UPDATE orders/ord_1', 'DELETE payments/pay_old', 'COMMIT']);
    expect(db.rows('payments').map((r) => r.id)).toEqual(['pay_1']);
  });

  it('orders inserts parents first and deletes children first', async () => {
    const db = seeded();
    const uow = new UnitOfWork(db);
    uow.payments.add(new Payment('pay_9', 'ord_9', 1_000)); // added before its order
    uow.orders.add(new Order('ord_9', 'cus_9', 1_000));
    uow.orders.remove(await uow.orders.get('ord_2'));
    uow.payments.remove(await uow.payments.get('pay_old'));
    await uow.commit();
    expect(db.log.slice(1, -1)).toEqual(['INSERT orders/ord_9', 'INSERT payments/pay_9', 'DELETE payments/pay_old', 'DELETE orders/ord_2']);
  });

  it('rolls back and leaves the store untouched when a write fails mid-commit', async () => {
    const db = seeded((w) => w.op === 'update' && w.table === 'orders');
    const before = { orders: db.rows('orders'), payments: db.rows('payments') };
    const uow = new UnitOfWork(db);
    (await uow.orders.get('ord_1')).markPaid();
    uow.payments.add(new Payment('pay_1', 'ord_1', 50_000));
    await expect(uow.commit()).rejects.toThrow(/Simulated failure on update orders\/ord_1/);
    expect(db.log).toEqual(['BEGIN', 'INSERT payments/pay_1', 'ROLLBACK']);
    expect({ orders: db.rows('orders'), payments: db.rows('payments') }).toEqual(before);
  });

  it('identity map: one id gives one object and one read per unit', async () => {
    const db = seeded();
    const uow = new UnitOfWork(db);
    const a = await uow.orders.get('ord_1');
    const b = await uow.orders.get('ord_1');
    expect(b).toBe(a);
    expect(db.reads).toEqual(['orders/ord_1']);
    const added = new Payment('pay_new', 'ord_1', 1);
    uow.payments.add(added);
    expect(await uow.payments.find('pay_new')).toBe(added);
    expect(await new UnitOfWork(db).orders.get('ord_1')).not.toBe(a); // a new unit has its own map
  });

  it('a read-only unit opens no transaction, and add-then-remove writes nothing', async () => {
    const db = seeded();
    const uow = new UnitOfWork(db);
    await uow.orders.get('ord_1');
    const draft = new Order('ord_tmp', 'cus_1', 100);
    uow.orders.add(draft);
    uow.orders.remove(draft);
    expect(await uow.commit()).toEqual({ inserts: [], updates: [], deletes: [] });
    expect(db.log).toEqual([]);
    await expect(uow.orders.get('ord_1')).rejects.toThrow(/closed/);
  });
});

describe('PaymentService with withUnitOfWork', () => {
  it('captures: order and payment change together', async () => {
    const db = seeded();
    const payment = await new PaymentService(db, ids()).capture('ord_1');
    expect(payment.id).toBe('pay_1');
    expect(db.log).toEqual(['BEGIN', 'INSERT payments/pay_1', 'UPDATE orders/ord_1', 'COMMIT']);
  });

  it('a domain error discards the unit; a failed second write undoes the first', async () => {
    const db = seeded((w) => w.op === 'update' && w.table === 'payments');
    const service = new PaymentService(db, ids());
    await expect(service.capture('ord_2')).rejects.toThrow(/is paid/);
    expect(db.log).toEqual([]);
    await expect(service.refund('pay_old')).rejects.toThrow(/Simulated failure/);
    expect(db.log).toEqual(['BEGIN', 'UPDATE orders/ord_2', 'ROLLBACK']);
    expect(db.rows('orders').find((r) => r.id === 'ord_2')?.status).toBe('paid');
  });
});
