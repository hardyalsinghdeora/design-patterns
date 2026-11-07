/**
 * VISITOR
 * Keep a fixed set of element classes closed and add operations as visitor classes:
 * each element's accept() calls the visitor method for its own type (double dispatch).
 *
 * Example domain: invoice lines (product, service, discount, tax) and three operations
 * over them: totals, a tax-report export and validation. Amounts are paise.
 */

/** One method per element type. Adding a visitor = implementing this; elements stay untouched. */
export interface InvoiceLineVisitor<R> {
  visitProduct(line: ProductLine): R;
  visitService(line: ServiceLine): R;
  visitDiscount(line: DiscountLine): R;
  visitTax(line: TaxLine): R;
}

/** The element interface: the only operation an element knows is "let a visitor in". */
export interface InvoiceLine {
  readonly description: string;
  accept<R>(visitor: InvoiceLineVisitor<R>): R;
}

export class ProductLine implements InvoiceLine {
  constructor(
    readonly sku: string,
    readonly description: string,
    readonly quantity: number,
    readonly unitPriceMinor: number,
  ) {}

  get amountMinor(): number {
    return this.quantity * this.unitPriceMinor;
  }

  // Second dispatch: the element knows its own concrete type, so it picks the method.
  accept<R>(visitor: InvoiceLineVisitor<R>): R {
    return visitor.visitProduct(this);
  }
}

export class ServiceLine implements InvoiceLine {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly minutes: number,
    readonly hourlyRateMinor: number,
  ) {}

  get amountMinor(): number {
    return Math.round((this.minutes * this.hourlyRateMinor) / 60);
  }

  accept<R>(visitor: InvoiceLineVisitor<R>): R {
    return visitor.visitService(this);
  }
}

export class DiscountLine implements InvoiceLine {
  constructor(
    readonly description: string,
    readonly amountMinor: number,
  ) {}

  accept<R>(visitor: InvoiceLineVisitor<R>): R {
    return visitor.visitDiscount(this);
  }
}

export class TaxLine implements InvoiceLine {
  constructor(
    readonly code: string,
    readonly description: string,
    readonly rateBasisPoints: number, // 900 = 9.00 %
  ) {}

  taxOn(baseMinor: number): number {
    return Math.round((baseMinor * this.rateBasisPoints) / 10_000);
  }

  accept<R>(visitor: InvoiceLineVisitor<R>): R {
    return visitor.visitTax(this);
  }
}

export function visitAll<R>(lines: readonly InvoiceLine[], visitor: InvoiceLineVisitor<R>): R[] {
  return lines.map((line) => line.accept(visitor));
}

/* ---------------------------- Visitor 1: totals ---------------------------- */

export interface TaxAmount {
  code: string;
  description: string;
  rateBasisPoints: number;
  amountMinor: number;
}

export interface InvoiceTotals {
  goodsMinor: number;
  servicesMinor: number;
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxes: TaxAmount[];
  taxMinor: number;
  totalMinor: number;
}

/**
 * A stateful visitor: it accumulates while visiting and answers at the end.
 * Tax is computed in totals(), not in visitTax(), because the taxable base
 * depends on every other line and a tax line may appear before them.
 */
export class TotalCalculator implements InvoiceLineVisitor<void> {
  private goodsMinor = 0;
  private servicesMinor = 0;
  private discountsMinor = 0;
  private readonly taxLines: TaxLine[] = [];

  static of(lines: readonly InvoiceLine[]): InvoiceTotals {
    const calculator = new TotalCalculator();
    visitAll(lines, calculator);
    return calculator.totals();
  }

  visitProduct(line: ProductLine): void {
    this.goodsMinor += line.amountMinor;
  }

  visitService(line: ServiceLine): void {
    this.servicesMinor += line.amountMinor;
  }

  visitDiscount(line: DiscountLine): void {
    this.discountsMinor += line.amountMinor;
  }

  visitTax(line: TaxLine): void {
    this.taxLines.push(line);
  }

