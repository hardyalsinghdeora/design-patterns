import { BulkheadFullError, CheckoutService, FakeInventoryApi, FakePaymentsApi, defaultBulkheads } from './bulkhead';

const inventory = new FakeInventoryApi();
const payments = new FakePaymentsApi();
const bulkheads = defaultBulkheads(); // inventory: 3 running + 2 queued; payments: 5 + 5
const checkout = new CheckoutService(inventory, payments, bulkheads);
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const show = () => {
  for (const m of bulkheads.metrics()) {
    console.log(`  ${m.name.padEnd(9)} active=${m.active}/${m.maxConcurrent} queued=${m.queued}/${m.maxQueue} rejected=${m.rejected} completed=${m.completed}`);
  }
};

console.log('\nInventory is slow: 8 checkouts try to reserve stock and none of the calls return yet.');
const reservations: Promise<unknown>[] = [];
for (let i = 1; i <= 8; i++) {
  reservations.push(
    checkout.reserveStock({ orderId: `ord_${i}`, sku: 'SKU-42', quantity: 1 }).then(
      (r) => console.log(`  ord_${i}: reserved ${r.reservationId}`),
      (e: Error) => console.log(`  ord_${i}: ${e instanceof BulkheadFullError ? 'rejected fast' : 'failed'} (${e.message})`),
    ),
  );
}
await flush();
show();

console.log('\nMeanwhile payments for earlier orders still go straight through their own pool:');
const charges = [1, 2, 3].map((n) => checkout.charge({ orderId: `ord_old_${n}`, amountMinor: 49_900 }));
await flush();
show();
for (let n = 1; n <= 3; n++) payments.resolveOldest({ chargeId: `ch_${n}` });
console.log('  charged:', (await Promise.all(charges)).map((c) => c.chargeId).join(', '));

console.log('\nInventory recovers; queued calls are admitted as slots free up:');
for (let i = 1; i <= 5; i++) {
  inventory.resolveOldest({ reservationId: `res_${i}` });
  await flush();
}
await Promise.all(reservations);
show();
console.log(`  peak concurrent calls seen by inventory: ${inventory.peakInFlight}\n`);
