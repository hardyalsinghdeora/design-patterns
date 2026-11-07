/**
 * TEMPLATE METHOD
 * A base class fixes the skeleton of an algorithm (the template method) and lets
 * subclasses fill in individual steps, so the order can never drift between variants.
 *
 * Example domain: importing a product catalogue from CSV or JSON; rendering sales reports.
 * Amounts are integers in minor units (paise).
 */

export interface ProductRow {
  readonly sku: string;
  readonly name: string;
  readonly priceMinor: number;
}

export interface Rejection {
  /** 1-based record number in the source, so ops can find it. */
  readonly record: number;
  readonly errors: readonly string[];
}

export type ImportStep = 'extract' | 'transform' | 'validate' | 'beforeLoad' | 'load' | 'afterLoad';

export interface ImportReport {
  readonly source: string;
  readonly extracted: number;
  readonly loaded: number;
  readonly rejected: readonly Rejection[];
  readonly steps: readonly ImportStep[];
}

export interface ProductRepository {
  /** Insert or replace by SKU; returns the number of rows written. */
  upsert(rows: readonly ProductRow[]): number;
}

export class InMemoryProductRepository implements ProductRepository {
  readonly rows = new Map<string, ProductRow>();

  upsert(rows: readonly ProductRow[]): number {
    for (const row of rows) this.rows.set(row.sku, row);
    return rows.length;
  }
}

/** "249.00" or "249" -> 24900. Parsed as text: a float would turn 0.29 into 28.999... */
export function parseMoney(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) throw new Error(`"${text}" is not a price like 249.00`);
  const [, major = '0', minor = ''] = match;
  return Number(major) * 100 + Number(minor.padEnd(2, '0'));
}

/** The business rules every source shares. Lives in one place, whatever the format. */
export function validateProduct(row: ProductRow): string[] {
  const errors: string[] = [];
  if (!/^[A-Z0-9-]{3,20}$/.test(row.sku)) errors.push(`invalid sku "${row.sku}"`);
  if (row.name.trim() === '') errors.push('name is required');
  if (!Number.isInteger(row.priceMinor) || row.priceMinor <= 0) errors.push('price must be a positive amount');
  return errors;
}

/* ------------------------------------------------------------------------ */
/* Classic form: an abstract class with a template method                    */
/* ------------------------------------------------------------------------ */

export abstract class ImportJob<Raw> {
  constructor(
    readonly source: string,
    protected readonly repository: ProductRepository,
  ) {}

  /**
   * The template method. TypeScript has no `final`, so the rule "do not
   * override run()" is a convention; the steps are `protected` so callers can
   * only run the whole pipeline, never a step out of order.
   */
  run(input: string): ImportReport {
    const steps: ImportStep[] = [];
    const rejected: Rejection[] = [];

    steps.push('extract');
    const records = this.extract(input);

    steps.push('transform');
    const rows: Array<{ record: number; row: ProductRow }> = [];
    records.forEach((raw, i) => {
      try {
        rows.push({ record: i + 1, row: this.transform(raw) });
      } catch (error) {
        rejected.push({ record: i + 1, errors: [(error as Error).message] });
      }
    });

    steps.push('validate');
    const valid: ProductRow[] = [];
    for (const { record, row } of rows) {
      const errors = this.validate(row);
      if (errors.length > 0) rejected.push({ record, errors });
      else valid.push(row);
    }

    steps.push('beforeLoad');
    const toLoad = this.beforeLoad(valid);

    steps.push('load');
    const loaded = this.load(toLoad);

    steps.push('afterLoad');
    const report: ImportReport = {
      source: this.source,
      extracted: records.length,
      loaded,
      rejected: rejected.sort((a, b) => a.record - b.record),
      steps,
    };
    this.afterLoad(report);
    return report;
  }

  /** Primitive operations: every format must supply these. */
  protected abstract extract(input: string): Raw[];
  protected abstract transform(raw: Raw): ProductRow;

  /** Concrete steps with a sensible default; overriding them is allowed but rarely needed. */
  protected validate(row: ProductRow): string[] {
    return validateProduct(row);
  }

  protected load(rows: readonly ProductRow[]): number {
    return this.repository.upsert(rows);
  }

  /** Hooks: empty by default, so a subclass overrides them only if it cares. */
  protected beforeLoad(rows: ProductRow[]): ProductRow[] {
    return rows;
  }

  protected afterLoad(_report: ImportReport): void {}
}

/** CSV: header row, comma separated, no quoted commas (a real one would use a CSV parser). */
export function parseCsv(input: string): Array<Record<string, string>> {
  const [header, ...lines] = input.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!header) return [];
  const columns = header.split(',').map((c) => c.trim().toLowerCase());
  return lines.map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    return Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? '']));
  });
}

export function csvRecordToProduct(raw: Record<string, string>): ProductRow {
  return { sku: (raw.sku ?? '').toUpperCase(), name: raw.name ?? '', priceMinor: parseMoney(raw.price ?? '') };
}

/** Overrides the two primitive operations and nothing else. */
export class CsvProductImport extends ImportJob<Record<string, string>> {
  protected extract(input: string): Array<Record<string, string>> {
    return parseCsv(input);
  }

