import {
  DiscountLine,
  type InvoiceItem,
  ProductLine,
  ServiceLine,
  TaxLine,
  TaxReportExporter,
  TotalCalculator,
  formatMinor,
  totalOfItems,
  validateInvoice,
} from './visitor';

const invoice = [
  new ProductLine('SKU-STAND', 'Laptop stand', 2, 120_000),
  new ServiceLine('SVC-SETUP', 'On-site setup', 90, 200_000),
  new DiscountLine('Festive offer', 40_000),
  new TaxLine('CGST', 'Central GST', 900),
  new TaxLine('SGST', 'State GST', 900),
];

console.log('\n1) TotalCalculator visits every line, then answers:');
const totals = TotalCalculator.of(invoice);
console.log(`   subtotal ${formatMinor(totals.subtotalMinor)}, discount ${formatMinor(totals.discountMinor)}, tax ${formatMinor(totals.taxMinor)}, total ${formatMinor(totals.totalMinor)}`);

console.log('\n2) TaxReportExporter, same lines, different operation:\n');
const report = TaxReportExporter.of(invoice);
console.log(report.toText());
console.log('\n   As CSV:\n');
console.log(report.toCsv().replace(/^/gm, '   '));

console.log('\n3) ValidationVisitor on a broken invoice:');
const broken = [new ProductLine('', 'Mystery box', 0, 120_000), new TaxLine('CGST', 'Central GST', 900), new TaxLine('CGST', 'dup', 900)];
for (const issue of validateInvoice(broken)) console.log(`   line ${issue.index}: ${issue.message}`);

console.log('\n4) Discriminated-union form over plain JSON data (no accept()):');
const items: InvoiceItem[] = [
  { kind: 'product', sku: 'SKU-STAND', description: 'Laptop stand', quantity: 2, unitPriceMinor: 120_000 },
  { kind: 'service', code: 'SVC-SETUP', description: 'On-site setup', minutes: 90, hourlyRateMinor: 200_000 },
  { kind: 'discount', description: 'Festive offer', amountMinor: 40_000 },
  { kind: 'tax', code: 'CGST', description: 'Central GST', rateBasisPoints: 900 },
  { kind: 'tax', code: 'SGST', description: 'State GST', rateBasisPoints: 900 },
];
console.log(`   total ${formatMinor(totalOfItems(items))} (matches the visitor: ${totalOfItems(items) === totals.totalMinor})`);
try {
  totalOfItems(JSON.parse('[{"kind":"shipping","amountMinor":5000}]') as InvoiceItem[]);
} catch (err) {
  console.log(`   unknown kind from the wire -> ${(err as Error).message}`);
}
console.log();
