import { InvoiceBuilder, InvoiceDirector, InvoiceValidationError, invoiceSteps, type Invoice } from './builder';

const clock = () => new Date('2026-11-01T09:30:00Z'); // fixed so the output is stable
const money = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
const customer = { id: 'cus_17', name: 'Acme Analytics', email: 'billing@acme.example' };

function print(invoice: Invoice): void {
  console.log(`  ${invoice.number} for ${invoice.customer.name}, issued ${invoice.issuedOn}, due ${invoice.dueOn}`);
  for (const l of invoice.lines) console.log(`    ${String(l.quantity).padStart(2)} x ${l.description.padEnd(34)} ${money(l.totalMinor).padStart(10)}`);
  if (invoice.discount) console.log(`    - ${invoice.discount.reason.padEnd(39)} ${money(invoice.discount.amountMinor).padStart(10)}`);
  for (const t of invoice.taxes) console.log(`    + ${`${t.name} ${t.rateBasisPoints / 100}%`.padEnd(39)} ${money(t.amountMinor).padStart(10)}`);
  console.log(`    = ${'Total INR'.padEnd(39)} ${money(invoice.totalMinor).padStart(10)}`);
}

console.log('\n1. Fluent builder, steps in any order, validated once at build():');
print(
  new InvoiceBuilder(clock)
    .number('INV-1001')
    .addLine({ description: 'Consulting, October', quantity: 2, unitPriceMinor: 49_900 })
    .forCustomer(customer)
    .addLine({ description: 'Data export add-on', quantity: 1, unitPriceMinor: 20_000 })
    .discount({ kind: 'percent', basisPoints: 1000, reason: 'Partner discount 10%' })
    .addTax('CGST', 900)
    .addTax('SGST', 900)
    .dueInDays(15)
    .build(),
);

console.log('\n2. Every problem reported together:');
try {
  new InvoiceBuilder(clock).currency('rupees').addLine({ description: 'Broken', quantity: 0, unitPriceMinor: 99.5 }).build();
} catch (error) {
  if (error instanceof InvoiceValidationError) error.problems.forEach((p) => console.log(`    - ${p}`));
}

console.log('\n3. Director recipes:');
const director = new InvoiceDirector(() => new InvoiceBuilder(clock));
const plan = { code: 'PRO', name: 'Pro', monthlyPriceMinor: 4_99_900, includedSeats: 5, seatPriceMinor: 49_900 };
print(director.monthlySubscription({ number: 'INV-1002', customer, plan, seats: 8, period: 'Nov 2026' }));
print(director.annualPrepaid({ number: 'INV-1003', customer, plan, seats: 5, period: 'Nov 2026' }));

console.log('\n4. Step builder: build() only exists after customer and a line:');
const invoice = invoiceSteps('INV-1004', clock).forCustomer(customer).addLine({ description: 'Setup fee', quantity: 1, unitPriceMinor: 10_000 }).build();
console.log(`  ${invoice.number}: total ${money(invoice.totalMinor)}, frozen=${Object.isFrozen(invoice)}`);
console.log();