  totals(): InvoiceTotals {
    const subtotalMinor = this.goodsMinor + this.servicesMinor;
    // A discount can never make the invoice negative.
    const discountMinor = Math.min(this.discountsMinor, subtotalMinor);
    // GST-style: tax is charged on the value after the invoice-level discount.
    const taxableMinor = subtotalMinor - discountMinor;
    const taxes = this.taxLines.map((t) => ({
      code: t.code,
      description: t.description,
      rateBasisPoints: t.rateBasisPoints,
      amountMinor: t.taxOn(taxableMinor),
    }));
    const taxMinor = taxes.reduce((sum, t) => sum + t.amountMinor, 0);
    return {
      goodsMinor: this.goodsMinor,
      servicesMinor: this.servicesMinor,
      subtotalMinor,
      discountMinor,
      taxableMinor,
      taxes,
      taxMinor,
      totalMinor: taxableMinor + taxMinor,
    };
  }
}

/* ------------------------- Visitor 2: tax report --------------------------- */

export function formatMinor(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const formatRate = (bp: number) => `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`;

const csvField = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

interface ReportRow {
  kind: 'product' | 'service' | 'discount';
  ref: string;
  description: string;
  netMinor: number;
}

/**
 * Visitors compose: the exporter forwards every visit to an inner TotalCalculator
 * instead of re-implementing the tax rules, then renders text or CSV.
 */
export class TaxReportExporter implements InvoiceLineVisitor<void> {
  private readonly rows: ReportRow[] = [];
  private readonly calculator = new TotalCalculator();

  static of(lines: readonly InvoiceLine[]): TaxReportExporter {
    const exporter = new TaxReportExporter();
    visitAll(lines, exporter);
    return exporter;
  }

  visitProduct(line: ProductLine): void {
    this.calculator.visitProduct(line);
    this.rows.push({ kind: 'product', ref: line.sku, description: line.description, netMinor: line.amountMinor });
  }

  visitService(line: ServiceLine): void {
    this.calculator.visitService(line);
    this.rows.push({ kind: 'service', ref: line.code, description: line.description, netMinor: line.amountMinor });
  }

  visitDiscount(line: DiscountLine): void {
    this.calculator.visitDiscount(line);
    this.rows.push({ kind: 'discount', ref: '', description: line.description, netMinor: -line.amountMinor });
  }

  visitTax(line: TaxLine): void {
    this.calculator.visitTax(line);
  }

  toCsv(): string {
    const t = this.calculator.totals();
    const out = ['kind,ref,description,net_minor,rate_bp,tax_minor'];
    const push = (...fields: string[]) => out.push(fields.map(csvField).join(','));
    for (const r of this.rows) push(r.kind, r.ref, r.description, String(r.netMinor), '', '');
    for (const tax of t.taxes) {
      push('tax', tax.code, tax.description, String(t.taxableMinor), String(tax.rateBasisPoints), String(tax.amountMinor));
    }
    push('total', '', 'Invoice total', String(t.taxableMinor), '', String(t.taxMinor));
    return out.join('\n');
  }

  toText(): string {
    const t = this.calculator.totals();
    const line = (label: string, amount: number) => `  ${label.padEnd(36)}${formatMinor(amount).padStart(12)}`;
    const out = ['Tax report'];
    for (const r of this.rows) out.push(line(`${r.kind.padEnd(9)}${r.description}`, r.netMinor));
    out.push(line('Taxable value', t.taxableMinor));
    for (const tax of t.taxes) out.push(line(`${tax.code} @ ${formatRate(tax.rateBasisPoints)}`, tax.amountMinor));
    out.push(line('Total payable', t.totalMinor));
    return out.join('\n');
  }
}

/* -------------------------- Visitor 3: validation -------------------------- */

export interface ValidationIssue {
  index: number;
  message: string;
}

const isMinor = (n: number) => Number.isInteger(n) && n >= 0;

/** Returns issues per line, so the generic R is string[] here rather than void. */
export class ValidationVisitor implements InvoiceLineVisitor<string[]> {
  private readonly seenTaxCodes = new Set<string>();

  visitProduct(line: ProductLine): string[] {
    const issues: string[] = [];
    if (!line.sku.trim()) issues.push('product line needs a SKU');
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) issues.push(`quantity must be a positive integer, got ${line.quantity}`);
    if (!isMinor(line.unitPriceMinor)) issues.push(`unit price must be integer minor units, got ${line.unitPriceMinor}`);
    return issues;
  }

  visitService(line: ServiceLine): string[] {
    const issues: string[] = [];
    if (!Number.isInteger(line.minutes) || line.minutes <= 0) issues.push(`billable minutes must be a positive integer, got ${line.minutes}`);
    if (!isMinor(line.hourlyRateMinor)) issues.push(`hourly rate must be integer minor units, got ${line.hourlyRateMinor}`);
    return issues;
  }

  visitDiscount(line: DiscountLine): string[] {
    return isMinor(line.amountMinor) && line.amountMinor > 0
      ? []
      : [`discount must be a positive integer amount, got ${line.amountMinor}`];
  }

  visitTax(line: TaxLine): string[] {
    const issues: string[] = [];
    if (!Number.isInteger(line.rateBasisPoints) || line.rateBasisPoints < 0 || line.rateBasisPoints > 10_000) {
      issues.push(`tax rate must be 0..10000 basis points, got ${line.rateBasisPoints}`);
    }
    if (this.seenTaxCodes.has(line.code)) issues.push(`duplicate tax ${line.code}`);
    this.seenTaxCodes.add(line.code);
    return issues;
  }
}

