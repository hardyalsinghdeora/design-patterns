/**
 * BUILDER
 * Assemble a complex object step by step, validate everything once in build(), and return an immutable result.
 */

/* Example domain: invoices with a customer, line items, taxes, a discount and
   payment terms. Amounts are integers in minor units (paise); tax and discount
   rates are basis points (1800 = 18%). */

export type Clock = () => Date;

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface LineItemInput {
  description: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface InvoiceLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly totalMinor: number;
}

export interface TaxLine {
  readonly name: string;
  readonly rateBasisPoints: number;
  readonly amountMinor: number;
}

export type DiscountInput =
  | { kind: 'percent'; basisPoints: number; reason: string }
  | { kind: 'flat'; amountMinor: number; reason: string };

export interface AppliedDiscount {
  readonly reason: string;
  readonly amountMinor: number;
}

/** The product. Every field is readonly in the type and frozen at runtime. */
export interface Invoice {
  readonly number: string;
  readonly customer: Customer;
  readonly currency: string;
  readonly issuedOn: string;
  readonly dueOn: string;
  readonly lines: readonly InvoiceLine[];
  readonly subtotalMinor: number;
  readonly discount: AppliedDiscount | null;
  readonly taxableMinor: number;
  readonly taxes: readonly TaxLine[];
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly notes: readonly string[];
}

