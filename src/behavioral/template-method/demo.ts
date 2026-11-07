import {
  CsvProductImport,
  CsvSalesReport,
  InMemoryProductRepository,
  type ImportReport,
  JsonProductImport,
  MarkdownSalesReport,
  csvRecordToProduct,
  defineImport,
  parseCsv,
} from './template-method';

const repo = new InMemoryProductRepository();
const summary = (r: ImportReport) =>
  `  ${r.source}: extracted ${r.extracted}, loaded ${r.loaded}, rejected ${r.rejected.length}\n  steps: ${r.steps.join(' -> ')}`;

console.log('\n1. CSV import: the subclass supplies extract + transform only');
const csv = 'sku,name,price\nmug-01,Coffee mug,249.00\nTEE-02,T-shirt,599.5\nbad sku,Broken,10\nCAP-03,Cap,12.345';
const csvReport = new CsvProductImport('catalogue.csv', repo).run(csv);
console.log(summary(csvReport));
for (const r of csvReport.rejected) console.log(`    record ${r.record}: ${r.errors.join('; ')}`);

console.log('\n2. JSON partner feed: same skeleton, plus the beforeLoad (dedupe) and afterLoad (audit) hooks');
const feed = JSON.stringify([
  { sku: 'MUG-01', title: 'Coffee mug', price_minor: 22_900 },
  { sku: 'MUG-01', title: 'Coffee mug (new photo)', price_minor: 22_900 },
  { sku: 'BAG-04', title: 'Tote bag', price_minor: 34_900 },
]);
console.log(summary(new JsonProductImport('partner-feed.json', repo, (entry) => console.log(`  audit: ${entry}`)).run(feed)));

console.log('\n3. Functional form: the skeleton is a function, the steps a config object');
const importCsv = defineImport('inline.csv', { extract: parseCsv, transform: csvRecordToProduct }, repo);
console.log(summary(importCsv('sku,name,price\nPEN-05,Pen,49')));

console.log('\n   Catalogue now:');
for (const p of repo.rows.values()) console.log(`    ${p.sku.padEnd(7)} ${p.name.padEnd(24)} ${p.priceMinor} paise`);

console.log('\n4. Report generator: one render() skeleton, two formats');
const lines = [
  { region: 'North', orders: 120, revenueMinor: 3_45_000_00 },
  { region: 'South', orders: 80, revenueMinor: 2_10_050_25 },
];
console.log(new CsvSalesReport().render('Q1', lines));
console.log();
console.log(new MarkdownSalesReport().render('Q1 sales', lines));
console.log();
