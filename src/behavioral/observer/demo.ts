import {
  ConfirmationEmailer,
  InventoryReserver,
  OrderService,
  SalesAnalytics,
  formatRupees,
  wireOrderListeners,
} from './observer';

let seq = 0;
const service = new OrderService({
  now: () => new Date('2026-01-15T10:00:00Z'),
  nextId: () => `ord_${++seq}`,
  onListenerError: (f) => console.log(`  ! ${f.listener} failed on ${f.event}: ${(f.error as Error).message}`),
});

// The composition root wires observers; OrderService imports none of them.
const emailer = new ConfirmationEmailer((to, subject) => console.log(`  email -> ${to}: ${subject}`));
const analytics = new SalesAnalytics();
const inventory = new InventoryReserver(new Map([['SKU-MUG', 3], ['SKU-TEE', 10]]));
const detach = wireOrderListeners(service, { emailer, analytics, inventory });

console.log('\n1. Place an order: three listeners react to one OrderPlaced event');
const first = service.placeOrder('asha@example.com', [{ sku: 'SKU-MUG', quantity: 2, unitPriceMinor: 24_900 }]);
console.log(`  stock SKU-MUG = ${inventory.available('SKU-MUG')}, revenue = ${formatRupees(analytics.totals.revenueMinor)}`);

console.log('\n2. Order more mugs than exist: inventory throws, email and analytics still run');
service.placeOrder('ravi@example.com', [{ sku: 'SKU-MUG', quantity: 5, unitPriceMinor: 24_900 }]);
console.log(`  stock SKU-MUG = ${inventory.available('SKU-MUG')} (untouched)`);

console.log('\n3. once(): a one-off audit hook fires for the next order only');
service.events.once('OrderPlaced', (e) => console.log(`  audit: first big order of the day is ${e.orderId}`));
service.placeOrder('meera@example.com', [{ sku: 'SKU-TEE', quantity: 4, unitPriceMinor: 59_900 }]);
service.placeOrder('meera@example.com', [{ sku: 'SKU-TEE', quantity: 1, unitPriceMinor: 59_900 }]);

console.log('\n4. Cancel the first order: thin event, listeners pull what they need');
service.cancelOrder(first.id, 'customer request');
console.log(`  stock SKU-MUG = ${inventory.available('SKU-MUG')}, analytics =`, analytics.totals);

console.log('\n5. Detach every listener: the next order is silent');
detach();
service.placeOrder('asha@example.com', [{ sku: 'SKU-TEE', quantity: 1, unitPriceMinor: 59_900 }]);
console.log('  (no email, no stock change) SKU-TEE =', inventory.available('SKU-TEE'));
console.log();
