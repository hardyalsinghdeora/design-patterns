/**
 * SPECIFICATION
 * Wrap each business rule in an object with isSatisfiedBy(), and build bigger rules by combining small
 * ones with and/or/not. Every leaf can also express itself as a query, so one rule filters an array in
 * memory AND a table in the database, and explain() says which rules a candidate failed.
 *
 * Example domain: credit-line eligibility for customers, and filtering orders.
 * Amounts are integers in minor units (paise).
 */

export interface Customer {
  id: string;
  country: string;
  creditScore: number;
  annualIncomeMinor: number;
  overdueInvoices: number;
  accountAgeDays: number;
  kycVerified: boolean;
}

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'cancelled';

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  totalMinor: number;
  country: string;
}

/* ------------------------------------------------------------------------ */
/* The query AST. A discriminated union, so every translator is an          */
/* exhaustive switch and the compiler flags a missing operator.             */
/* ------------------------------------------------------------------------ */

export type FieldValue = string | number | boolean;

export type Query =
  | { op: 'eq'; field: string; value: FieldValue }
  | { op: 'gte'; field: string; value: number }
  | { op: 'lte'; field: string; value: number }
  | { op: 'in'; field: string; values: FieldValue[] }
  | { op: 'and'; clauses: Query[] }
  | { op: 'or'; clauses: Query[] }
  | { op: 'not'; clause: Query };

/** Keys of T whose values are V: `AtLeast<Customer>('country', 1)` does not compile. */
export type KeysOfType<T, V> = { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T] & keyof T & string;

/** The specification interface: one rule, three ways to use it (evaluate, explain, translate). */
export interface Specification<T> {
  isSatisfiedBy(candidate: T): boolean;
  /** Human-readable reasons the candidate fails; empty when it passes. */
  explain(candidate: T): string[];
  describe(): string;
  toQuery(): Query;
  and(other: Specification<T>): Specification<T>;
  or(other: Specification<T>): Specification<T>;
  not(): Specification<T>;
}

/** Gives every specification the combinators, so rules read like sentences. */
export abstract class CompositeSpecification<T> implements Specification<T> {
  abstract isSatisfiedBy(candidate: T): boolean;
  abstract describe(): string;
  abstract toQuery(): Query;

  explain(candidate: T): string[] {
    return this.isSatisfiedBy(candidate) ? [] : [this.describe()];
  }

  and(other: Specification<T>): Specification<T> {
    return new AndSpecification(this, other);
  }

  or(other: Specification<T>): Specification<T> {
    return new OrSpecification(this, other);
  }

  not(): Specification<T> {
    return new NotSpecification(this);
  }
}

/* ------------------------------------------------------------------------ */
/* Leaves: one field, one comparison. Small and reusable on purpose.         */
/* ------------------------------------------------------------------------ */

export abstract class FieldSpecification<T> extends CompositeSpecification<T> {
  constructor(
    protected readonly field: keyof T & string,
    private readonly label: string,
  ) {
    super();
  }

  protected abstract matches(value: unknown): boolean;

  isSatisfiedBy(candidate: T): boolean {
    return this.matches(candidate[this.field]);
  }

  describe(): string {
    return this.label;
  }

  /** Leaves report the actual value: "credit score >= 700 (was 640)" is actionable, "rejected" is not. */
  override explain(candidate: T): string[] {
    return this.isSatisfiedBy(candidate) ? [] : [`${this.label} (was ${String(candidate[this.field])})`];
  }
}

export class Equals<T> extends FieldSpecification<T> {
  constructor(field: KeysOfType<T, FieldValue>, private readonly value: FieldValue, label = `${field} = ${String(value)}`) {
    super(field, label);
  }
  protected matches(value: unknown): boolean {
    return value === this.value;
  }
  toQuery(): Query {
    return { op: 'eq', field: this.field, value: this.value };
  }
}

export class AtLeast<T> extends FieldSpecification<T> {
  constructor(field: KeysOfType<T, number>, private readonly min: number, label = `${field} >= ${min}`) {
    super(field, label);
  }
  protected matches(value: unknown): boolean {
    return typeof value === 'number' && value >= this.min;
  }
  toQuery(): Query {
    return { op: 'gte', field: this.field, value: this.min };
  }
}

export class AtMost<T> extends FieldSpecification<T> {
  constructor(field: KeysOfType<T, number>, private readonly max: number, label = `${field} <= ${max}`) {
    super(field, label);
  }
  protected matches(value: unknown): boolean {
    return typeof value === 'number' && value <= this.max;
  }
  toQuery(): Query {
    return { op: 'lte', field: this.field, value: this.max };
  }
}

