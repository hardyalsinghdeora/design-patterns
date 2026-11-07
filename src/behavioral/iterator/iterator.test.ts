import { describe, expect, it } from 'vitest';
import {
  CategoryTree,
  FakeOrdersApi,
  PaginatedIterator,
  collect,
  filter,
  filterAsync,
  map,
  mapAsync,
  paginate,
  sampleCategories,
  sampleOrders,
  takeAsync,
} from './iterator';

const names = (visits: Iterable<{ node: { name: string } }>) => [...visits].map((v) => v.node.name);
const DFS = ['Catalog', 'Beverages', 'Tea', 'Green Tea', 'Masala Chai', 'Coffee', 'Kitchen', 'Mugs', 'Kettles', 'Gifts'];
const BFS = ['Catalog', 'Beverages', 'Kitchen', 'Gifts', 'Tea', 'Coffee', 'Mugs', 'Kettles', 'Green Tea', 'Masala Chai'];

describe('paginated API as an async iterator', () => {
  it('fetches pages only as items are consumed', async () => {
    const api = new FakeOrdersApi(sampleOrders(23), 5);
    const orders = paginate(api.fetchPage);
    expect(api.calls).toBe(0); // creating the iterator fetches nothing

    for (let i = 0; i < 5; i++) await orders.next();
    expect(api.calls).toBe(1);
    await orders.next();
    expect(api.calls).toBe(2);
  });

  it('yields every item across pages, following the cursor until it is null', async () => {
    const api = new FakeOrdersApi(sampleOrders(23), 5);
    const all = await collect(paginate(api.fetchPage));
    expect(all.map((o) => o.id)).toEqual(sampleOrders(23).map((o) => o.id));
    expect(api.calls).toBe(5);
    expect(api.cursorsSeen[0]).toBeNull();
    expect(new Set(api.cursorsSeen).size).toBe(5);
  });

  it('stops fetching when the consumer breaks out early', async () => {
    const api = new FakeOrdersApi(sampleOrders(100), 5);
    let seen = 0;
    for await (const _order of paginate(api.fetchPage)) {
      if (++seen === 7) break;
    }
    expect(api.calls).toBe(2);
  });

  it('classic iterator class behaves like the generator, including return() on break', async () => {
    const api = new FakeOrdersApi(sampleOrders(23), 5);
    expect(await collect(new PaginatedIterator(api.fetchPage))).toEqual(sampleOrders(23));

    const early = new FakeOrdersApi(sampleOrders(23), 5);
    const iterator = new PaginatedIterator(early.fetchPage);
    for await (const order of iterator) if (order.id === 'ord_002') break;
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(early.calls).toBe(1);
  });

  it('runs a lazy filter/map/take pipeline that fetches only what it needs', async () => {
    const api = new FakeOrdersApi(sampleOrders(100), 5);
    const paid = filterAsync(paginate(api.fetchPage), (o) => o.status === 'paid');
    const firstThree = await collect(takeAsync(mapAsync(paid, (o) => `${o.id}:${o.totalMinor}`), 3));
    expect(firstThree).toEqual(['ord_001:11000', 'ord_004:14000', 'ord_007:17000']);
    expect(api.calls).toBe(2); // 100 orders exist, but only 10 were ever requested
  });
});

describe('category tree iterators', () => {
  it('walks depth-first (pre-order) with both the generator and the classic iterator', () => {
    const tree = new CategoryTree(sampleCategories());
    expect(names(tree)).toEqual(DFS); // Symbol.iterator defaults to depth-first
    expect(names(tree.depthFirst())).toEqual(DFS);
    expect(names(tree.depthFirstIterator())).toEqual(DFS);
  });

  it('walks breadth-first, level by level, with depth and breadcrumb', () => {
    const tree = new CategoryTree(sampleCategories());
    expect(names(tree.breadthFirst())).toEqual(BFS);
    expect(names(tree.breadthFirstIterator())).toEqual(BFS);
    expect([...tree.breadthFirst()].map((v) => v.depth)).toEqual([0, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
    expect(tree.find((v) => v.node.id === 'c112')?.path).toEqual(['Catalog', 'Beverages', 'Tea', 'Masala Chai']);
  });

  it('gives every loop its own cursor, and sync pipelines compose over any order', () => {
    const tree = new CategoryTree(sampleCategories());
    const a = tree[Symbol.iterator]();
    const b = tree[Symbol.iterator]();
    a.next();
    a.next();
    expect(b.next().value?.node.name).toBe('Catalog');
    expect(a.next().value?.node.name).toBe('Tea');

    const leaves = map(
      filter(tree.breadthFirst(), (v) => v.node.children.length === 0),
      (v) => v.path.join(' > '),
    );
    expect([...leaves]).toEqual([
      'Catalog > Gifts',
      'Catalog > Beverages > Coffee',
      'Catalog > Kitchen > Mugs',
      'Catalog > Kitchen > Kettles',
      'Catalog > Beverages > Tea > Green Tea',
      'Catalog > Beverages > Tea > Masala Chai',
    ]);
  });
});
