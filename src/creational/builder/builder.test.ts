import { describe, expect, it } from 'vitest';
import { InvoiceBuilder, InvoiceDirector, InvoiceValidationError, invoiceSteps, type InvoiceLine } from './builder';

const clock = () => new Date('2026-11-01T09:30:00Z');
const customer = { id: 'cus_17', name: 'Acme Analytics', email: 'billing@acme.example' };
const plan = { code: 'PRO', name: 'Pro', monthlyPriceMinor: 4_99_900, includedSeats: 5, seatPriceMinor: 49_900 };

const problemsOf = (build: () => unknown): readonly string[] => {
  try {
    build();
  } catch (error) {
    if (error instanceof InvoiceValidationError) return error.problems;
    throw error;
  }
  throw new Error('expected build() to fail validation');
};

const sample = () =>
  new InvoiceBuilder(clock)
    .number('INV-1001')
    .forCustomer(customer)
    .addLine({ description: 'Consulting', quantity: 2, unitPriceMinor: 49_900 })
    .addLine({ description: 'Export add-on', quantity: 1, unitPriceMinor: 20_000 })
    .discount({ kind: 'percent', basisPoints: 1000, reason: 'Partner 10%' })
    .addTax('CGST', 900)
    .addTax('SGST', 900)
    .dueInDays(15);

describe('InvoiceBuilder', () => {
  it('computes subtotal, discount, per-tax rounding and total in minor units', () => {
    const invoice = sample().build();
    expect(invoice).toMatchObject({ subtotalMinor: 119_800, discount: { amountMinor: 11_980 }, taxableMinor: 107_820, taxMinor: 19_408, totalMinor: 127_228 });
    expect(invoice.taxes.map((t) => t.amountMinor)).toEqual([9_704, 9_704]); // 9703.8 each, rounded separately
    expect([invoice.issuedOn, invoice.dueOn]).toEqual(['2026-11-01', '2026-11-16']);
  });

  it('collects every validation problem and throws only at build()', () => {
    const builder = new InvoiceBuilder(clock).currency('rupees').addLine({ description: 'x', quantity: 0, unitPriceMinor: 99.5 });
    expect(problemsOf(() => builder.build())).toEqual([
      'invoice number is required',
      'customer is required',
      'currency "rupees" is not an ISO 4217 code',
      'line 1: quantity must be a positive integer',
      'line 1: unit price must be a non-negative integer in minor units',
    ]);
  });

  it('rejects discounts above the subtotal, duplicate taxes and a due date before issue', () => {
    const problems = problemsOf(() =>
      sample().discount({ kind: 'flat', amountMinor: 200_000, reason: 'too generous' }).addTax('CGST', 900).dueOn('2026-10-01').build(),
    );
    expect(problems).toEqual(['tax CGST is added twice', 'due date 2026-10-01 is before issue date 2026-11-01', 'discount 200000 exceeds subtotal 119800']);
  });

  it('returns a deeply frozen invoice that later builder calls cannot change', () => {
    const builder = sample();
    const invoice = builder.build();
    expect(Object.isFrozen(invoice) && Object.isFrozen(invoice.lines) && Object.isFrozen(invoice.lines[0])).toBe(true);
    expect(() => {
      (invoice as { totalMinor: number }).totalMinor = 1;
    }).toThrow(TypeError);
    expect(() => (invoice.lines as InvoiceLine[]).push({ description: 'x', quantity: 1, unitPriceMinor: 1, totalMinor: 1 })).toThrow(TypeError);

    const bigger = builder.addLine({ description: 'Late add', quantity: 1, unitPriceMinor: 1_000 }).build();
    expect([invoice.lines.length, bigger.lines.length]).toEqual([2, 3]);
    expect(Object.isFrozen(customer)).toBe(false); // the caller's object was copied, not frozen
  });
});

describe('step builder and director', () => {
  it('build() is not callable until a customer and a line are set', () => {
    const start = invoiceSteps('INV-7', clock);
    // @ts-expect-error build() does not exist before forCustomer()
    start.build;
    const withCustomer = start.forCustomer(customer);
    // @ts-expect-error build() does not exist before the first addLine()
    withCustomer.build;
    expect('build' in start || 'build' in withCustomer).toBe(false);
    const invoice = withCustomer.addLine({ description: 'Setup', quantity: 1, unitPriceMinor: 10_000 }).addTax('GST', 1800).build();
    expect(invoice.totalMinor).toBe(11_800);
  });

  it('director builds the standard monthly subscription invoice', () => {
    const director = new InvoiceDirector(() => new InvoiceBuilder(clock));
    const invoice = director.monthlySubscription({ number: 'INV-1002', customer, plan, seats: 8, period: 'Nov 2026' });
    expect(invoice.lines.map((l) => [l.description, l.quantity, l.totalMinor])).toEqual([
      ['Pro plan, Nov 2026', 1, 499_900],
      ['Extra seats, Nov 2026', 3, 149_700],
    ]);
    expect([invoice.taxMinor, invoice.totalMinor, invoice.dueOn]).toEqual([116_928, 766_528, '2026-11-08']);
  });

  it('director recipes do not leak state into each other', () => {
    const director = new InvoiceDirector(() => new InvoiceBuilder(clock));
    const annual = director.annualPrepaid({ number: 'INV-1003', customer, plan, seats: 5, period: 'Nov 2026' });
    const monthly = director.monthlySubscription({ number: 'INV-1004', customer, plan, seats: 5, period: 'Dec 2026' });
    expect(annual).toMatchObject({ subtotalMinor: 5_998_800, discount: { amountMinor: 999_800 }, totalMinor: 5_898_820, dueOn: '2026-12-01' });
    expect(monthly.lines).toHaveLength(1);
    expect(monthly.discount).toBeNull();
  });
});
