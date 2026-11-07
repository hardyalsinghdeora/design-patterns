import { CheckoutError, CheckoutFacade, createSubsystems, type CheckoutRequest } from './facade';

const rs = (minor: number) => `Rs ${(minor / 100).toFixed(2)}`;
const subsystems = createSubsystems({ stock: { 'TEA-250G': 10, KETTLE: 1 }, declinedTokens: ['tok_broke'] });
const checkout = new CheckoutFacade(subsystems);

const order: CheckoutRequest = {
  orderId: 'ord_101',
  customerEmail: 'asha@example.com',
  items: [{ sku: 'TEA-250G', quantity: 2, unitPriceMinor: 34_900 }],
  address: { name: 'Asha', line1: '12 MG Road', city: 'Bengaluru', postcode: '560001' },
  paymentToken: 'tok_ok',
};

console.log('\nThe client makes ONE call: checkout.placeOrder(order)');
const receipt = checkout.placeOrder(order);
console.log(`  total ${rs(receipt.totalMinor)} (shipping ${rs(receipt.shippingMinor)}), tracking ${receipt.trackingId}`);
console.log('  calls the facade made for it, which every client would otherwise repeat:');
for (const call of subsystems.log) console.log(`    ${call}`);

const attempt = (label: string, request: CheckoutRequest) => {
  subsystems.log.length = 0;
  try {
    checkout.placeOrder(request);
    console.log(`  ${label}: OK`);
  } catch (error) {
    if (!(error instanceof CheckoutError)) throw error;
    console.log(`  ${label}: ${error.message}`);
    const undo = subsystems.log.filter((call) => /release|void|cancel/.test(call));
    console.log(`    compensation: ${undo.join(' -> ') || 'none needed'}`);
  }
};

console.log('\nFailures come back as one CheckoutError, with rollback already done:');
attempt('declined card', { ...order, orderId: 'ord_102', paymentToken: 'tok_broke' });
subsystems.shipping.carrierAvailable = false;
attempt('carrier down ', { ...order, orderId: 'ord_103' });
subsystems.shipping.carrierAvailable = true;
console.log('  TEA-250G stock after the failures:', subsystems.inventory.available('TEA-250G'), '(nothing leaked)');

console.log('\nThe facade does not lock anyone out: a warehouse job restocks directly.');
subsystems.inventory.restock('KETTLE', 5);
console.log('  KETTLE stock:', subsystems.inventory.available('KETTLE'));

subsystems.notifications.providerAvailable = false;
const quiet = checkout.placeOrder({ ...order, orderId: 'ord_104', items: [{ sku: 'KETTLE', quantity: 1, unitPriceMinor: 1_49_900 }] });
console.log(`\nEmail provider down: order still placed (${rs(quiet.totalMinor)}, free shipping), confirmationSent=${quiet.confirmationSent}`);
console.log();
