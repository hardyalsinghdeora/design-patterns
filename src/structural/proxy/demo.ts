import { DatabaseCatalog, buildCatalog, validatedDraft, withCallLog, type CallRecord, type ProductCatalog } from './proxy';

let now = 1_700_000_000_000; // a manual clock, so the demo is deterministic
const clock = () => now;
let loads = 0;
const db = new DatabaseCatalog([
  { id: 'p1', name: 'Assam Tea 250g', priceMinor: 34_900, stock: 12 },
  { id: 'p2', name: 'Steel Kettle', priceMinor: 1_49_900, stock: 3 },
]);

const stack = (roles: Array<'viewer' | 'merchandiser'>): ProductCatalog =>
  buildCatalog({
    load: async () => {
      loads += 1;
      return db;
    },
    principal: { userId: `u_${roles[0]}`, roles },
    clock,
    cacheTtlMs: 30_000,
    rateLimit: { limit: 5, windowMs: 1_000 },
  });

const shopper = stack(['viewer']);
console.log('\nProxy stack built: RateLimit -> AccessControl -> Cache -> Lazy -> Database');
console.log(`  database loaded yet? ${loads > 0 ? 'yes' : 'no'}`);

for (let i = 0; i < 4; i++) await shopper.getProduct('p1');
console.log(`  4 reads of p1 -> loads ${loads}, database queries ${db.queries} (3 cache hits)`);

const tryCall = async (label: string, call: () => Promise<unknown>) => {
  try {
    await call();
    console.log(`  ${label}: ok`);
  } catch (error) {
    console.log(`  ${label}: ${(error as Error).name}: ${(error as Error).message}`);
  }
};

console.log('\nAccess control and rate limiting, same interface:');
await tryCall('viewer changes a price', () => shopper.updatePrice('p1', 100));
await tryCall('6th call in 1s window  ', () => shopper.search('tea'));
now += 1_000;
await tryCall('next window             ', () => shopper.search('tea'));

console.log('\nCache TTL: 31 s later the next read goes to the database again');
const before = db.queries;
now += 31_000;
await shopper.getProduct('p1');
console.log(`  queries ${before} -> ${db.queries}`);

console.log('\nJavaScript Proxy object: one get trap logs every method, one set trap validates');
const log: CallRecord[] = [];
const logged = withCallLog(db, log);
await logged.getProduct('p2');
await logged.search('kettle');
console.log('  call log:', log.map((r) => `${r.method}(${r.args.join(', ')})`).join(', '));
const draft = validatedDraft({ name: 'Clay Cup', priceMinor: 9_900, stock: 10 });
try {
  draft.priceMinor = 99.5;
} catch (error) {
  console.log('  draft.priceMinor = 99.5 ->', (error as Error).message);
}
console.log();
