import { describe, expect, it } from 'vitest';
import { ListingCatalog, ListingTable, ProductTypeFactory, StringInterner, categoryTag, type ProductTypeSpec } from './flyweight';

const BRANDS = ['Assam Gold', 'Nilgiri Leaf', 'Darjeeling Co'];
const CATEGORIES = ['Tea', 'Coffee'];
const SIZES = ['100g', '250g', '500g', '1kg'];

/** i % 3, i % 2 and i % 4 cycle through exactly 12 distinct (brand, category, size) combinations. */
const specFor = (i: number): ProductTypeSpec => ({
  brand: BRANDS[i % 3] ?? '',
  category: CATEGORIES[i % 2] ?? '',
  attributes: { size: SIZES[i % 4] ?? '', pack: 'pouch' },
});

describe('ProductTypeFactory', () => {
  it('returns the same instance for the same key, whatever the case or attribute order', () => {
    const factory = new ProductTypeFactory();
    const a = factory.get({ brand: 'Assam Gold', category: 'Tea', attributes: { size: '250g', pack: 'pouch' } });
    const b = factory.get({ brand: ' assam gold', category: 'TEA', attributes: { pack: 'Pouch', size: '250G' } });
    const c = factory.get({ brand: 'Assam Gold', category: 'Tea', attributes: { size: '500g', pack: 'pouch' } });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(factory.stats).toEqual({ flyweights: 2, hits: 1, misses: 2 });
  });

  it('shares icons per category, a second level of sharing', () => {
    const factory = new ProductTypeFactory();
    const tea = factory.get(specFor(0));
    const otherTea = factory.get(specFor(2));
    const coffee = factory.get(specFor(1));
    expect(otherTea).not.toBe(tea);
    expect(otherTea.iconSvg).toBe(tea.iconSvg);
    expect(coffee.iconSvg).not.toBe(tea.iconSvg);
    expect(factory.iconCount).toBe(2);
  });

  it('hands out immutable flyweights, because a change would hit every listing that shares one', () => {
    const type = new ProductTypeFactory().get(specFor(0));
    expect(Object.isFrozen(type)).toBe(true);
    expect(() => Object.assign(type, { brand: 'Fake Brand' })).toThrow(TypeError);
    expect(() => Object.assign(type.attributes, { size: '5kg' })).toThrow(TypeError);
  });
});

describe('ListingCatalog', () => {
  it('holds many listings on few flyweights', () => {
    const catalog = new ListingCatalog();
    for (let i = 0; i < 20_000; i++) {
      catalog.add(`lst_${i}`, specFor(i), { priceMinor: 10_000 + (i % 500), stock: i % 7, sellerId: `seller_${i % 250}` });
    }
    const stats = catalog.stats();
    expect(stats.listings).toBe(20_000);
    expect(stats.flyweights).toBe(12);
    expect(stats.unsharedIntrinsicBytes / stats.sharedIntrinsicBytes).toBeGreaterThan(1_000);
  });

  it('keeps extrinsic state independent per listing even when the flyweight is shared', () => {
    const catalog = new ListingCatalog();
    const first = catalog.add('lst_1', specFor(0), { priceMinor: 34_900, stock: 10, sellerId: 'chai-house' });
    const second = catalog.add('lst_2', specFor(0), { priceMinor: 32_500, stock: 0, sellerId: 'tea-mart' });
    expect(second.type).toBe(first.type);

    first.priceMinor = 29_900;
    first.stock -= 1;
    expect(second.priceMinor).toBe(32_500);
    expect(first.render()).toBe('Assam Gold Tea (pack: pouch, size: 100g) | Rs 299.00 | 9 in stock | sold by chai-house');
    expect(second.render()).toBe('Assam Gold Tea (pack: pouch, size: 100g) | Rs 325.00 | out of stock | sold by tea-mart');
  });
});

describe('columnar form and interning', () => {
  it('stores listings as typed-array rows pointing at shared flyweights', () => {
    const factory = new ProductTypeFactory();
    const table = new ListingTable(factory, 16);
    for (let i = 0; i < 50_000; i++) table.add(specFor(i), { priceMinor: 9_900 + i, stock: 3, sellerId: `seller_${i % 10}` });

    expect(table.length).toBe(50_000);
    expect(table.capacity).toBeGreaterThanOrEqual(50_000);
    expect(factory.size).toBe(12);
    expect(table.typeOf(12)).toBe(table.typeOf(0));

    table.setPrice(12, 1);
    expect(table.stateOf(12).priceMinor).toBe(1);
    expect(table.stateOf(0)).toEqual({ priceMinor: 9_900, stock: 3, sellerId: 'seller_0' });
    expect(() => table.stateOf(50_000)).toThrow(RangeError);
  });

  it('interns runtime strings and symbols to one shared value per key', () => {
    const interner = new StringInterner();
    const ids = Array.from({ length: 1_000 }, (_, i) => interner.intern(['seller', String(i % 3)].join('_')));
    expect(interner.size).toBe(3);
    expect(ids[0]).toBe(ids[3]);

    expect(categoryTag('Tea')).toBe(categoryTag(' tea '));
    expect(categoryTag('Tea')).toBe(Symbol.for('catalog.category:tea'));
    expect(categoryTag('Tea')).not.toBe(Symbol('catalog.category:tea')); // Symbol() never shares
  });
});
