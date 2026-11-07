import {
  FaultInjector,
  InMemoryEventBus,
  InMemorySagaStore,
  InventoryService,
  PaymentService,
  SagaOrchestrator,
  ShippingService,
  orderSagaSteps,
  wireChoreography,
  type OrderContext,
} from './saga';

const order: OrderContext = {
  orderId: 'ord_42',
  lines: [{ sku: 'kbd-01', quantity: 2 }],
  amountMinor: 4_999_00,
  address: '12 MG Road, Bengaluru',
};

function services(faults: FaultInjector) {
  return {
    inventory: new InventoryService({ 'kbd-01': 10 }, faults),
    payment: new PaymentService(faults),
    shipping: new ShippingService(faults),
  };
}

console.log('\n1. Orchestration, happy path');
{
  const faults = new FaultInjector();
  const s = services(faults);
  const state = await new SagaOrchestrator(orderSagaSteps(s), new InMemorySagaStore()).run('saga_1', order);
  console.log('  status  :', state.history.join(' -> '));
  console.log('  stock   :', s.inventory.available('kbd-01'), '| captured:', s.payment.netCapturedMinor() / 100);
}

console.log('\n2. Orchestration, shipping fails and the first refund attempt times out');
{
  const faults = new FaultInjector().fail('shipping.schedule').fail('payment.refund', 1);
  const s = services(faults);
  const delays: number[] = [];
  const sleep = (ms: number) => (delays.push(ms), Promise.resolve());
  const saga = new SagaOrchestrator(orderSagaSteps(s), new InMemorySagaStore(), { attempts: 3, baseDelayMs: 100, sleep });
  const state = await saga.run('saga_2', order);
  console.log('  status      :', state.history.join(' -> '));
  console.log('  failed step :', state.failedStep);
  console.log('  compensated :', state.compensatedSteps.join(', '), '(reverse order)');
  console.log('  calls       :', faults.calls.join(', '));
  console.log('  backoff ms  :', delays);
  console.log('  stock back  :', s.inventory.available('kbd-01'), '| captured:', s.payment.netCapturedMinor());
}

console.log('\n3. Choreography, same failure, no coordinator');
{
  const faults = new FaultInjector().fail('shipping.schedule');
  const s = services(faults);
  const bus = new InMemoryEventBus();
  const tracker = wireChoreography(bus, s);
  await bus.publish({ type: 'OrderPlaced', order });
  console.log('  events  :', bus.log.join(' -> '));
  console.log('  outcome :', tracker.outcome(order.orderId));
  console.log('  stock   :', s.inventory.available('kbd-01'), '| captured:', s.payment.netCapturedMinor());
}
console.log();
