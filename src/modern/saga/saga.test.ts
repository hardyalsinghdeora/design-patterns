import { describe, expect, it } from 'vitest';
import {
  FaultInjector,
  InMemoryEventBus,
  InMemorySagaStore,
  InventoryService,
  PaymentService,
  SagaOrchestrator,
  ShippingService,
  orderSagaSteps,
  outcomeOf,
  wireChoreography,
  type OrderContext,
  type OrderServices,
  type RetryPolicy,
} from './saga';

const order: OrderContext = { orderId: 'o1', lines: [{ sku: 'sku-1', quantity: 3 }], amountMinor: 150_00, address: 'Pune' };

function setup(faults = new FaultInjector()) {
  const services: OrderServices = {
    inventory: new InventoryService({ 'sku-1': 10 }, faults),
    payment: new PaymentService(faults),
    shipping: new ShippingService(faults),
  };
  const delays: number[] = [];
  const policy: RetryPolicy = { attempts: 3, baseDelayMs: 100, sleep: (ms) => (delays.push(ms), Promise.resolve()) };
  const store = new InMemorySagaStore();
  const saga = new SagaOrchestrator(orderSagaSteps(services), store, policy);
  return { services, faults, delays, policy, store, saga };
}

const systemState = ({ inventory, payment, shipping }: OrderServices) => ({
  stock: inventory.available('sku-1'),
  capturedMinor: payment.netCapturedMinor(),
  shipments: shipping.activeShipments(),
});

const compensationCalls = (faults: FaultInjector) =>
  faults.calls.filter((c) => ['inventory.release', 'payment.refund', 'shipping.cancel'].includes(c));

describe('SagaOrchestrator', () => {
  it('runs every step on the happy path and persists COMPLETED', async () => {
    const { saga, store, services } = setup();
    const state = await saga.run('s1', order);
    expect(state.history).toEqual(['STARTED', 'COMPLETED']);
    expect(store.load('s1')?.completedSteps).toEqual(['reserve-inventory', 'charge-payment', 'schedule-shipping']);
    expect(systemState(services)).toEqual({ stock: 7, capturedMinor: 150_00, shipments: 1 });
  });

  it.each([
    ['inventory.reserve', 'reserve-inventory', []],
    ['payment.charge', 'charge-payment', ['inventory.release']],
    ['shipping.schedule', 'schedule-shipping', ['payment.refund', 'inventory.release']],
  ])('failure at %s compensates exactly the completed steps, in reverse', async (op, failedStep, expected) => {
    const { saga, faults, services } = setup(new FaultInjector().fail(op));
    const state = await saga.run('s1', order);
    expect(state.status).toBe('FAILED');
    expect(state.history).toEqual(['STARTED', 'COMPENSATING', 'FAILED']);
    expect(state.failedStep).toBe(failedStep);
    expect(compensationCalls(faults)).toEqual(expected);
    expect(systemState(services)).toEqual({ stock: 10, capturedMinor: 0, shipments: 0 });
  });

  it('retries a failing compensation with backoff until it succeeds', async () => {
    const { saga, faults, delays } = setup(new FaultInjector().fail('shipping.schedule').fail('payment.refund', 2));
    const state = await saga.run('s1', order);
    expect(state.status).toBe('FAILED');
    expect(faults.calls.filter((c) => c === 'payment.refund')).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
    expect(state.compensatedSteps).toEqual(['charge-payment', 'reserve-inventory']);
  });

  it('parks in COMPENSATING when retries run out, and a later run resumes from the persisted state', async () => {
    const { saga, store, services } = setup(new FaultInjector().fail('shipping.schedule').fail('payment.refund', 4));
    expect((await saga.run('s1', order)).status).toBe('COMPENSATING');
    expect(store.load('s1')?.lastError).toMatch(/charge-payment/);
    expect(services.inventory.available('sku-1')).toBe(7); // not released yet: order matters

    const resumed = await saga.run('s1', order);
    expect(resumed.status).toBe('FAILED');
    expect(systemState(services)).toEqual({ stock: 10, capturedMinor: 0, shipments: 0 });
  });

  it('is idempotent: re-running a finished saga or redelivering steps changes nothing', async () => {
    const { saga, faults, services } = setup();
    await saga.run('s1', order);
    const callsBefore = faults.calls.length;
    await saga.run('s1', order);
    expect(faults.calls.length).toBe(callsBefore);

    services.inventory.reserve('o1', order.lines); // duplicate message
    services.payment.charge('o1', order.amountMinor);
    expect(systemState(services)).toEqual({ stock: 7, capturedMinor: 150_00, shipments: 1 });
    services.inventory.release('o1');
    services.inventory.release('o1');
    expect(services.inventory.available('sku-1')).toBe(10);
  });
});

describe('choreography', () => {
  it('compensates through events flowing backwards, in reverse order', async () => {
    const { services } = setup(new FaultInjector().fail('shipping.schedule'));
    const bus = new InMemoryEventBus();
    const tracker = wireChoreography(bus, services);
    await bus.publish({ type: 'OrderPlaced', order });
    expect(bus.log).toEqual([
      'OrderPlaced', 'InventoryReserved', 'PaymentCaptured', 'ShipmentFailed', 'PaymentRefunded', 'InventoryReleased',
    ]);
    expect(tracker.outcome('o1')).toBe('FAILED');
  });

  it('reaches the same final state as orchestration for success and for a failure at each step', async () => {
    for (const op of [undefined, 'inventory.reserve', 'payment.charge', 'shipping.schedule']) {
      const faults = () => (op ? new FaultInjector().fail(op) : new FaultInjector());
      const orchestrated = setup(faults());
      const state = await orchestrated.saga.run('s1', order);

      const choreographed = setup(faults());
      const bus = new InMemoryEventBus();
      const tracker = wireChoreography(bus, choreographed.services, choreographed.policy);
      await bus.publish({ type: 'OrderPlaced', order });

      expect(tracker.outcome('o1'), String(op)).toBe(outcomeOf(state));
      expect(systemState(choreographed.services), String(op)).toEqual(systemState(orchestrated.services));
    }
  });
});
