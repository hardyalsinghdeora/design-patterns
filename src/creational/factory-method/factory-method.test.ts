import { describe, expect, it } from 'vitest';
import {
  CsvExporter,
  Exporter,
  ExporterFactory,
  JsonExporter,
  PdfExporter,
  UnknownFormatError,
  createDefaultExporterFactory,
  exporterFrom,
  formatMinor,
  lineTotalMinor,
  type DocumentWriter,
  type InvoiceData,
  type InvoiceLine,
} from './factory-method';

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

/** A format the library has never heard of, written entirely in this test file. */
class MarkdownWriter implements DocumentWriter {
  readonly contentType = 'text/markdown';
  readonly extension = 'md';
  private readonly rows: string[] = [];
  header(inv: InvoiceData): void {
    this.rows.push(`# Invoice ${inv.number}`);
  }
  line(line: InvoiceLine): void {
    this.rows.push(`- ${line.description}: ${formatMinor(lineTotalMinor(line))}`);
  }
  footer(totalMinor: number): void {
    this.rows.push(`**Total:** ${formatMinor(totalMinor)}`);
  }
  finish(): string {
    return this.rows.join('\n');
  }
}

class MarkdownExporter extends Exporter {
  protected override createWriter(): DocumentWriter {
    return new MarkdownWriter();
  }
}

describe('concrete creators', () => {
  it('PDF exporter lays out lines with a right-aligned total inside the page width', () => {
    const file = new PdfExporter().export(invoice);
    const lines = file.body.split('\n');
    expect(file.filename).toBe('INV-2026-0042.pdf.txt');
    expect(lines[0]).toBe('INVOICE INV-2026-0042');
    expect(lines.find((l) => l.startsWith('3 x'))).toMatch(/^3 x Extra seat "analyst" +1497\.00$/);
    expect(lines.at(-1)).toMatch(/^TOTAL INR\s+6496\.00$/);
    expect(lines.every((l) => l.length <= 44)).toBe(true);
  });

  it('CSV exporter escapes commas and quotes and adds no totals row', () => {
    const file = new CsvExporter().export(invoice);
    expect(file.contentType).toBe('text/csv');
    expect(file.body.split('\r\n')).toEqual([
      'invoice,sku,description,quantity,unit_price_minor,line_total_minor',
      'INV-2026-0042,PLAN-PRO,"Pro plan, November",1,499900,499900',
      'INV-2026-0042,SEAT,"Extra seat ""analyst""",3,49900,149700',
      '',
    ]);
  });

  it('JSON exporter emits a parseable document with integer totals', () => {
    const file = new JsonExporter().export(invoice);
    const doc = JSON.parse(file.body) as { totalMinor: number; lines: Array<{ totalMinor: number }> };
    expect(file.filename).toBe('INV-2026-0042.json');
    expect(doc.totalMinor).toBe(649_600);
    expect(doc.lines.map((l) => l.totalMinor)).toEqual([499_900, 149_700]);
  });

  it('creates a fresh writer per export, so repeated exports do not accumulate', () => {
    const exporter = new PdfExporter();
    expect(exporter.export(invoice).body).toBe(exporter.export(invoice).body);
  });

  it('refuses an invoice with no lines before creating any writer', () => {
    expect(() => new CsvExporter().export({ ...invoice, lines: [] })).toThrow(/no lines/);
  });
});

describe('extending and isolating', () => {
  it('adds a format without editing any existing exporter', () => {
    const factory = createDefaultExporterFactory().register('md', () => new MarkdownExporter());
    const file = factory.create('MD').export(invoice);
    expect(factory.formats()).toEqual(['csv', 'json', 'md', 'pdf']);
    expect(file.body).toBe('# Invoice INV-2026-0042\n- Pro plan, November: 4999.00\n- Extra seat "analyst": 1497.00\n**Total:** 6496.00');
  });

  it('reports an unknown format with the formats that do exist', () => {
    const factory = createDefaultExporterFactory();
    expect(() => factory.create('xlsx')).toThrow(UnknownFormatError);
    expect(() => factory.create('xlsx')).toThrow('Known formats: csv, json, pdf');
  });

  it('rejects duplicate registrations instead of silently replacing them', () => {
    const factory = new ExporterFactory().register('csv', () => new CsvExporter());
    expect(() => factory.register('CSV', () => new JsonExporter())).toThrow(/already registered/);
  });

  it('the shared algorithm can be tested with a recording writer via the functional form', () => {
    const calls: string[] = [];
    const recorder: DocumentWriter = {
      contentType: 'text/plain',
      extension: 'log',
      header: (inv) => calls.push(`header:${inv.number}`),
      line: (l) => calls.push(`line:${l.sku}`),
      footer: (total) => calls.push(`footer:${total}`),
      finish: () => calls.join('|'),
    };
    const file = exporterFrom(() => recorder).export(invoice);
    expect(file.body).toBe('header:INV-2026-0042|line:PLAN-PRO|line:SEAT|footer:649600');
    expect(file.filename).toBe('INV-2026-0042.log');
  });
});
