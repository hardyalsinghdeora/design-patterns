import { describe, expect, it } from 'vitest';
import {
  BrokerUnavailableError,
  DualWriteOrderService,
  FakeBroker,
  OrderService,
  OutboxRelay,
  ShippingConsumer,
  UniqueViolationError,
  createOrderDatabase,
  createShippingDatabase,
  type RelayOptions,
} from './transactional-outbox';

function setup(relayOptions: Partial<RelayOptions> = {}) {
  let t = 1_000;
  const clock = { now: () => t++ };
  const orders = createOrderDatabase();
  const broker = new FakeBroker();
  const service = new OrderService(orders, clock);
  const relay = new OutboxRelay(orders, broker, clock, { topic: 'orders', pageSize: 2, maxPerPoll: 100, ...relayOptions });
  const shippingDb = createShippingDatabase();
  const consumer = new ShippingConsumer(shippingDb, clock);
  broker.subscribe('orders', consumer.handle);
  const place = (n: number) => service.placeOrder({ orderId: `ord_${n}`, customerId: 'cus_1', totalMinor: n * 10_000 });
  const pending = () => orders.snapshot('outbox').filter((e) => e.publishedAt === null).map((e) => e.id);
  return { orders, broker, service, relay, shippingDb, consumer, place, pending };
}

describe('transactional outbox', () => {
  it('commits the order and its event together, or neither', async () => {
    const { orders, place } = setup();
    await place(1);
    expect(orders.snapshot('orders')).toHaveLength(1);
    expect(orders.snapshot('outbox')).toMatchObject([{ aggregateId: 'ord_1', type: 'OrderPlaced', publishedAt: null }]);

    orders.failNextCommit(new Error('connection lost during COMMIT'));
    await expect(place(2)).rejects.toThrow('COMMIT');
    await expect(place(1)).rejects.toBeInstanceOf(UniqueViolationError); // order insert fails, event insert never lands
    expect(orders.snapshot('orders').map((o) => o.id)).toEqual(['ord_1']);
    expect(orders.snapshot('outbox')).toHaveLength(1);
  });

  it('relay publishes pending events in order, marks them sent, and a second poll is a no-op', async () => {
    const { broker, relay, place, pending } = setup();
    for (let n = 1; n <= 5; n++) await place(n);
    expect(await relay.pollOnce()).toEqual({ published: 5 }); // pageSize 2: three pages
    expect(broker.published.map((p) => p.message.key)).toEqual(['ord_1', 'ord_2', 'ord_3', 'ord_4', 'ord_5']);
    expect(pending()).toEqual([]);
    expect(await relay.pollOnce()).toEqual({ published: 0 });
  });

  it('broker down: events stay pending and go out on the next poll', async () => {
    const { orders, broker, relay, place, pending } = setup();
    await place(1);
    await place(2);
    broker.available = false;
    expect(await relay.pollOnce()).toEqual({ published: 0, blockedAt: 'evt_000001' });
    expect(pending()).toEqual(['evt_000001', 'evt_000002']);
    expect(orders.snapshot('outbox')[0]).toMatchObject({ attempts: 1, lastError: 'broker unavailable' });

    broker.available = true;
    expect(await relay.pollOnce()).toEqual({ published: 2 });
    expect(pending()).toEqual([]);
  });

  it('a mid-batch failure stops the poll so later events never overtake earlier ones', async () => {
    let first = true;
    const ctx = setup({
      afterPublish: () => {
        if (first) ctx.broker.available = false; // the broker goes down right after event 1
        first = false;
      },
    });
    for (let n = 1; n <= 3; n++) await ctx.place(n);
    expect(await ctx.relay.pollOnce()).toEqual({ published: 1, blockedAt: 'evt_000002' });
    expect(ctx.pending()).toEqual(['evt_000002', 'evt_000003']); // evt 3 did not jump the queue

    ctx.broker.available = true;
    expect(await ctx.relay.pollOnce()).toEqual({ published: 2 });
    expect(ctx.broker.published.map((p) => p.message.key)).toEqual(['ord_1', 'ord_2', 'ord_3']);
  });

  it('relay crash after publish but before marking: the duplicate is delivered and the inbox absorbs it', async () => {
    let crash = true;
    const { broker, relay, shippingDb, consumer, place, pending } = setup({
      afterPublish: () => {
        if (crash) {
          crash = false;
          throw new Error('relay process killed');
        }
      },
    });
    await place(1);
    await expect(relay.pollOnce()).rejects.toThrow('killed');
    expect(pending()).toEqual(['evt_000001']); // published, but the mark never happened

    expect(await relay.pollOnce()).toEqual({ published: 1 }); // restarted relay sends it again
    expect(broker.published.map((p) => p.message.messageId)).toEqual(['evt_000001', 'evt_000001']);

    expect(await broker.deliverPending()).toBe(2);
    expect(consumer).toMatchObject({ processed: 1, duplicates: 1 });
    expect(shippingDb.snapshot('shipments')).toEqual([{ id: 'shp_1', orderId: 'ord_1', status: 'PENDING' }]);
  });

  it('the dual-write "before": a broker outage after commit loses the event for good', async () => {
    let t = 0;
    const clock = { now: () => t++ };
    const orders = createOrderDatabase();
    const broker = new FakeBroker();
    const naive = new DualWriteOrderService(orders, broker, clock);
    broker.available = false;
    await expect(naive.placeOrder({ orderId: 'ord_1', customerId: 'cus_1', totalMinor: 49_900 })).rejects.toBeInstanceOf(BrokerUnavailableError);
    broker.available = true;
    // The order exists, the customer was told "failed", and nothing records that an event is owed.
    expect(orders.snapshot('orders')).toHaveLength(1);
    expect(orders.snapshot('outbox')).toHaveLength(0);
    expect(await new OutboxRelay(orders, broker, clock, { topic: 'orders', pageSize: 10, maxPerPoll: 10 }).pollOnce()).toEqual({ published: 0 });
    expect(broker.published).toHaveLength(0);
  });
});
