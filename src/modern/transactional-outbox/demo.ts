import {
  DualWriteOrderService,
  FakeBroker,
  OrderService,
  OutboxRelay,
  ShippingConsumer,
  createOrderDatabase,
  createShippingDatabase,
} from './transactional-outbox';

let t = 0;
const clock = { now: () => (t += 10) };
const orders = createOrderDatabase();
const broker = new FakeBroker();
const service = new OrderService(orders, clock);
let crashOnce = false;
const relay = new OutboxRelay(orders, broker, clock, {
  topic: 'orders',
  pageSize: 10,
  maxPerPoll: 100,
  afterPublish: () => {
    if (crashOnce) {
      crashOnce = false;
      throw new Error('relay killed between publish and mark');
    }
  },
});
const consumer = new ShippingConsumer(createShippingDatabase(), clock);
broker.subscribe('orders', consumer.handle);
const pending = () => orders.snapshot('outbox').filter((e) => e.publishedAt === null).map((e) => e.id).join(', ') || '(none)';

console.log('\n0. The "before": dual write with the broker down.');
const naiveDb = createOrderDatabase();
const naiveBroker = new FakeBroker();
naiveBroker.available = false;
await new DualWriteOrderService(naiveDb, naiveBroker, clock)
  .placeOrder({ orderId: 'ord_x', customerId: 'cus_9', totalMinor: 99_900 })
  .catch((e: Error) => console.log(`  placeOrder threw "${e.message}", yet orders=${naiveDb.snapshot('orders').length} and no record of the lost event`));

console.log('\n1. Outbox: two orders placed while the broker is down.');
broker.available = false;
await service.placeOrder({ orderId: 'ord_1', customerId: 'cus_1', totalMinor: 49_900 });
await service.placeOrder({ orderId: 'ord_2', customerId: 'cus_2', totalMinor: 1_29_900 });
console.log('  poll ->', await relay.pollOnce(), '| pending:', pending());

console.log('\n2. Broker back; the next poll catches up in order.');
broker.available = true;
console.log('  poll ->', await relay.pollOnce(), '| pending:', pending());

console.log('\n3. Relay crashes after publishing ord_3 but before marking it.');
await service.placeOrder({ orderId: 'ord_3', customerId: 'cus_1', totalMinor: 19_900 });
crashOnce = true;
await relay.pollOnce().catch((e: Error) => console.log(`  poll crashed: ${e.message} | pending: ${pending()}`));
console.log('  restarted poll ->', await relay.pollOnce());
console.log('  broker log:', broker.published.map((p) => p.message.messageId).join(', '));

console.log('\n4. Shipping consumes everything; the inbox absorbs the duplicate.');
await broker.deliverPending();
console.log(`  processed=${consumer.processed} duplicates=${consumer.duplicates}\n`);