export function validateInvoice(lines: readonly InvoiceLine[]): ValidationIssue[] {
  const visitor = new ValidationVisitor();
  return lines.flatMap((line, index) => line.accept(visitor).map((message) => ({ index, message })));
}

/* ------------------------------------------------------------------------ */
/* TypeScript alternative: a discriminated union and an exhaustive switch.  */
/* Plain data (straight from JSON), no accept() plumbing; the compiler      */
/* flags every switch when a new kind is added, just as a new visit method  */
/* would break every visitor.                                               */
/* ------------------------------------------------------------------------ */

export type InvoiceItem =
  | { kind: 'product'; sku: string; description: string; quantity: number; unitPriceMinor: number }
  | { kind: 'service'; code: string; description: string; minutes: number; hourlyRateMinor: number }
  | { kind: 'discount'; description: string; amountMinor: number }
  | { kind: 'tax'; code: string; description: string; rateBasisPoints: number };

/** Compile-time: `item` must be `never` here. Run-time: catches kinds that arrive in untyped JSON. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled invoice item: ${JSON.stringify(value)}`);
}

export function totalOfItems(items: readonly InvoiceItem[]): number {
  let subtotalMinor = 0;
  let discountMinor = 0;
  const rates: number[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'product':
        subtotalMinor += item.quantity * item.unitPriceMinor;
        break;
      case 'service':
        subtotalMinor += Math.round((item.minutes * item.hourlyRateMinor) / 60);
        break;
      case 'discount':
        discountMinor += item.amountMinor;
        break;
      case 'tax':
        rates.push(item.rateBasisPoints);
        break;
      default:
        assertNever(item);
    }
  }
  const taxableMinor = subtotalMinor - Math.min(discountMinor, subtotalMinor);
  return rates.reduce((sum, bp) => sum + Math.round((taxableMinor * bp) / 10_000), taxableMinor);
}

/** A handler object keyed by kind: the functional cousin of a visitor, checked for completeness. */
export type ItemHandlers<R> = { [K in InvoiceItem['kind']]: (item: Extract<InvoiceItem, { kind: K }>) => R };

export function matchItem<R>(item: InvoiceItem, handlers: ItemHandlers<R>): R {
  const handler = handlers[item.kind] as ((item: InvoiceItem) => R) | undefined;
  if (!handler) return assertNever(item as never);
  return handler(item);
}

/** Bridge from wire data to the class hierarchy, so both forms can share one invoice. */
export function toLine(item: InvoiceItem): InvoiceLine {
  return matchItem<InvoiceLine>(item, {
    product: (i) => new ProductLine(i.sku, i.description, i.quantity, i.unitPriceMinor),
    service: (i) => new ServiceLine(i.code, i.description, i.minutes, i.hourlyRateMinor),
    discount: (i) => new DiscountLine(i.description, i.amountMinor),
    tax: (i) => new TaxLine(i.code, i.description, i.rateBasisPoints),
  });
}
