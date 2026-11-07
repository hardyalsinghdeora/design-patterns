import {
  ChatRoom,
  ChatUser,
  FraudCheckComponent,
  FraudCheckedFulfilmentMediator,
  type GatewayResult,
  InventoryComponent,
  NotificationComponent,
  type Order,
  OrderFulfilmentMediator,
  PaymentComponent,
  ShippingComponent,
} from './mediator';

const order = (id: string, quantity: number): Order => ({
  id,
  customerEmail: 'asha@example.com',
  lines: [{ sku: 'MUG', quantity, unitPriceMinor: 24_900 }],
  totalMinor: quantity * 24_900,
});

// Components get only their own dependencies; none of them knows the others exist.
function components(ship: GatewayResult) {
  return {
    inventory: new InventoryComponent(new Map([['MUG', 5]])),
    payment: new PaymentComponent({
      charge: (id, amount) => (amount > 100_000 ? { ok: false, reason: 'card limit exceeded' } : { ok: true, reference: `pay_${id}` }),
      refund: (paymentId, amount) => console.log(`    gateway: refund ${paymentId} ${amount}`),
    }),
    shipping: new ShippingComponent(() => ship),
    notifications: new NotificationComponent((to, text) => console.log(`    email -> ${to}: ${text}`)),
  };
}

function run(title: string, mediator: OrderFulfilmentMediator, o: Order): void {
  console.log(`\n${title}`);
  const result = mediator.submit(o);
  console.log(`    trace: ${mediator.trace.join(' -> ')}`);
  console.log(`    status: ${result.status}${result.failureReason ? ` (${result.failureReason})` : ''}`);
}

run('1. Happy path', new OrderFulfilmentMediator(components({ ok: true, reference: 'trk_9' })), order('ord_1', 2));
run('2. Payment declined: stock released, shipping never called', new OrderFulfilmentMediator(components({ ok: true, reference: 'x' })), order('ord_2', 5));
run('3. Courier unavailable: refund, release, notify', new OrderFulfilmentMediator(components({ ok: false, reason: 'no courier' })), order('ord_3', 1));
run(
  '4. New FraudCheck component, wired by a mediator subclass only',
  new FraudCheckedFulfilmentMediator(components({ ok: true, reference: 'trk_4' }), new FraudCheckComponent(() => 80, 50)),
  order('ord_4', 1),
);

console.log('\n5. Chat room: the room routes, users never hold references to each other');
const [asha, ravi] = [new ChatUser('asha'), new ChatUser('ravi')];
new ChatRoom().join(asha).join(ravi);
asha.say('deploy is green');
ravi.whisper('meera', 'are you on call?');
console.log('    asha inbox:', asha.inbox);
console.log('    ravi inbox:', ravi.inbox);
console.log();
