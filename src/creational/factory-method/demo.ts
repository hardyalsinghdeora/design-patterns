import { createDefaultExporterFactory, exporterFrom, formatMinor, lineTotalMinor, type InvoiceData } from './factory-method';

const invoice: InvoiceData = {
  number: 'INV-2026-0042',
  customer: 'Acme, Inc.',
  currency: 'INR',
  issuedOn: '2026-11-01',
  lines: [
    { sku: 'PLAN-PRO', description: 'Pro plan, November', quantity: 1, unitPriceMinor: 4_99_900 },
    { sku: 'SEAT', description: 'Extra seat "analyst"', quantity: 3, unitPriceMinor: 49_900 },
  ],
};

const factory = createDefaultExporterFactory();
console.log('\nRegistered formats:', factory.formats().join(', '));

// The caller only knows a format name, as it would from ?format=csv.
for (const format of ['pdf', 'csv', 'json']) {
  const file = factory.create(format).export(invoice);
  console.log(`\n--- ${file.filename} (${file.contentType}) ---`);
  console.log(file.body.trimEnd());
}

// A new format is a new registration; no existing exporter is edited.
factory.register('md', () =>
  exporterFrom(() => {
    const rows: string[] = [];
    return {
      contentType: 'text/markdown',
      extension: 'md',
      header: (inv) => rows.push(`# Invoice ${inv.number}`, '', '| Item | Qty | Amount |', '|---|---:|---:|'),
      line: (l) => rows.push(`| ${l.description} | ${l.quantity} | ${formatMinor(lineTotalMinor(l))} |`),
      footer: (total) => rows.push('', `**Total:** ${formatMinor(total)}`),
      finish: () => rows.join('\n'),
    };
  }),
);
console.log('\n--- added at runtime: md ---');
console.log(factory.create('md').export(invoice).body);

try {
  factory.create('xlsx');
} catch (error) {
  console.log('\nAsking for xlsx:', (error as Error).message);
}
console.log();
