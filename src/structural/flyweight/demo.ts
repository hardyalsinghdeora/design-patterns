import { ListingCatalog, ListingTable, ProductTypeFactory, categoryTag, type ProductTypeSpec } from './flyweight';

const BRANDS = ['Assam Gold', 'Nilgiri Leaf', 'Darjeeling Co', 'Blue Tokai', 'Bru'];
const CATEGORIES = ['Tea', 'Coffee', 'Green Tea'];
const SIZES = ['100g', '250g', '500g', '1kg'];
const PACKS = ['pouch', 'tin', 'box'];

/** A deterministic stand-in for a seller feed: a million rows, few distinct product types. */
const specFor = (i: number): ProductTypeSpec => ({
  brand: BRANDS[i % BRANDS.length] ?? '',
  category: CATEGORIES[(i >> 3) % CATEGORIES.length] ?? '',
  attributes: { size: SIZES[(i >> 5) % SIZES.length] ?? '', pack: PACKS[(i >> 7) % PACKS.length] ?? '' },
});
const stateFor = (i: number) => ({ priceMinor: 9_900 + ((i * 37) % 40_000), stock: i % 25, sellerId: `seller_${i % 4_000}` });

console.log('\n1. Object form: 100,000 listings, each a small Listing object');
const catalog = new ListingCatalog();
for (let i = 0; i < 100_000; i++) catalog.add(`lst_${i}`, specFor(i), stateFor(i));
const s = catalog.stats();
console.log(`   listings ${s.listings.toLocaleString('en-IN')}, flyweights ${s.flyweights}, icons ${catalog.factory.iconCount}`);
console.log(`   intrinsic state: ${(s.unsharedIntrinsicBytes / 1e6).toFixed(1)} MB if copied per listing, ${(s.sharedIntrinsicBytes / 1e3).toFixed(1)} KB shared`);
console.log('  ', catalog.get('lst_42')?.render());

console.log('\n2. Extrinsic state is per listing: reprice lst_0 only');
const a = catalog.get('lst_0');
const b = [...Array(1_000).keys()].map((i) => catalog.get(`lst_${i + 1}`)).find((l) => l?.type === a?.type);
if (a && b) {
  a.priceMinor = 1_00;
  console.log(`   same flyweight: ${a.type === b.type}; ${a.id} costs ${a.priceMinor}, ${b.id} still costs ${b.priceMinor}`);
}

console.log('\n3. Columnar form: 1,000,000 rows in typed arrays, no per-listing objects');
const factory = new ProductTypeFactory();
const table = new ListingTable(factory);
for (let i = 0; i < 1_000_000; i++) table.add(specFor(i), stateFor(i));
console.log(`   rows ${table.length.toLocaleString('en-IN')}, flyweights ${factory.size}, cache ${JSON.stringify(factory.stats)}`);
console.log(`   extrinsic columns: 4 x Uint32Array x ${table.capacity.toLocaleString('en-IN')} = ${((table.capacity * 16) / 1e6).toFixed(1)} MB`);
console.log('  ', table.render(999_999));

console.log('\n4. The runtime has a flyweight registry too: Symbol.for');
console.log('   Symbol.for key shared across modules:', categoryTag('Tea') === categoryTag('TEA'));
console.log('   Symbol() is always new             :', Symbol('tea') === Symbol('tea'));
console.log();
