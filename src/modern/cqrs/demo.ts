import { InvariantViolation, createCommandSide, createQuerySide, steppingClock } from './cqrs';

const { bus, log } = createCommandSide(steppingClock());
const { queries, projectors, catchUp } = createQuerySide(log);
const rupees = (minor: number) => `Rs ${(minor / 100).toFixed(2)}`;

console.log('\nCommand side: place two orders and take a part payment');
bus.dispatch({ type: 'PlaceOrder', orderId: 'ord_1', customerId: 'acme', lines: [{ sku: 'seat', quantity: 10, unitPriceMinor: 499_00 }] });
bus.dispatch({ type: 'PlaceOrder', orderId: 'ord_2', customerId: 'acme', lines: [{ sku: 'addon', quantity: 1, unitPriceMinor: 1_000_00 }] });
bus.dispatch({ type: 'RecordPayment', orderId: 'ord_1', amountMinor: 2_000_00 });
console.log('  events in the log:', log.head);

console.log('\nQuery side before catch-up (eventual consistency, made visible):');
console.log('  lag per projector:', projectors.map((p) => `${p.projection.name}=${p.lag()}`).join(', '));
console.log('  acme balance     :', queries.customerBalance('acme') ?? 'not projected yet');

console.log('\nprojector.catchUp() ->', catchUp(), 'events applied');
const acme = queries.customerBalance('acme');
console.log('  acme billed', rupees(acme?.billedMinor ?? 0), '| paid', rupees(acme?.paidMinor ?? 0), '| owes', rupees(acme?.outstandingMinor ?? 0));
console.log('  unpaid orders    :', queries.unpaidOrders().map((r) => `${r.orderId} (${rupees(r.outstandingMinor)})`).join(', '));

console.log('\nInvariants live on the command side:');
for (const attempt of [
  () => bus.dispatch({ type: 'RecordPayment', orderId: 'ord_1', amountMinor: 9_999_00 }),
  () => bus.dispatch({ type: 'CancelOrder', orderId: 'ord_1', reason: 'changed mind' }),
]) {
  try {
    attempt();
  } catch (err) {
    if (err instanceof InvariantViolation) console.log('  refused:', err.message);
  }
}

bus.dispatch({ type: 'CancelOrder', orderId: 'ord_2', reason: 'duplicate' });
catchUp();
const before = JSON.stringify(projectors.map((p) => p.projection.snapshot()));
projectors.forEach((p) => p.rebuild());
const after = JSON.stringify(projectors.map((p) => p.projection.snapshot()));
console.log('\nRebuilt both read models from', log.head, 'events; identical to live:', before === after);
console.log('  acme now owes', rupees(queries.customerBalance('acme')?.outstandingMinor ?? 0));
console.log();
