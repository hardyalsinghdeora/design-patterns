import { describe, expect, it } from 'vitest';
import {
  CardPaymentStrategy,
  CheckoutService,
  UpiPaymentStrategy,
  WalletPaymentStrategy,
  applyDiscount,
  bestOf,
  flatOff,
  noDiscount,
  percentageOff,
} from './strategy';

const order = (amountMinor: number) => ({ orderId: 'o1', amountMinor, currency: 'INR' as const });

describe('CheckoutService (Strategy context)', () => {
  const build = () =>
    new CheckoutService()
      .register(new CardPaymentStrategy())
      .register(new UpiPaymentStrategy())
      .register(new WalletPaymentStrategy(10_000));

  it('delegates to the chosen strategy without switching on type', () => {
    const checkout = build();
    expect(checkout.pay('card', order(10_000))).toMatchObject({ ok: true, feeMinor: 200 });
    expect(checkout.pay('upi', order(10_000))).toMatchObject({ ok: true, feeMinor: 0 });
  });

  it('lists only the strategies that can handle the request', () => {
    const checkout = build();
    expect(checkout.availableMethods(order(10_000))).toEqual(['card', 'upi', 'wallet']);
    expect(checkout.availableMethods(order(10_001))).toEqual(['card', 'upi']);
    expect(checkout.availableMethods(order(2_00_000 * 100))).toEqual(['card']);
  });

  it('refuses gracefully when a strategy does not support the request', () => {
    const checkout = build();
    expect(checkout.pay('wallet', order(20_000)).ok).toBe(false);
  });

  it('throws for an unregistered method', () => {
    expect(() => build().pay('crypto', order(1))).toThrow(/Unknown payment method/);
  });

  it('wallet strategy keeps its own state', () => {
    const wallet = new WalletPaymentStrategy(10_000);
    const checkout = new CheckoutService().register(wallet);
    expect(checkout.pay('wallet', order(6_000)).ok).toBe(true);
    expect(wallet.balance).toBe(4_000);
    expect(checkout.pay('wallet', order(6_000)).ok).toBe(false);
  });
});

describe('functional discount strategies', () => {
  it('computes each strategy independently', () => {
    expect(applyDiscount(100_000, noDiscount)).toBe(100_000);
    expect(applyDiscount(100_000, percentageOff(10))).toBe(90_000);
    expect(applyDiscount(100_000, flatOff(15_000))).toBe(85_000);
  });

  it('never discounts below zero', () => {
    expect(applyDiscount(5_000, flatOff(15_000))).toBe(0);
  });

  it('composes strategies', () => {
    expect(applyDiscount(100_000, bestOf(percentageOff(10), flatOff(15_000)))).toBe(85_000);
    expect(applyDiscount(500_000, bestOf(percentageOff(10), flatOff(15_000)))).toBe(450_000);
  });
});