export class OneOf<T> extends FieldSpecification<T> {
  constructor(field: KeysOfType<T, string>, private readonly values: readonly string[], label = `${field} in ${values.join('/')}`) {
    super(field, label);
  }
  protected matches(value: unknown): boolean {
    return this.values.some((v) => v === value);
  }
  toQuery(): Query {
    return { op: 'in', field: this.field, values: [...this.values] };
  }
}

/* ------------------------------------------------------------------------ */
/* Composites. And/Or keep a flat list, so a.and(b).and(c) is one AND of     */
/* three parts, not a nested tree: better descriptions, flatter SQL.         */
/* ------------------------------------------------------------------------ */

export class AndSpecification<T> extends CompositeSpecification<T> {
  readonly parts: readonly Specification<T>[];
  constructor(...parts: Specification<T>[]) {
    super();
    this.parts = parts;
  }
  isSatisfiedBy(candidate: T): boolean {
    return this.parts.every((p) => p.isSatisfiedBy(candidate));
  }
  /** Every failing part, not just the first: the customer fixes all of them in one go. */
  override explain(candidate: T): string[] {
    return this.parts.flatMap((p) => p.explain(candidate));
  }
  override and(other: Specification<T>): Specification<T> {
    return new AndSpecification(...this.parts, other);
  }
  describe(): string {
    return `(${this.parts.map((p) => p.describe()).join(' AND ')})`;
  }
  toQuery(): Query {
    const clauses = this.parts.map((p) => p.toQuery()).flatMap((q) => (q.op === 'and' ? q.clauses : [q]));
    return { op: 'and', clauses };
  }
}

export class OrSpecification<T> extends CompositeSpecification<T> {
  readonly parts: readonly Specification<T>[];
  constructor(...parts: Specification<T>[]) {
    super();
    this.parts = parts;
  }
  isSatisfiedBy(candidate: T): boolean {
    return this.parts.some((p) => p.isSatisfiedBy(candidate));
  }
  /** An OR fails only when every branch fails; report each branch's own reasons. */
  override explain(candidate: T): string[] {
    if (this.isSatisfiedBy(candidate)) return [];
    const branches = this.parts.map((p) => `[${p.explain(candidate).join('; ')}]`);
    return [`needs one of: ${branches.join(' or ')}`];
  }
  override or(other: Specification<T>): Specification<T> {
    return new OrSpecification(...this.parts, other);
  }
  describe(): string {
    return `(${this.parts.map((p) => p.describe()).join(' OR ')})`;
  }
  toQuery(): Query {
    const clauses = this.parts.map((p) => p.toQuery()).flatMap((q) => (q.op === 'or' ? q.clauses : [q]));
    return { op: 'or', clauses };
  }
}

export class NotSpecification<T> extends CompositeSpecification<T> {
  constructor(readonly inner: Specification<T>) {
    super();
  }
  isSatisfiedBy(candidate: T): boolean {
    return !this.inner.isSatisfiedBy(candidate);
  }
  override explain(candidate: T): string[] {
    return this.isSatisfiedBy(candidate) ? [] : [`must not be: ${this.inner.describe()}`];
  }
  /** Double negation cancels out instead of nesting NOT NOT. */
  override not(): Specification<T> {
    return this.inner;
  }
  describe(): string {
    return `NOT ${this.inner.describe()}`;
  }
  toQuery(): Query {
    return { op: 'not', clause: this.inner.toQuery() };
  }
}

/* ------------------------------------------------------------------------ */
/* Translators: the same AST becomes SQL, a Mongo filter, or is evaluated.   */
/* ------------------------------------------------------------------------ */

export interface SqlFragment {
  text: string;
  params: FieldValue[];
}

export const snakeCase = (field: string): string => field.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);

/** Values are always bound parameters ($1, $2...). Column names come from typed keys, never from user input. */
export function toSql(query: Query, column: (field: string) => string = snakeCase): SqlFragment {
  const params: FieldValue[] = [];
  const bind = (value: FieldValue): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const walk = (q: Query): string => {
    switch (q.op) {
      case 'eq':
        return `${column(q.field)} = ${bind(q.value)}`;
      case 'gte':
        return `${column(q.field)} >= ${bind(q.value)}`;
      case 'lte':
        return `${column(q.field)} <= ${bind(q.value)}`;
      case 'in':
        return `${column(q.field)} IN (${q.values.map((v) => bind(v)).join(', ')})`;
      case 'and':
        return q.clauses.length ? `(${q.clauses.map(walk).join(' AND ')})` : 'TRUE';
      case 'or':
        return q.clauses.length ? `(${q.clauses.map(walk).join(' OR ')})` : 'FALSE';
      case 'not':
        return `NOT (${walk(q.clause)})`;
    }
  };
  return { text: walk(query), params };
}

export type MongoFilter = { [key: string]: unknown };

