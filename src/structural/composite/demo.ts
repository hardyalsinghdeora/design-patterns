import { Bundle, CycleError, Order, Product, formatMinor } from './composite';

const usbC = new Product('CBL-C', 'USB-C cable', 49_900, 60);
const hdmi = new Product('CBL-H', 'HDMI cable', 79_900, 120);
const stand = new Product('STD-1', 'Laptop stand', 2_49_900, 1_400);
const webcam = new Product('CAM-1', 'HD webcam', 3_99_900, 180);

const cablePack = new Bundle('PK-CBL', 'Cable pack', { discountBps: 1_000, packagingGrams: 30 }).add(usbC, 2).add(hdmi);
const homeOffice = new Bundle('KIT-HO', 'Home office kit', { discountBps: 500, packagingGrams: 400 })
  .add(stand)
  .add(cablePack)
  .add(webcam);

console.log('\nA kit is a tree; every node answers price(), weightGrams(), describe():\n');
for (const line of homeOffice.describe()) console.log('  ' + line);

const order = new Order('ord_77').add(homeOffice).add(usbC, 3);
console.log('\nThe order treats the kit and the loose cables the same way:');
console.log('  subtotal ', formatMinor(order.subtotal()));
console.log('  weight   ', `${order.weightGrams()} g`);
console.log('  shipping ', formatMinor(order.shippingMinor()));
console.log('  total    ', formatMinor(order.total()));

console.log('\nWarehouse picking list (tree flattened by a generator):');
for (const [sku, qty] of order.pickingList()) console.log(`  ${sku.padEnd(6)} x ${qty}`);

console.log('\nTrying to put the kit inside its own cable pack:');
try {
  cablePack.add(homeOffice);
} catch (e) {
  console.log(' ', e instanceof CycleError ? `refused: ${e.message}` : e);
}
console.log();