/** Carries every problem at once: a caller fixing a form wants all the errors, not the first one. */
export class InvoiceValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invoice is invalid: ${problems.join('; ')}`);
    this.name = 'InvoiceValidationError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (isoDate: string, days: number): string => toIsoDate(new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS));
const isMinorAmount = (n: number): boolean => Number.isInteger(n) && n >= 0;
const isBasisPoints = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 10_000;
const applyRate = (amountMinor: number, rateBasisPoints: number): number => Math.round((amountMinor * rateBasisPoints) / 10_000);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

type DueRule = { kind: 'days'; days: number } | { kind: 'date'; date: string };

/**
 * The classic fluent builder. Setters only record intent; nothing is checked
 * until build(), so steps can come in any order and the invoice is never seen
 * half-valid.
 */
export class InvoiceBuilder {
  private invoiceNumber: string | undefined;
  private customer: Customer | undefined;
  private currencyCode = 'INR';
  private issueDate: string | undefined;
  private due: DueRule = { kind: 'days', days: 30 };
  private discountInput: DiscountInput | undefined;
  private readonly lines: LineItemInput[] = [];
  private readonly taxes: Array<{ name: string; rateBasisPoints: number }> = [];
  private readonly notes: string[] = [];

  constructor(private readonly clock: Clock) {}

  number(value: string): this {
    this.invoiceNumber = value;
    return this;
  }

  forCustomer(customer: Customer): this {
    this.customer = { ...customer }; // copy, so freezing the invoice never freezes the caller's object
    return this;
  }

  currency(code: string): this {
    this.currencyCode = code;
    return this;
  }

  issuedOn(isoDate: string): this {
    this.issueDate = isoDate;
    return this;
  }

  addLine(line: LineItemInput): this {
    this.lines.push({ ...line });
    return this;
  }

  addTax(name: string, rateBasisPoints: number): this {
    this.taxes.push({ name, rateBasisPoints });
    return this;
  }

  /** One discount per invoice; a second call replaces the first. */
  discount(discount: DiscountInput): this {
    this.discountInput = { ...discount };
    return this;
  }

  dueInDays(days: number): this {
    this.due = { kind: 'days', days };
    return this;
  }

  dueOn(isoDate: string): this {
    this.due = { kind: 'date', date: isoDate };
    return this;
  }

  note(text: string): this {
    this.notes.push(text);
    return this;
  }

  build(): Invoice {
    const problems: string[] = [];
    const number = this.invoiceNumber?.trim();
    const customer = this.customer;
    if (!number) problems.push('invoice number is required');
    if (!customer) problems.push('customer is required');
    if (!/^[A-Z]{3}$/.test(this.currencyCode)) problems.push(`currency "${this.currencyCode}" is not an ISO 4217 code`);
    if (this.lines.length === 0) problems.push('at least one line item is required');
    this.lines.forEach((line, i) => {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) problems.push(`line ${i + 1}: quantity must be a positive integer`);
      if (!isMinorAmount(line.unitPriceMinor)) problems.push(`line ${i + 1}: unit price must be a non-negative integer in minor units`);
    });
    const taxNames = new Set<string>();
    for (const tax of this.taxes) {
      if (!isBasisPoints(tax.rateBasisPoints)) problems.push(`tax ${tax.name}: rate must be 0-10000 basis points`);
      if (taxNames.has(tax.name)) problems.push(`tax ${tax.name} is added twice`);
      taxNames.add(tax.name);
    }

    const issuedOn = this.issueDate ?? toIsoDate(this.clock());
    if (!ISO_DATE.test(issuedOn)) problems.push(`issue date "${issuedOn}" is not YYYY-MM-DD`);
    const dueOn = this.resolveDueDate(issuedOn, problems);

    const lines = this.lines.map((l) => ({ ...l, totalMinor: l.quantity * l.unitPriceMinor }));
    const subtotalMinor = lines.reduce((sum, l) => sum + l.totalMinor, 0);
    const discount = this.discountInput ? this.resolveDiscount(this.discountInput, subtotalMinor, problems) : null;

    if (problems.length > 0 || !number || !customer) throw new InvoiceValidationError(problems);

    // Tax is charged on the discounted amount, each tax rounded on its own (how GST splits into CGST + SGST).
    const taxableMinor = subtotalMinor - (discount?.amountMinor ?? 0);
    const taxes = this.taxes.map((t) => ({ ...t, amountMinor: applyRate(taxableMinor, t.rateBasisPoints) }));
    const taxMinor = taxes.reduce((sum, t) => sum + t.amountMinor, 0);

    // Copies of every array: building again after more steps must not change this invoice.
    return deepFreeze<Invoice>({
      number,
      customer: { ...customer },
      currency: this.currencyCode,
      issuedOn,
      dueOn,
      lines,
      subtotalMinor,
      discount,
      taxableMinor,
      taxes,
      taxMinor,
      totalMinor: taxableMinor + taxMinor,
      notes: [...this.notes],
    });
  }

  private resolveDueDate(issuedOn: string, problems: string[]): string {
    if (this.due.kind === 'days') {
      if (!Number.isInteger(this.due.days) || this.due.days < 0) {
        problems.push('payment terms must be a whole number of days, 0 or more');
        return issuedOn;
      }
      return ISO_DATE.test(issuedOn) ? addDays(issuedOn, this.due.days) : issuedOn;
    }
    const date = this.due.date;
    if (!ISO_DATE.test(date)) problems.push(`due date "${date}" is not YYYY-MM-DD`);
    else if (date < issuedOn) problems.push(`due date ${date} is before issue date ${issuedOn}`);
    return date;
  }

  private resolveDiscount(d: DiscountInput, subtotalMinor: number, problems: string[]): AppliedDiscount | null {
    if (d.kind === 'percent') {
      if (!isBasisPoints(d.basisPoints)) {
        problems.push('percent discount must be 0-10000 basis points');
        return null;
      }
      return { reason: d.reason, amountMinor: applyRate(subtotalMinor, d.basisPoints) };
    }
    if (!isMinorAmount(d.amountMinor)) {
      problems.push('flat discount must be a non-negative integer in minor units');
      return null;
    }
    if (d.amountMinor > subtotalMinor) {
      problems.push(`discount ${d.amountMinor} exceeds subtotal ${subtotalMinor}`);
      return null;
    }
    return { reason: d.reason, amountMinor: d.amountMinor };
  }
}

/* ------------------------------------------------------------------------ */
/* TypeScript-idiomatic form: a step builder. Each step returns a narrower   */
/* interface, so build() does not exist on the type until a customer and at   */
/* least one line are set. Missing required data becomes a compile error;   */
/* value checks (quantity > 0, dates) still happen in build().               */
/* ------------------------------------------------------------------------ */

export interface CustomerStep {
  forCustomer(customer: Customer): LinesStep;
}

export interface LinesStep {
  addLine(line: LineItemInput): OptionalStep;
}

export interface OptionalStep {
  addLine(line: LineItemInput): OptionalStep;
  addTax(name: string, rateBasisPoints: number): OptionalStep;
  discount(discount: DiscountInput): OptionalStep;
  dueInDays(days: number): OptionalStep;
  note(text: string): OptionalStep;
  build(): Invoice;
}

export function invoiceSteps(number: string, clock: Clock, currency = 'INR'): CustomerStep {
  const builder = new InvoiceBuilder(clock).number(number).currency(currency);
  const optional: OptionalStep = {
    addLine: (line) => (builder.addLine(line), optional),
    addTax: (name, rate) => (builder.addTax(name, rate), optional),
    discount: (d) => (builder.discount(d), optional),
    dueInDays: (days) => (builder.dueInDays(days), optional),
    note: (text) => (builder.note(text), optional),
    build: () => builder.build(),
  };
  // Separate objects per step: build() is absent at runtime too, not only in the types.
  return {
    forCustomer: (customer) => {
      builder.forCustomer(customer);
      return { addLine: (line) => (builder.addLine(line), optional) };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Director: the standard recipes, so billing jobs do not re-derive "what a  */
/* subscription invoice looks like" in every call site.                     */
/* ------------------------------------------------------------------------ */

export interface SubscriptionPlan {
  code: string;
  name: string;
  monthlyPriceMinor: number;
  includedSeats: number;
  seatPriceMinor: number;
}

export interface SubscriptionOrder {
  number: string;
  customer: Customer;
  plan: SubscriptionPlan;
  seats: number;
  /** Human label for the billing period, e.g. "Nov 2026". */
  period: string;
}

export type BuilderFactory = () => InvoiceBuilder;

export const GST_BASIS_POINTS = 1800;

export class InvoiceDirector {
  constructor(private readonly newBuilder: BuilderFactory) {}

  monthlySubscription(order: SubscriptionOrder): Invoice {
    const builder = this.base(order).addLine({
      description: `${order.plan.name} plan, ${order.period}`,
      quantity: 1,
      unitPriceMinor: order.plan.monthlyPriceMinor,
    });
    const extraSeats = order.seats - order.plan.includedSeats;
    if (extraSeats > 0) {
      builder.addLine({ description: `Extra seats, ${order.period}`, quantity: extraSeats, unitPriceMinor: order.plan.seatPriceMinor });
    }
    return builder.dueInDays(7).note('Monthly subscription; auto-charged on the due date.').build();
  }

  /** Twelve months paid upfront, two of them free. */
  annualPrepaid(order: SubscriptionOrder): Invoice {
    return this.base(order)
      .addLine({ description: `${order.plan.name} plan, 12 months from ${order.period}`, quantity: 12, unitPriceMinor: order.plan.monthlyPriceMinor })
      .discount({ kind: 'flat', amountMinor: 2 * order.plan.monthlyPriceMinor, reason: 'Annual prepay: 2 months free' })
      .dueInDays(30)
      .build();
  }

  private base(order: SubscriptionOrder): InvoiceBuilder {
    // A fresh builder per recipe: builders are mutable and must not be shared between invoices.
    return this.newBuilder().number(order.number).forCustomer(order.customer).currency('INR').addTax('GST', GST_BASIS_POINTS);
  }
}
