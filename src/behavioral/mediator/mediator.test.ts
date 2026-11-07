import { describe, expect, it } from 'vitest';
import {
  ChatRoom,
  ChatUser,
  FraudCheckComponent,
  FraudCheckedFulfilmentMediator,
  type FulfilmentEvent,
  type GatewayResult,
  InventoryComponent,
  type Mediator,
  NotificationComponent,
  type Order,
  OrderFulfilmentMediator,
  PaymentComponent,
  ShippingComponent,
} from './mediator';

const order: Order = {
  id: 'ord_1',
  customerEmail: 'asha@example.com',
  lines: [{ sku: 'MUG', quantity: 2, unitPriceMinor: 24_900 }],
  totalMinor: 49_800,
};

function build(options: { stock?: number; charge?: GatewayResult; ship?: GatewayResult } = {}) {
  const calls: string[] = [];
  const emails: string[] = [];
  const components = {
    inventory: new InventoryComponent(new Map([['MUG', options.stock ?? 10]])),
    payment: new PaymentComponent({
      charge: (orderId, amount) => (calls.push(`charge ${orderId} ${amount}`), options.charge ?? { ok: true, reference: 'pay_1' }),
      refund: (paymentId, amount) => void calls.push(`refund ${paymentId} ${amount}`),
    }),
    shipping: new ShippingComponent((o) => (calls.push(`book ${o.id}`), options.ship ?? { ok: true, reference: 'trk_1' })),
    notifications: new NotificationComponent((to, text) => void emails.push(`${to}: ${text}`)),
  };
  return { components, calls, emails };
}

describe('OrderFulfilmentMediator', () => {
  it('runs the happy path in order and completes the order', () => {
    const { components, calls, emails } = build();
    const mediator = new OrderFulfilmentMediator(components);
    expect(mediator.submit(order)).toMatchObject({ status: 'COMPLETED', paymentId: 'pay_1', trackingId: 'trk_1' });
    expect(mediator.trace).toEqual([
      'client:OrderSubmitted',
      'inventory:StockReserved',
      'payment:PaymentCaptured',
      'shipping:ShipmentBooked',
    ]);
    expect(calls).toEqual(['charge ord_1 49800', 'book ord_1']);
    expect(emails).toEqual(['asha@example.com: Order ord_1 shipped, tracking trk_1']);
    expect(components.inventory.available('MUG')).toBe(8);
  });

  it('components only talk to the mediator: each can be tested with a recording fake', () => {
    const heard: Array<[string, FulfilmentEvent]> = [];
    const fake: Mediator<FulfilmentEvent> = { notify: (sender, event) => void heard.push([sender, event]) };
    const inventory = new InventoryComponent(new Map([['MUG', 1]]));
    inventory.attach(fake);
    inventory.reserve(order);
    expect(heard).toEqual([['inventory', { type: 'StockUnavailable', orderId: 'ord_1', reason: 'MUG: 1 left, 2 wanted' }]]);
    expect(() => new ShippingComponent(() => ({ ok: true, reference: 't' })).book(order)).toThrow(/not attached/);
  });

  it('out of stock: payment is never charged and the customer is told', () => {
    const { components, calls, emails } = build({ stock: 1 });
    const result = new OrderFulfilmentMediator(components).submit(order);
    expect(result.status).toBe('FAILED');
    expect(calls).toEqual([]);
    expect(emails[0]).toMatch(/could not be fulfilled: MUG: 1 left/);
  });

  it('payment failure releases the stock and skips shipping', () => {
    const { components, calls } = build({ charge: { ok: false, reason: 'card declined' } });
    const result = new OrderFulfilmentMediator(components).submit(order);
    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'card declined' });
    expect(calls).toEqual(['charge ord_1 49800']);
    expect(components.inventory.available('MUG')).toBe(10);
  });

  it('shipping failure compensates in reverse order: refund, release, notify', () => {
    const { components, calls, emails } = build({ ship: { ok: false, reason: 'no courier for pincode' } });
    const mediator = new OrderFulfilmentMediator(components);
    expect(mediator.submit(order).status).toBe('FAILED');
    expect(calls).toEqual(['charge ord_1 49800', 'book ord_1', 'refund pay_1 49800']);
    expect(components.inventory.available('MUG')).toBe(10);
    expect(emails).toEqual(['asha@example.com: Order ord_1 could not be fulfilled: no courier for pincode']);
    expect(mediator.trace.at(-1)).toBe('shipping:ShipmentFailed');
  });

  it('wires a new component (fraud check) without touching the other components', () => {
    const cleared = build();
    const ok = new FraudCheckedFulfilmentMediator(cleared.components, new FraudCheckComponent(() => 10, 50));
    expect(ok.submit(order).status).toBe('COMPLETED');
    expect(ok.trace).toContain('fraud:FraudCleared');

    const rejected = build();
    const blocked = new FraudCheckedFulfilmentMediator(rejected.components, new FraudCheckComponent(() => 90, 50));
    expect(blocked.submit(order)).toMatchObject({ status: 'FAILED', failureReason: 'fraud score 90 > 50' });
    expect(rejected.calls).toEqual([]); // never charged
    expect(rejected.components.inventory.available('MUG')).toBe(10);
  });

  it('rejects a duplicate submission', () => {
    const mediator = new OrderFulfilmentMediator(build().components);
    mediator.submit(order);
    expect(() => mediator.submit(order)).toThrow(/already submitted/);
  });
});

describe('ChatRoom', () => {
  it('routes broadcasts and whispers; users never reference each other', () => {
    const [asha, ravi, meera] = [new ChatUser('asha'), new ChatUser('ravi'), new ChatUser('meera')];
    const room = new ChatRoom().join(asha).join(ravi).join(meera);
    asha.say('deploy is green');
    ravi.whisper('meera', 'can you take the pager?');
    room.leave('meera');
    asha.whisper('meera', 'thanks');
    expect(asha.inbox).toEqual(['room: meera is not in the room']);
    expect(ravi.inbox).toEqual(['asha: deploy is green']);
    expect(meera.inbox).toEqual(['asha: deploy is green', 'ravi (private): can you take the pager?']);
  });
});