export function toMongo(q: Query): MongoFilter {
  switch (q.op) {
    case 'eq':
      return { [q.field]: q.value };
    case 'gte':
      return { [q.field]: { $gte: q.value } };
    case 'lte':
      return { [q.field]: { $lte: q.value } };
    case 'in':
      return { [q.field]: { $in: q.values } };
    case 'and':
      return { $and: q.clauses.map(toMongo) };
    case 'or':
      return { $or: q.clauses.map(toMongo) };
    case 'not':
      return { $nor: [toMongo(q.clause)] };
  }
}

/** Evaluates the AST against a plain record. Used to prove toQuery() means what isSatisfiedBy() means. */
export function evaluateQuery(q: Query, record: object): boolean {
  const read = (field: string): unknown => (record as Record<string, unknown>)[field];
  switch (q.op) {
    case 'eq':
      return read(q.field) === q.value;
    case 'gte': {
      const v = read(q.field);
      return typeof v === 'number' && v >= q.value;
    }
    case 'lte': {
      const v = read(q.field);
      return typeof v === 'number' && v <= q.value;
    }
    case 'in': {
      const v = read(q.field);
      return q.values.some((x) => x === v);
    }
    case 'and':
      return q.clauses.every((c) => evaluateQuery(c, record));
    case 'or':
      return q.clauses.some((c) => evaluateQuery(c, record));
    case 'not':
      return !evaluateQuery(q.clause, record);
  }
}

/* ------------------------------------------------------------------------ */
/* Consumers: two repositories, one rule.                                    */
/* ------------------------------------------------------------------------ */

export interface OrderRepository {
  find(spec: Specification<Order>): Order[];
}

export class InMemoryOrderRepository implements OrderRepository {
  constructor(private readonly orders: readonly Order[]) {}
  find(spec: Specification<Order>): Order[] {
    return this.orders.filter((o) => spec.isSatisfiedBy(o));
  }
}

/** Builds the SELECT a SQL-backed repository would run; the WHERE clause comes from the spec. */
export class SqlOrderQueryBuilder {
  constructor(private readonly table = 'orders') {}
  build(spec: Specification<Order>): SqlFragment {
    const where = toSql(spec.toQuery());
    return { text: `SELECT * FROM ${this.table} WHERE ${where.text}`, params: where.params };
  }
}

/* ------------------------------------------------------------------------ */
/* Domain rules: named leaves, composed into policies.                       */
/* ------------------------------------------------------------------------ */

export const CustomerRules = {
  kycVerified: () => new Equals<Customer>('kycVerified', true, 'KYC verified'),
  noOverdueInvoices: () => new AtMost<Customer>('overdueInvoices', 0, 'no overdue invoices'),
  creditScoreAtLeast: (min: number) => new AtLeast<Customer>('creditScore', min, `credit score >= ${min}`),
  incomeAtLeast: (minMinor: number) => new AtLeast<Customer>('annualIncomeMinor', minMinor, `annual income >= ${minMinor}`),
  accountAgeAtLeast: (days: number) => new AtLeast<Customer>('accountAgeDays', days, `account age >= ${days} days`),
  servedIn: (...countries: string[]) => new OneOf<Customer>('country', countries, `country in ${countries.join('/')}`),
};

/** Buy-now-pay-later credit line: a good score, OR high income on an established account. */
export function creditLineEligibility(): Specification<Customer> {
  const r = CustomerRules;
  return r
    .kycVerified()
    .and(r.noOverdueInvoices())
    .and(r.servedIn('IN', 'SG'))
    .and(r.creditScoreAtLeast(700).or(r.incomeAtLeast(12_00_000_00).and(r.accountAgeAtLeast(365))));
}

export const OrderRules = {
  statusIn: (...statuses: OrderStatus[]) => new OneOf<Order>('status', statuses, `status in ${statuses.join('/')}`),
  totalAtLeast: (minMinor: number) => new AtLeast<Order>('totalMinor', minMinor, `total >= ${minMinor}`),
  shipsTo: (country: string) => new Equals<Order>('country', country, `ships to ${country}`),
};

/* ------------------------------------------------------------------------ */
/* Functional form: plain predicates compose just as well, but lose          */
/* toQuery() and explain(). Fine for in-memory checks only.                  */
/* ------------------------------------------------------------------------ */

export type Predicate<T> = (candidate: T) => boolean;

export const allOf =
  <T>(...predicates: Predicate<T>[]): Predicate<T> =>
  (c) =>
    predicates.every((p) => p(c));

export const anyOf =
  <T>(...predicates: Predicate<T>[]): Predicate<T> =>
  (c) =>
    predicates.some((p) => p(c));

export const negate =
  <T>(predicate: Predicate<T>): Predicate<T> =>
  (c) =>
    !predicate(c);

export const asPredicate =
  <T>(spec: Specification<T>): Predicate<T> =>
  (c) =>
    spec.isSatisfiedBy(c);
