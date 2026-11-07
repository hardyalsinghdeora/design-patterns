import {
  CardPaymentStrategy,
  CheckoutService,
  UpiPaymentStrategy,
  WalletPaymentStrategy,
  applyDiscount,
  bestOf,
  flatOff,
  percentageOff,
} from './strategy';

const checkout = new CheckoutService()
  .register(new CardPaymentStrategy())
  .register(new UpiPaymentStrategy())
  .register(new WalletPaymentStrategy(50_000)); // Rs 500 in the wallet

const smallOrder = { orderId: 'ord_1', amountMinor: 25_000, currency: 'INR' as const };
const bigOrder = { orderId: 'ord_2', amountMinor: 2_50_000 * 100, currency: 'INR' as const };

console.log('\nMethods for a Rs 250 order :', checkout.availableMethods(smallOrder));
console.log('Methods for a Rs 2.5L order:', checkout.availableMethods(bigOrder), '(UPI cap and wallet balance exclude the rest)');

for (const method of ['wallet', 'upi', 'card']) {
  const result = checkout.pay(method, smallOrder);
  console.log(`  ${method.padEnd(6)} -> ${result.ok ? 'OK ' : 'ERR'} ${result.message}`);
}

console.log('\nWallet again, now with Rs 250 left:');
console.log(' ', checkout.pay('wallet', smallOrder).message);
console.log(' ', checkout.pay('wallet', smallOrder).message);

console.log('\nFunctional strategies for discounts on a Rs 1,000 cart:');
const cart = 1_000 * 100;
console.log('  10% off      ->', applyDiscount(cart, percentageOff(10)) / 100);
console.log('  flat Rs 150  ->', applyDiscount(cart, flatOff(15_000)) / 100);
console.log('  best of both ->', applyDiscount(cart, bestOf(percentageOff(10), flatOff(15_000))) / 100);
console.log();
