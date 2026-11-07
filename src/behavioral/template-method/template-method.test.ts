import { describe, expect, it } from 'vitest';
import {
  CsvProductImport,
  CsvSalesReport,
  type ImportStep,
  ImportJob,
  InMemoryProductRepository,
  JsonProductImport,
  MarkdownSalesReport,
  type ProductRow,
  csvRecordToProduct,
  defineImport,
  parseCsv,
  parseMoney,
} from './template-method';

const csv = `sku,name,price
mug-01,Coffee mug,249.00
TEE-02,T-shirt,599.5
bad sku,Broken,10.00
CAP-03,Cap,12.345`;

describe('ImportJob (template method)', () => {
  it('runs the steps in a fixed order, whatever the subclass', () => {
    const calls: ImportStep[] = [];
    class RecordingImport extends ImportJob<string> {
      protected extract(input: string): string[] {
        calls.push('extract');
        return input.split(';');
      }
      protected transform(raw: string): ProductRow {
        calls.push('transform');
        return { sku: raw, name: raw, priceMinor: 100 };
      }
      protected override validate(row: ProductRow): string[] {
        calls.push('validate');
        return super.validate(row);
      }
      protected override beforeLoad(rows: ProductRow[]): ProductRow[] {
        calls.push('beforeLoad');
        return rows;
      }
      protected override load(rows: readonly ProductRow[]): number {
        calls.push('load');
        return super.load(rows);
      }
      protected override afterLoad(): void {
        calls.push('afterLoad');
      }
    }
    const report = new RecordingImport('test', new InMemoryProductRepository()).run('AAA;BBB');
    expect(calls).toEqual(['extract', 'transform', 'transform', 'validate', 'validate', 'beforeLoad', 'load', 'afterLoad']);
    expect(report.steps).toEqual(['extract', 'transform', 'validate', 'beforeLoad', 'load', 'afterLoad']);
  });

  it('CSV import converts prices to minor units and rejects bad records by number', () => {
    const repo = new InMemoryProductRepository();
    const report = new CsvProductImport('catalogue.csv', repo).run(csv);
    expect(report).toMatchObject({ extracted: 4, loaded: 2 });
    expect(report.rejected).toEqual([
      { record: 3, errors: ['invalid sku "BAD SKU"'] },
      { record: 4, errors: ['"12.345" is not a price like 249.00'] },
    ]);
    expect(repo.rows.get('MUG-01')).toEqual({ sku: 'MUG-01', name: 'Coffee mug', priceMinor: 24_900 });
    expect(repo.rows.get('TEE-02')?.priceMinor).toBe(59_950);
  });

  it('hooks are optional: CSV uses the defaults, JSON overrides both', () => {
    const audit: string[] = [];
    const repo = new InMemoryProductRepository();
    const json = JSON.stringify([
      { sku: 'MUG-01', title: 'Mug', price_minor: 24_900 },
      { sku: 'MUG-01', title: 'Mug (new photo)', price_minor: 22_900 },
      { sku: 'TEE-02', title: 'Tee' },
    ]);
    const report = new JsonProductImport('partner-feed', repo, (e) => audit.push(e)).run(json);
    expect(report.loaded).toBe(1); // duplicate collapsed by beforeLoad
    expect(repo.rows.get('MUG-01')?.name).toBe('Mug (new photo)');
    expect(audit).toEqual(['partner-feed: loaded 1 of 3, rejected 1']);
  });

  it('subclasses override only their own steps; validation and loading are shared', () => {
    const own = (cls: object) => Object.getOwnPropertyNames(cls).filter((n) => n !== 'constructor').sort();
    expect(own(CsvProductImport.prototype)).toEqual(['extract', 'transform']);
    expect(own(JsonProductImport.prototype)).toEqual(['afterLoad', 'beforeLoad', 'extract', 'transform']);

    const fromCsv = new InMemoryProductRepository();
    const fromJson = new InMemoryProductRepository();
    new CsvProductImport('a', fromCsv).run('sku,name,price\nMUG-01,Mug,249');
    new JsonProductImport('b', fromJson, () => undefined).run('[{"sku":"MUG-01","title":"Mug","price_minor":24900}]');
    expect([...fromCsv.rows]).toEqual([...fromJson.rows]);
  });

  it('the functional form produces the same report as the class form', () => {
    const classic = new CsvProductImport('catalogue.csv', new InMemoryProductRepository());
    const functional = defineImport('catalogue.csv', { extract: parseCsv, transform: csvRecordToProduct }, new InMemoryProductRepository());
    expect(functional(csv)).toEqual(classic.run(csv));
  });

  it('parses money as text, never as a float', () => {
    expect(parseMoney('0.29')).toBe(29);
    expect(parseMoney('1000')).toBe(1_00_000);
    expect(() => parseMoney('-5')).toThrow();
  });
});

describe('SalesReport (template method)', () => {
  const lines = [
    { region: 'North', orders: 120, revenueMinor: 3_45_000_00 },
    { region: 'South', orders: 80, revenueMinor: 2_10_050_25 },
  ];

  it('same skeleton, different steps; the footer hook is used only by Markdown', () => {
    expect(new CsvSalesReport().render('Q1', lines)).toBe('region,orders,revenue_minor\nNorth,120,34500000\nSouth,80,21005025');
    const md = new MarkdownSalesReport().render('Q1 sales', lines).split('\n');
    expect(md[0]).toBe('## Q1 sales');
    expect(md.at(-1)).toBe('| **Total** | **200** | **Rs 5,55,050.25** |');
  });
});
