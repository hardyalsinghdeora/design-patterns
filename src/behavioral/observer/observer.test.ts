import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ConfirmationEmailer,
  EventEmitter,
  InventoryReserver,
  type ListenerFailure,
  type OrderPlaced,
  OrderService,
  SalesAnalytics,
  wireOrderListeners,
} from './observer';

const fixedNow = new Date('2026-01-15T10:00:00Z');

function setup(stock: Record<string, number> = { 'SKU-MUG': 10, 'SKU-TEE': 5 }) {
  let seq = 0;
  const failures: ListenerFailure[] = [];
  const service = new OrderService({
    now: () => fixedNow,
    nextId: () => `ord_${++seq}`,
    onListenerError: (failure) => failures.push(failure),
  });
  const sent: string[] = [];
  const emailer = new ConfirmationEmailer((to, subject) => sent.push(`${to}: ${subject}`));
  const analytics = new SalesAnalytics();
  const inventory = new InventoryReserver(new Map(Object.entries(stock)));
  const detach = wireOrderListeners(service, { emailer, analytics, inventory });
  return { service, sent, analytics, inventory, failures, detach };
}

const mugs = (quantity: number) => [{ sku: 'SKU-MUG', quantity, unitPriceMinor: 24_900 }];

describe('Observer: OrderService and its listeners', () => {
  it('notifies every listener of OrderPlaced; the service knows none of them', () => {
    const { service, sent, analytics, inventory } = setup();
    service.placeOrder('asha@example.com', mugs(2));
    expect(sent).toEqual(['asha@example.com: Order ord_1 confirmed: Rs 498.00']);
    expect(analytics.totals).toEqual({ orders: 1, revenueMinor: 49_800 });
    expect(inventory.available('SKU-MUG')).toBe(8);
  });

  it('isolates a failing listener: the others still run and the error is collected', () => {
    const { service, sent, analytics, inventory, failures } = setup({ 'SKU-MUG': 1 });
    service.placeOrder('ravi@example.com', mugs(3));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ event: 'OrderPlaced', listener: 'InventoryReserver' });
    expect(String(failures[0]?.error)).toMatch(/Only 1 of SKU-MUG left/);
    expect(inventory.available('SKU-MUG')).toBe(1); // untouched: the check runs before any change
    expect(sent).toHaveLength(1);
    expect(analytics.totals.orders).toBe(1);
  });

  it('pull-style cancellation reverses revenue and releases stock, exactly once', () => {
    const { service, analytics, inventory } = setup();
    const order = service.placeOrder('asha@example.com', mugs(2));
    service.cancelOrder(order.id, 'customer request');
    service.cancelOrder(order.id, 'duplicate click'); // idempotent: no second event
    expect(analytics.totals).toEqual({ orders: 0, revenueMinor: 0 });
    expect(inventory.available('SKU-MUG')).toBe(10);
  });

  it('detaching the listeners stops all notifications', () => {
    const { service, sent, detach } = setup();
    detach();
    expect(service.events.on('OrderPlaced', () => undefined)).toBeTypeOf('function');
    service.placeOrder('asha@example.com', mugs(1));
    expect(sent).toEqual([]);
  });
});

describe('EventEmitter<Events>', () => {
  type BillingEvents = { InvoicePaid: { invoiceId: string; amountMinor: number }; InvoiceVoided: { invoiceId: string } };

  it('unsubscribes through the handle or off(), and the handle never removes a re-subscription', () => {
    const emitter = new EventEmitter<BillingEvents>();
    const seen: string[] = [];
    const listener = ({ invoiceId }: { invoiceId: string }) => seen.push(invoiceId);
    const handle = emitter.on('InvoicePaid', listener);
    emitter.emit('InvoicePaid', { invoiceId: 'inv_1', amountMinor: 100 });
    handle();
    emitter.emit('InvoicePaid', { invoiceId: 'inv_2', amountMinor: 100 });
    emitter.on('InvoicePaid', listener);
    handle(); // stale handle: no effect on the new registration
    emitter.emit('InvoicePaid', { invoiceId: 'inv_3', amountMinor: 100 });
    expect(emitter.off('InvoicePaid', listener)).toBe(true);
    expect(emitter.off('InvoicePaid', listener)).toBe(false);
    expect(seen).toEqual(['inv_1', 'inv_3']);
  });

  it('once() delivers at most once, even when the listener throws', () => {
    const emitter = new EventEmitter<BillingEvents>();
    let calls = 0;
    emitter.once('InvoiceVoided', () => {
      calls += 1;
      throw new Error('boom');
    });
    const first = emitter.emit('InvoiceVoided', { invoiceId: 'inv_1' });
    const second = emitter.emit('InvoiceVoided', { invoiceId: 'inv_1' });
    expect(calls).toBe(1);
    expect(first.failures).toHaveLength(1);
    expect(second).toEqual({ event: 'InvoiceVoided', delivered: 0, failures: [] });
  });

  it('subscribing twice is a no-op and subscribers added during emit wait for the next event', () => {
    const emitter = new EventEmitter<BillingEvents>();
    const seen: string[] = [];
    const late = ({ invoiceId }: { invoiceId: string }) => seen.push(`late:${invoiceId}`);
    const early = ({ invoiceId }: { invoiceId: string }) => {
      seen.push(`early:${invoiceId}`);
      emitter.on('InvoiceVoided', late);
    };
    emitter.on('InvoiceVoided', early);
    emitter.on('InvoiceVoided', early);
    expect(emitter.listenerCount('InvoiceVoided')).toBe(1);
    emitter.emit('InvoiceVoided', { invoiceId: 'a' });
    emitter.emit('InvoiceVoided', { invoiceId: 'b' });
    expect(seen).toEqual(['early:a', 'early:b', 'late:b']);
  });

  it('types each payload from the event map', () => {
    const service = setup().service;
    service.events.on('OrderPlaced', (event) => {
      expectTypeOf(event).toEqualTypeOf<OrderPlaced>();
    });
    const emitter = new EventEmitter<BillingEvents>();
    emitter.on('InvoicePaid', (event) => {
      expectTypeOf(event.amountMinor).toBeNumber();
    });
    expect(emitter.emit('InvoicePaid', { invoiceId: 'inv_9', amountMinor: 1 }).delivered).toBe(1);
  });
});