  protected transform(raw: Record<string, string>): ProductRow {
    return csvRecordToProduct(raw);
  }
}

export type AuditLog = (entry: string) => void;

/**
 * JSON from a partner feed: different field names, prices already in minor units,
 * and duplicate SKUs, so it also uses both hooks.
 */
export class JsonProductImport extends ImportJob<Record<string, unknown>> {
  constructor(
    source: string,
    repository: ProductRepository,
    private readonly audit: AuditLog,
  ) {
    super(source, repository);
  }

  protected extract(input: string): Array<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(input);
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of products');
    return parsed.map((item: unknown) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}));
  }

  protected transform(raw: Record<string, unknown>): ProductRow {
    const { sku, title, price_minor: priceMinor } = raw;
    if (typeof sku !== 'string' || typeof title !== 'string' || typeof priceMinor !== 'number') {
      throw new Error('expected { sku: string, title: string, price_minor: number }');
    }
    return { sku, name: title, priceMinor };
  }

  /** Hook: the feed repeats SKUs; the last occurrence wins. */
  protected override beforeLoad(rows: ProductRow[]): ProductRow[] {
    return [...new Map(rows.map((row) => [row.sku, row])).values()];
  }

  /** Hook: partner imports are audited. */
  protected override afterLoad(report: ImportReport): void {
    this.audit(`${report.source}: loaded ${report.loaded} of ${report.extracted}, rejected ${report.rejected.length}`);
  }
}

/* ------------------------------------------------------------------------ */
/* Functional form: the skeleton is a function, the steps are a config       */
/* ------------------------------------------------------------------------ */

export interface ImportSteps<Raw> {
  extract(input: string): Raw[];
  transform(raw: Raw): ProductRow;
  validate?: (row: ProductRow) => string[];
  beforeLoad?: (rows: ProductRow[]) => ProductRow[];
  afterLoad?: (report: ImportReport) => void;
}

/**
 * Same skeleton, no inheritance. It looks like a bundle of strategies, but the
 * order of the calls is still owned here, which is what makes it a template.
 */
export function defineImport<Raw>(source: string, steps: ImportSteps<Raw>, repository: ProductRepository): (input: string) => ImportReport {
  const { validate = validateProduct, beforeLoad = (rows: ProductRow[]) => rows, afterLoad = () => undefined } = steps;
  return (input) => {
    const records = steps.extract(input);
    const rejected: Rejection[] = [];
    const valid: ProductRow[] = [];
    records.forEach((raw, i) => {
      try {
        const row = steps.transform(raw);
        const errors = validate(row);
        if (errors.length > 0) rejected.push({ record: i + 1, errors });
        else valid.push(row);
      } catch (error) {
        rejected.push({ record: i + 1, errors: [(error as Error).message] });
      }
    });
    const loaded = repository.upsert(beforeLoad(valid));
    const report: ImportReport = {
      source,
      extracted: records.length,
      loaded,
      rejected,
      steps: ['extract', 'transform', 'validate', 'beforeLoad', 'load', 'afterLoad'],
    };
    afterLoad(report);
    return report;
  };
}

/* ------------------------------------------------------------------------ */
/* Second example: a report generator                                         */
/* ------------------------------------------------------------------------ */

export interface SalesLine {
  readonly region: string;
  readonly orders: number;
  readonly revenueMinor: number;
}

export abstract class SalesReport {
  /** The template method: header, one row per line, then an optional footer. */
  render(title: string, lines: readonly SalesLine[]): string {
    const total: SalesLine = {
      region: 'Total',
      orders: lines.reduce((sum, l) => sum + l.orders, 0),
      revenueMinor: lines.reduce((sum, l) => sum + l.revenueMinor, 0),
    };
    return [this.header(title), ...lines.map((line) => this.row(line)), this.footer(total)].filter((part) => part !== '').join('\n');
  }

  protected abstract header(title: string): string;
  protected abstract row(line: SalesLine): string;

  /** Hook: no footer unless the format wants one. */
  protected footer(_total: SalesLine): string {
    return '';
  }
}

/** Machine-readable: raw minor units, no totals (the consumer sums). */
export class CsvSalesReport extends SalesReport {
  protected header(): string {
    return 'region,orders,revenue_minor';
  }
  protected row(line: SalesLine): string {
    return `${line.region},${line.orders},${line.revenueMinor}`;
  }
}

/** Human-readable: formatted rupees and a total row. */
export class MarkdownSalesReport extends SalesReport {
  protected header(title: string): string {
    return `## ${title}\n\n| Region | Orders | Revenue |\n|---|---:|---:|`;
  }
  protected row(line: SalesLine): string {
    return `| ${line.region} | ${line.orders} | ${rupees(line.revenueMinor)} |`;
  }
  protected override footer(total: SalesLine): string {
    return `| **${total.region}** | **${total.orders}** | **${rupees(total.revenueMinor)}** |`;
  }
}

function rupees(minor: number): string {
  return `Rs ${Math.trunc(minor / 100).toLocaleString('en-IN')}.${String(minor % 100).padStart(2, '0')}`;
}
