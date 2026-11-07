/**
 * FACTORY METHOD
 * A creator class runs the algorithm; one overridable method decides which concrete product it works with.
 */

/* Example domain: exporting an invoice as PDF-like text, CSV or JSON.
   Amounts are integers in minor units (paise). */

export interface InvoiceLine {
  sku: string;
  description: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface InvoiceData {
  number: string;
  customer: string;
  currency: string;
  /** ISO date, kept as a string so exports are deterministic. */
  issuedOn: string;
  lines: readonly InvoiceLine[];
}

export interface ExportedFile {
  filename: string;
  contentType: string;
  body: string;
}

export const lineTotalMinor = (line: InvoiceLine): number => line.quantity * line.unitPriceMinor;

export const invoiceTotalMinor = (invoice: InvoiceData): number =>
  invoice.lines.reduce((sum, line) => sum + lineTotalMinor(line), 0);

/** 649600 -> "6496.00". Integer arithmetic only; no floats near money. */
export function formatMinor(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------------ */
/* Product: what the creator works with. Writers are stateful (they          */
/* accumulate output), which is why the creator asks for a fresh one per     */
/* export instead of holding one.                                            */
/* ------------------------------------------------------------------------ */

export interface DocumentWriter {
  readonly contentType: string;
  readonly extension: string;
  header(invoice: InvoiceData): void;
  line(line: InvoiceLine): void;
  footer(totalMinor: number, invoice: InvoiceData): void;
  finish(): string;
}

/** A print layout: the text a PDF renderer would draw, without a PDF dependency. */
export class PdfTextWriter implements DocumentWriter {
  readonly contentType = 'text/plain';
  readonly extension = 'pdf.txt';
  private readonly out: string[] = [];

  constructor(private readonly width = 44) {}

  header(invoice: InvoiceData): void {
    this.out.push(`INVOICE ${invoice.number}`, `Bill to: ${invoice.customer}`, `Issued:  ${invoice.issuedOn}`, this.rule());
  }

  line(line: InvoiceLine): void {
    this.out.push(this.columns(`${line.quantity} x ${line.description}`, formatMinor(lineTotalMinor(line))));
  }

  footer(totalMinor: number, invoice: InvoiceData): void {
    this.out.push(this.rule(), this.columns(`TOTAL ${invoice.currency}`, formatMinor(totalMinor)));
  }

  finish(): string {
    return this.out.join('\n');
  }

  private rule(): string {
    return '-'.repeat(this.width);
  }

  /** Left text, right-aligned amount, truncated to the page width. */
  private columns(left: string, right: string): string {
    const room = this.width - right.length - 1;
    const text = left.length > room ? `${left.slice(0, room - 1)}~` : left;
    return `${text.padEnd(room)} ${right}`;
  }
}

const csvField = (value: string | number): string => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export class CsvWriter implements DocumentWriter {
  readonly contentType = 'text/csv';
  readonly extension = 'csv';
  private readonly rows: string[] = [];
  private invoiceNumber = '';

  header(invoice: InvoiceData): void {
    this.invoiceNumber = invoice.number;
    this.rows.push('invoice,sku,description,quantity,unit_price_minor,line_total_minor');
  }

  line(line: InvoiceLine): void {
    const fields = [this.invoiceNumber, line.sku, line.description, line.quantity, line.unitPriceMinor, lineTotalMinor(line)];
    this.rows.push(fields.map(csvField).join(','));
  }

  /** Deliberately empty: CSV feeds spreadsheets and ETL jobs, and a totals row would break column types. */
  footer(): void {}

  finish(): string {
    return this.rows.map((row) => `${row}\r\n`).join(''); // RFC 4180 line endings
  }
}

interface JsonInvoice {
  invoice: string;
  customer: string;
  currency: string;
  issuedOn: string;
  lines: Array<InvoiceLine & { totalMinor: number }>;
  totalMinor: number;
}

export class JsonWriter implements DocumentWriter {
  readonly contentType = 'application/json';
  readonly extension = 'json';
  private doc: JsonInvoice | undefined;

  header(invoice: InvoiceData): void {
    const { number, customer, currency, issuedOn } = invoice;
    this.doc = { invoice: number, customer, currency, issuedOn, lines: [], totalMinor: 0 };
  }

  line(line: InvoiceLine): void {
    this.started().lines.push({ ...line, totalMinor: lineTotalMinor(line) });
  }

  footer(totalMinor: number): void {
    this.started().totalMinor = totalMinor;
  }

  finish(): string {
    return JSON.stringify(this.started(), null, 2);
  }

  private started(): JsonInvoice {
    if (!this.doc) throw new Error('JsonWriter used before header()');
    return this.doc;
  }
}

/* ------------------------------------------------------------------------ */
/* Creator: owns the algorithm, defers "which writer?" to createWriter().     */
/* ------------------------------------------------------------------------ */

/** The algorithm every format shares: validate, walk the invoice, name the file. */
export function runExport(invoice: InvoiceData, writer: DocumentWriter): ExportedFile {
  writer.header(invoice);
  for (const line of invoice.lines) writer.line(line);
  writer.footer(invoiceTotalMinor(invoice), invoice);
  return { filename: `${invoice.number}.${writer.extension}`, contentType: writer.contentType, body: writer.finish() };
}

export abstract class Exporter {
  /** The factory method. export() never names a concrete writer class. */
  protected abstract createWriter(): DocumentWriter;

  export(invoice: InvoiceData): ExportedFile {
    if (invoice.lines.length === 0) throw new Error(`Invoice ${invoice.number} has no lines to export`);
    // A fresh product per call: writers carry state, so sharing one would leak rows between exports.
    return runExport(invoice, this.createWriter());
  }
}

export class PdfExporter extends Exporter {
  // Note: this field is assigned AFTER super() returns. If Exporter's constructor
  // called createWriter(), pageWidth would still be undefined. Never call a
  // factory method from a base-class constructor.
  constructor(private readonly pageWidth = 44) {
    super();
  }

  protected override createWriter(): DocumentWriter {
    return new PdfTextWriter(this.pageWidth);
  }
}

export class CsvExporter extends Exporter {
  protected override createWriter(): DocumentWriter {
    return new CsvWriter();
  }
}

export class JsonExporter extends Exporter {
  protected override createWriter(): DocumentWriter {
    return new JsonWriter();
  }
}

/* ------------------------------------------------------------------------ */
/* TypeScript-idiomatic form: a registry of creator functions. Callers ask   */
/* for a format by name (from a query string or a job payload), and a new    */
/* format is one register() call in its own module.                          */
/* ------------------------------------------------------------------------ */

export type ExporterCreator = () => Exporter;

export class UnknownFormatError extends Error {
  constructor(
    readonly format: string,
    readonly known: readonly string[],
  ) {
    super(`Unknown export format "${format}". Known formats: ${known.join(', ')}`);
    this.name = 'UnknownFormatError';
  }
}

export class ExporterFactory {
  private readonly creators = new Map<string, ExporterCreator>();

  register(format: string, creator: ExporterCreator): this {
    const key = format.toLowerCase();
    // Silent overwrites hide plugin conflicts; make them loud.
    if (this.creators.has(key)) throw new Error(`Export format "${format}" is already registered`);
    this.creators.set(key, creator);
    return this;
  }

  create(format: string): Exporter {
    const creator = this.creators.get(format.toLowerCase());
    if (!creator) throw new UnknownFormatError(format, this.formats());
    return creator();
  }

  formats(): string[] {
    return [...this.creators.keys()].sort();
  }
}

export function createDefaultExporterFactory(): ExporterFactory {
  return new ExporterFactory()
    .register('pdf', () => new PdfExporter())
    .register('csv', () => new CsvExporter())
    .register('json', () => new JsonExporter());
}

/** When a subclass exists only to override one method, a function will do. */
export type WriterFactory = () => DocumentWriter;

export function exporterFrom(makeWriter: WriterFactory): Exporter {
  return new (class extends Exporter {
    protected override createWriter(): DocumentWriter {
      return makeWriter();
    }
  })();
}
