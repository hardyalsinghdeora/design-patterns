import { describe, expect, it } from 'vitest';
import {
  CheckoutService,
  RazorpayFactory,
  StripeFactory,
  WebhookSignatureError,
  createProviderFactory,
  simulateProviderWebhook,
  type Payment,
  type PaymentProviderFactory,
} from './abstract-factory';

const NOW = 1_762_500_000;
const SECRET = 'whsec_test';
const runtime = () => {
  let n = 0;
  return { nextId: () => String(++n).padStart(4, '0'), nowSeconds: () => NOW };
};
const deps = () => ({ ...runtime(), webhookSecret: SECRET });

describe('one family works together', () => {
  it.each(['razorpay', 'stripe'])('checkout runs the same flow unchanged on the %s family', (provider) => {
    const factory = createProviderFactory({ provider, webhookSecret: SECRET }, runtime());
    const checkout = new CheckoutService(factory);
    const payment = checkout.placeOrder('ord_1', 50_000, 'INR');
    const hook = simulateProviderWebhook(factory.provider, SECRET, 'payment.succeeded', payment.id, NOW);

    expect(checkout.handleWebhook(hook.rawBody, hook.headers)).toEqual({ provider, type: 'payment.succeeded', objectId: payment.id });
    expect(checkout.isConfirmed(payment.id)).toBe(true);
    expect(checkout.refund(payment, 20_000).amountMinor).toBe(20_000);
    expect(checkout.refund(payment).amountMinor).toBe(30_000);
    expect(() => checkout.refund(payment, 1)).toThrow(/exceeds/);
  });

  it('each family speaks its own dialect', () => {
    const rzp = new CheckoutService(new RazorpayFactory(deps()));
    const stripe = new CheckoutService(new StripeFactory(deps()));
    const a = rzp.placeOrder('ord_1', 10_000, 'INR');
    const b = stripe.placeOrder('ord_1', 10_000, 'USD');
    expect([a.id, rzp.refund(a).id]).toEqual(['pay_0001', 'rfnd_0002']);
    expect([b.id, b.currency, stripe.refund(b).id]).toEqual(['pi_0001', 'usd', 're_0002']);
  });

  it('products share state only within one factory instance', () => {
    const factory = new RazorpayFactory(deps());
    const payment = factory.createPaymentClient().charge({ orderId: 'o1', amountMinor: 10_000, currency: 'INR' });
    expect(factory.createRefundHandler().refund(payment).amountMinor).toBe(10_000);
    const otherAccount = new RazorpayFactory(deps());
    expect(() => otherAccount.createRefundHandler().refund(payment)).toThrow(/Unknown razorpay payment/);
  });
});

describe('choosing and swapping the family', () => {
  it('picks the factory from configuration and rejects unknown providers', () => {
    expect(createProviderFactory({ provider: 'stripe', webhookSecret: SECRET }, runtime()).provider).toBe('stripe');
    expect(createProviderFactory({ provider: 'razorpay', webhookSecret: SECRET }, runtime())).toBeInstanceOf(RazorpayFactory);
    expect(() => createProviderFactory({ provider: 'paypal', webhookSecret: SECRET }, runtime())).toThrow(/Configure one of: razorpay, stripe/);
  });

  it('a verifier rejects webhooks signed in the other family\'s format, tampered or replayed', () => {
    const stripeHook = simulateProviderWebhook('stripe', SECRET, 'payment.succeeded', 'pi_1', NOW);
    const rzpVerifier = new RazorpayFactory(deps()).createWebhookVerifier();
    expect(() => rzpVerifier.verify(stripeHook.rawBody, stripeHook.headers)).toThrow(WebhookSignatureError);

    const stripeVerifier = new StripeFactory(deps()).createWebhookVerifier();
    expect(() => stripeVerifier.verify(stripeHook.rawBody.replace('pi_1', 'pi_2'), stripeHook.headers)).toThrow(/signature mismatch/);
    const stale = simulateProviderWebhook('stripe', SECRET, 'payment.succeeded', 'pi_1', NOW - 301);
    expect(() => stripeVerifier.verify(stale.rawBody, stale.headers)).toThrow(/tolerance/);
  });

  it('mixing families is a compile error, and a runtime error if the types are erased', () => {
    const rzpRefunds = new RazorpayFactory(deps()).createRefundHandler();
    const stripePayment = new StripeFactory(deps()).createPaymentClient().charge({ orderId: 'o1', amountMinor: 10_000, currency: 'INR' });
    // @ts-expect-error a Payment<'stripe'> is not a Payment<'razorpay'>
    expect(() => rzpRefunds.refund(stripePayment)).toThrow(/belongs to stripe, not razorpay/);

    const erased: Payment = stripePayment;
    const fromConfig = createProviderFactory({ provider: 'razorpay', webhookSecret: SECRET }, runtime());
    expect(() => new CheckoutService(fromConfig).refund(erased)).toThrow(/belongs to stripe/);
  });

  it('a hand-written fake family isolates checkout in tests', () => {
    const refunds: string[] = [];
    const fake: PaymentProviderFactory<'stripe'> = {
      provider: 'stripe',
      createPaymentClient: () => ({
        provider: 'stripe',
        charge: (r) => ({ provider: 'stripe', id: `fake_${r.orderId}`, orderId: r.orderId, amountMinor: r.amountMinor, currency: r.currency }),
      }),
      createWebhookVerifier: () => ({ provider: 'stripe', verify: (raw) => ({ provider: 'stripe', type: 'payment.succeeded', objectId: raw }) }),
      createRefundHandler: () => ({
        provider: 'stripe',
        refund: (p, amount) => (refunds.push(p.id), { provider: 'stripe', id: 're_fake', paymentId: p.id, amountMinor: amount ?? p.amountMinor }),
      }),
    };
    const checkout = new CheckoutService(fake);
    const payment = checkout.placeOrder('o9', 700, 'EUR');
    checkout.handleWebhook('fake_o9', {});
    expect(checkout.isConfirmed('fake_o9')).toBe(true);
    expect(checkout.refund(payment).amountMinor).toBe(700);
    expect(refunds).toEqual(['fake_o9']);
  });
});
