import { describe, expect, it } from 'vitest';
import { CheckoutError, CheckoutFacade, createCheckoutModule, createSubsystems, type CheckoutRequest } from './facade';

const request = (overrides: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  orderId: 'ord_1',
  customerEmail: 'asha@example.com',
  items: [
    { sku: 'TEA-250G', quantity: 2, unitPriceMinor: 34_900 },
    { sku: 'MUG', quantity: 1, unitPriceMinor: 29_900 },
  ],
  address: { name: 'Asha', line1: '12 MG Road', city: 'Bengaluru', postcode: '560001' },
  paymentToken: 'tok_ok',
  ...overrides,
});

const setup = () => {
  const subsystems = createSubsystems({ stock: { 'TEA-250G': 5, MUG: 1 }, declinedTokens: ['tok_broke'] });
  return { ...subsystems, checkout: new CheckoutFacade(subsystems) };
};

describe('CheckoutFacade', () => {
  it('performs the whole subsystem sequence behind one call', () => {
    const { checkout, log, payments, inventory, notifications } = setup();
    const receipt = checkout.placeOrder(request());

    expect(log).toEqual([
      'shipping.quote',
      'inventory.reserve',
      'payments.authorize',
      'shipping.createShipment',
      'payments.capture',
      'inventory.commit',
      'notifications.send',
    ]);
    expect(receipt).toMatchObject({ subtotalMinor: 99_700, shippingMinor: 4_900, totalMinor: 1_04_600, confirmationSent: true });
    expect(payments.status(receipt.paymentId)).toBe('captured');
    expect(payments.amountOf(receipt.paymentId)).toBe(1_04_600);
    expect(inventory.available('MUG')).toBe(0);
    expect(notifications.outbox[0]?.to).toBe('asha@example.com');
  });

  it('surfaces a declined payment as one CheckoutError and releases the reserved stock', () => {
    const { checkout, log, inventory, shipping } = setup();
    const failure = (() => {
      try {
        checkout.placeOrder(request({ paymentToken: 'tok_broke' }));
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(CheckoutError);
    expect(failure).toMatchObject({ step: 'payment', orderId: 'ord_1' });
    expect((failure as CheckoutError).cause).toMatchObject({ name: 'PaymentDeclinedError' });
    expect(log.slice(-2)).toEqual(['payments.authorize', 'inventory.release']);
    expect(inventory.available('TEA-250G')).toBe(5);
    expect(inventory.openReservations).toBe(0);
    expect(shipping.activeShipments).toBe(0);
  });

  it('compensates in reverse order when a late step fails', () => {
    const { checkout, log, shipping, inventory } = setup();
    shipping.carrierAvailable = false;

    expect(() => checkout.placeOrder(request())).toThrow(/failed at shipment: Carrier API timed out/);
    expect(log.slice(-3)).toEqual(['shipping.createShipment', 'payments.void', 'inventory.release']);
    expect(inventory.available('MUG')).toBe(1);
  });

  it('stops before any side effect when stock or delivery is not possible', () => {
    const { checkout, log } = setup();
    expect(() => checkout.placeOrder(request({ items: [{ sku: 'MUG', quantity: 3, unitPriceMinor: 29_900 }] }))).toThrow(
      /failed at inventory: Only 1 of MUG left/,
    );
    expect(log).not.toContain('payments.authorize');

    const outOfArea = { name: 'Ravi', line1: '1 Beach Rd', city: 'Kochi', postcode: '682001' };
    expect(() => checkout.placeOrder(request({ address: outOfArea }))).toThrow(/failed at shipping-quote/);
  });

  it('does not fail a paid order because the confirmation email could not be sent', () => {
    const { checkout, notifications, payments } = setup();
    notifications.providerAvailable = false;
    const receipt = checkout.placeOrder(request());
    expect(receipt.confirmationSent).toBe(false);
    expect(payments.status(receipt.paymentId)).toBe('captured');
  });

  it('does not forbid direct access: subsystems remain usable on their own', () => {
    const { checkout, inventory, payments, log } = setup();
    inventory.restock('MUG', 4); // a warehouse job talks to inventory directly
    const refundHold = payments.authorize('tok_ok', 50_000); // so does a back-office tool
    payments.void(refundHold);

    expect(inventory.available('MUG')).toBe(5);
    expect(payments.status(refundHold)).toBe('voided');
    checkout.placeOrder(request({ items: [{ sku: 'MUG', quantity: 5, unitPriceMinor: 29_900 }] }));
    expect(inventory.available('MUG')).toBe(0);
    expect(log.filter((entry) => entry === 'payments.authorize')).toHaveLength(2);
  });

  it('offers the same behaviour as a module facade with a narrower surface', () => {
    const { log: _log, ...subsystems } = setup();
    const checkout = createCheckoutModule(subsystems);
    expect(Object.keys(checkout)).toEqual(['placeOrder', 'inStock']);
    expect(checkout.inStock('MUG')).toBe(true);
    expect(checkout.placeOrder(request()).totalMinor).toBe(1_04_600);
    expect(checkout.inStock('MUG')).toBe(false);
  });
});
