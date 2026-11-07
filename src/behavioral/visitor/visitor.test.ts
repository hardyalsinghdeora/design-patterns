import { describe, expect, it } from 'vitest';
import {
  DiscountLine,
  type InvoiceItem,
  type InvoiceLine,
  type InvoiceLineVisitor,
  ProductLine,
  ServiceLine,
  TaxLine,
  TaxReportExporter,
  TotalCalculator,
  matchItem,
  toLine,
  totalOfItems,
  validateInvoice,
  visitAll,
} from './visitor';

// Rs 2,400 of goods + Rs 3,000 of services - Rs 400 discount, then 9% + 9% GST.
const items: InvoiceItem[] = [
  { kind: 'tax', code: 'CGST', description: 'Central GST', rateBasisPoints: 900 },
  { kind: 'product', sku: 'SKU-STAND', description: 'Laptop stand', quantity: 2, unitPriceMinor: 120_000 },
  { kind: 'service', code: 'SVC-SETUP', description: 'On-site setup', minutes: 90, hourlyRateMinor: 200_000 },
  { kind: 'discount', description: 'Festive offer', amountMinor: 40_000 },
  { kind: 'tax', code: 'SGST', description: 'State GST', rateBasisPoints: 900 },
];
const invoice = (): InvoiceLine[] => items.map(toLine);

describe('visitors over a mixed list of invoice lines', () => {
  it('TotalCalculator computes totals regardless of line order', () => {
    const totals = TotalCalculator.of(invoice());
    expect(totals).toMatchObject({
      goodsMinor: 240_000,
      servicesMinor: 300_000,
      discountMinor: 40_000,
      taxableMinor: 500_000,
      taxMinor: 90_000,
      totalMinor: 590_000,
    });
    expect(totals.taxes.map((t) => t.code)).toEqual(['CGST', 'SGST']);
  });

  it('caps the discount at the subtotal so the invoice never goes negative', () => {
    const totals = TotalCalculator.of([new ProductLine('A', 'Cable', 1, 10_000), new DiscountLine('Too generous', 50_000)]);
    expect(totals.taxableMinor).toBe(0);
    expect(totals.totalMinor).toBe(0);
  });

  it('TaxReportExporter emits CSV with quoting and a total row', () => {
    const lines = [...invoice(), new ProductLine('SKU-CBL', 'Cable, USB-C "braided"', 1, 50_000)];
    expect(TaxReportExporter.of(lines).toCsv()).toBe(
      [
        'kind,ref,description,net_minor,rate_bp,tax_minor',
        'product,SKU-STAND,Laptop stand,240000,,',
        'service,SVC-SETUP,On-site setup,300000,,',
        'discount,,Festive offer,-40000,,',
        'product,SKU-CBL,"Cable, USB-C ""braided""",50000,,',
        'tax,CGST,Central GST,550000,900,49500',
        'tax,SGST,State GST,550000,900,49500',
        'total,,Invoice total,550000,,99000',
      ].join('\n'),
    );
  });

  it('TaxReportExporter text form agrees with TotalCalculator', () => {
    const text = TaxReportExporter.of(invoice()).toText();
    expect(text).toContain('CGST @ 9.00%');
    expect(text).toMatch(/Total payable\s+5900\.00/);
  });

  it('ValidationVisitor reports issues by line index, including cross-line rules', () => {
    const issues = validateInvoice([
      new ProductLine('', 'Mystery box', 0, 99.5),
      new ServiceLine('SVC', 'Support', 30, 100_000),
      new TaxLine('IGST', 'Integrated GST', 1_800),
      new TaxLine('IGST', 'Integrated GST again', 20_000),
    ]);
    expect(issues.map((i) => i.index)).toEqual([0, 0, 0, 3, 3]);
    expect(issues[4]?.message).toBe('duplicate tax IGST');
    expect(validateInvoice(invoice())).toEqual([]);
  });

  it('adds a new operation as a new visitor without touching any element class', () => {
    // Lives only in this test: ledger postings for the accounting system.
    class LedgerPostingVisitor implements InvoiceLineVisitor<string> {
      visitProduct = (l: ProductLine) => `CR sales:goods ${l.amountMinor}`;
      visitService = (l: ServiceLine) => `CR sales:services ${l.amountMinor}`;
      visitDiscount = (l: DiscountLine) => `DR discounts ${l.amountMinor}`;
      visitTax = (l: TaxLine) => `CR tax-payable:${l.code.toLowerCase()}`;
    }
    expect(visitAll(invoice(), new LedgerPostingVisitor())).toEqual([
      'CR tax-payable:cgst',
      'CR sales:goods 240000',
      'CR sales:services 300000',
      'DR discounts 40000',
      'CR tax-payable:sgst',
    ]);
  });
});

describe('discriminated-union alternative', () => {
  it('computes the same total as the visitor version', () => {
    expect(totalOfItems(items)).toBe(TotalCalculator.of(invoice()).totalMinor);
  });

  it('matchItem dispatches on kind with a complete handler map', () => {
    const labels = items.map((item) =>
      matchItem(item, {
        product: (i) => `goods:${i.sku}`,
        service: (i) => `service:${i.code}`,
        discount: () => 'discount',
        tax: (i) => `tax:${i.code}`,
      }),
    );
    expect(labels).toEqual(['tax:CGST', 'goods:SKU-STAND', 'service:SVC-SETUP', 'discount', 'tax:SGST']);
  });

  it('exhaustiveness check rejects a kind the switch does not know (e.g. from untyped JSON)', () => {
    const fromWire = JSON.parse('[{"kind":"shipping","amountMinor":5000}]') as InvoiceItem[];
    expect(() => totalOfItems(fromWire)).toThrow(/Unhandled invoice item.*shipping/);
    expect(() => fromWire.map(toLine)).toThrow(/Unhandled invoice item/);
  });
});
