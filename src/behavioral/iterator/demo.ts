import {
  CategoryTree,
  FakeOrdersApi,
  collect,
  filterAsync,
  mapAsync,
  paginate,
  sampleCategories,
  sampleOrders,
  takeAsync,
} from './iterator';

const api = new FakeOrdersApi(sampleOrders(1_000), 25);

console.log('\n1. A cursor-paginated API behind for await...of');
const orders = paginate(api.fetchPage);
console.log(`   iterator created, API calls so far: ${api.calls}`);
let revenueMinor = 0;
let count = 0;
for await (const order of orders) {
  if (order.status === 'paid') revenueMinor += order.totalMinor;
  if (++count === 60) break; // e.g. a preview export of the first 60 orders
}
console.log(`   read ${count} orders, paid revenue Rs ${revenueMinor / 100}, API calls: ${api.calls} of 40 pages`);

console.log('\n2. A lazy pipeline: first 3 paid orders over Rs 500');
const before = api.calls;
const firstThree = await collect(
  takeAsync(
    mapAsync(
      filterAsync(paginate(api.fetchPage), (o) => o.status === 'paid' && o.totalMinor > 50_000),
      (o) => `${o.id} Rs ${o.totalMinor / 100}`,
    ),
    3,
  ),
);
console.log('  ', firstThree.join(' | '));
console.log(`   API calls for this pipeline: ${api.calls - before}`);

const tree = new CategoryTree(sampleCategories());
console.log('\n3. Category tree, depth-first (menu rendering):');
for (const visit of tree) console.log(`   ${'  '.repeat(visit.depth)}- ${visit.node.name}`);

console.log('\n4. Same tree, breadth-first (one level at a time, e.g. for a mega-menu):');
let level = -1;
const rows: string[] = [];
for (const visit of tree.breadthFirst()) {
  if (visit.depth !== level) rows.push(`   level ${(level = visit.depth)}:`);
  rows[rows.length - 1] += ` ${visit.node.name};`;
}
console.log(rows.join('\n'));

console.log('\n5. find() stops early:', tree.find((v) => v.node.name === 'Mugs')?.path.join(' > '));
console.log();
