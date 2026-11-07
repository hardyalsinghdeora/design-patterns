import { CheckoutService, createProviderFactory, simulateProviderWebhook } from './abstract-factory';

let seq = 0;
const NOW = 1_762_500_000; // a fixed clock keeps the demo output stable
const runtime = { nextId: () => `demo${String(++seq).padStart(3, '0')}`, nowSeconds: () => NOW };

// The only line that knows about providers is the configuration value.
for (const provider of ['razorpay', 'stripe']) {
  const secret = `whsec_${provider}_demo`;
  const factory = createProviderFactory({ provider, webhookSecret: secret }, runtime);
  const checkout = new CheckoutService(factory);
  console.log(`\n=== PAYMENT_PROVIDER=${provider} ===`);

  const payment = checkout.placeOrder('ord_42', 1_499_00, 'INR'); // Rs 1,499
  console.log(`  charged   ${payment.id} for ${payment.amountMinor} ${payment.currency}`);

  const hook = simulateProviderWebhook(factory.provider, secret, 'payment.succeeded', payment.id, NOW);
  console.log(`  webhook   header ${Object.keys(hook.headers)[0]}`);
  const event = checkout.handleWebhook(hook.rawBody, hook.headers);
  console.log(`  verified  ${event.type} for ${event.objectId}, confirmed=${checkout.isConfirmed(payment.id)}`);

  const partial = checkout.refund(payment, 49_900);
  console.log(`  refunded  ${partial.id}: ${partial.amountMinor}`);
  const rest = checkout.refund(payment);
  console.log(`  refunded  ${rest.id}: ${rest.amountMinor} (the remainder)`);

  try {
    checkout.handleWebhook(hook.rawBody.replace(payment.id, 'pay_forged'), hook.headers);
  } catch (error) {
    console.log(`  tampered  ${(error as Error).message}`);
  }
}

try {
  createProviderFactory({ provider: 'paypal', webhookSecret: 'x' }, runtime);
} catch (error) {
  console.log(`\nMisconfigured: ${(error as Error).message}`);
}
console.log();
