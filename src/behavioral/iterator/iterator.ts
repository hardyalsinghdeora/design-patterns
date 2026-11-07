/**
 * ITERATOR
 * Walk a collection one element at a time without exposing how it is stored or fetched, so the
 * same `for...of` / `for await...of` loop works over a page-by-page API, a tree, or a pipeline.
 *
 * Example domain: exporting orders from a cursor-paginated API, and walking a category tree.
 * Amounts are integers in minor units (paise). The fetch function is injected; nothing does real I/O.
 */

/* ------------------------------------------------------------------------ */
/* 1. A paginated API as an async iterator                                   */
/* ------------------------------------------------------------------------ */

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page, or null on the last page. */
  readonly nextCursor: string | null;
}

export type FetchPage<T> = (cursor: string | null) => Promise<Page<T>>;

/**
 * Classic form: an explicit iterator object with next() and return(). This is what the
 * generator below compiles to, and what the class diagram shows.
 */
export class PaginatedIterator<T> implements AsyncIterableIterator<T> {
  private items: readonly T[] = [];
  private position = 0;
  private cursor: string | null = null;
  private finished = false;

  constructor(private readonly fetchPage: FetchPage<T>) {}

  async next(): Promise<IteratorResult<T, undefined>> {
    while (this.position >= this.items.length) {
      if (this.finished) return { done: true, value: undefined };
      const page = await this.fetchPage(this.cursor); // fetch only when the buffer runs dry
      this.items = page.items;
      this.position = 0;
      this.cursor = page.nextCursor;
      if (page.nextCursor === null) this.finished = true;
    }
    return { done: false, value: this.items[this.position++] as T };
  }

  /** Called by `for await` on break, return or throw: stop, and never fetch again. */
  async return(): Promise<IteratorResult<T, undefined>> {
    this.finished = true;
    this.items = [];
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

/** Idiomatic form: an async generator. Laziness and early-exit cleanup come for free. */
export async function* paginate<T>(fetchPage: FetchPage<T>): AsyncGenerator<T, void, undefined> {
  let cursor: string | null = null;
  do {
    const page: Page<T> = await fetchPage(cursor);
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor !== null);
}

export type OrderStatus = 'paid' | 'pending' | 'refunded';

export interface Order {
  readonly id: string;
  readonly status: OrderStatus;
  readonly totalMinor: number;
}

/** A stand-in for GET /orders?cursor=..., counting calls so tests can prove laziness. */
export class FakeOrdersApi {
  private callCount = 0;
  readonly cursorsSeen: Array<string | null> = [];

  constructor(private readonly orders: readonly Order[], private readonly pageSize: number) {}

  get calls(): number {
    return this.callCount;
  }

  readonly fetchPage: FetchPage<Order> = async (cursor) => {
    this.callCount += 1;
    this.cursorsSeen.push(cursor);
    const offset = cursor === null ? 0 : Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    const end = offset + this.pageSize;
    const nextCursor = end < this.orders.length ? Buffer.from(String(end), 'utf8').toString('base64url') : null;
    return { items: this.orders.slice(offset, end), nextCursor };
  };
}

export function sampleOrders(count: number): Order[] {
  const statuses: readonly OrderStatus[] = ['refunded', 'paid', 'pending'];
  return Array.from({ length: count }, (_, i) => ({
    id: `ord_${String(i).padStart(3, '0')}`,
    status: statuses[i % 3] ?? 'pending',
    totalMinor: 10_000 + i * 1_000,
  }));
}

/* ------------------------------------------------------------------------ */
/* 2. Lazy pipelines. Each stage pulls one item at a time from the previous, */
/* so `take` stopping early stops the fetches upstream too.                  */
/* ------------------------------------------------------------------------ */

export async function* filterAsync<T>(source: AsyncIterable<T>, keep: (item: T) => boolean): AsyncGenerator<T, void, undefined> {
  for await (const item of source) if (keep(item)) yield item;
}

export async function* mapAsync<T, U>(source: AsyncIterable<T>, fn: (item: T) => U): AsyncGenerator<U, void, undefined> {
  for await (const item of source) yield fn(item);
}

export async function* takeAsync<T>(source: AsyncIterable<T>, count: number): AsyncGenerator<T, void, undefined> {
  if (count <= 0) return;
  let taken = 0;
  for await (const item of source) {
    yield item;
    if (++taken >= count) return; // leaving the loop calls source.return(), which closes the chain
  }
}

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

export function* filter<T>(source: Iterable<T>, keep: (item: T) => boolean): Generator<T, void, undefined> {
  for (const item of source) if (keep(item)) yield item;
}

export function* map<T, U>(source: Iterable<T>, fn: (item: T) => U): Generator<U, void, undefined> {
  for (const item of source) yield fn(item);
}

/* ------------------------------------------------------------------------ */
/* 3. A category tree with two traversal orders                              */
/* ------------------------------------------------------------------------ */

export interface CategoryNode {
  readonly id: string;
  readonly name: string;
  readonly children: readonly CategoryNode[];
}

export interface Visit {
  readonly node: CategoryNode;
  readonly depth: number;
  /** Breadcrumb from the root, e.g. ["Catalog", "Beverages", "Tea"]. */
  readonly path: readonly string[];
}

const visitOf = (node: CategoryNode, parent?: Visit): Visit => ({
  node,
  depth: parent ? parent.depth + 1 : 0,
  path: parent ? [...parent.path, node.name] : [node.name],
});

/** Classic depth-first (pre-order) iterator with an explicit stack: no recursion, no stack overflow. */
export class DepthFirstIterator implements IterableIterator<Visit> {
  private readonly stack: Visit[];

  constructor(root: CategoryNode) {
    this.stack = [visitOf(root)];
  }

  next(): IteratorResult<Visit, undefined> {
    const visit = this.stack.pop();
    if (!visit) return { done: true, value: undefined };
    // Push children in reverse so the first child is popped first.
    for (let i = visit.node.children.length - 1; i >= 0; i--) {
      const child = visit.node.children[i];
      if (child) this.stack.push(visitOf(child, visit));
    }
    return { done: false, value: visit };
  }

  [Symbol.iterator](): this {
    return this;
  }
}

/** Classic breadth-first iterator: a queue, consumed level by level. */
export class BreadthFirstIterator implements IterableIterator<Visit> {
  private readonly queue: Visit[];
  private head = 0; // an index instead of shift(), which is O(n) per call

  constructor(root: CategoryNode) {
    this.queue = [visitOf(root)];
  }

  next(): IteratorResult<Visit, undefined> {
    const visit = this.queue[this.head];
    if (!visit) return { done: true, value: undefined };
    this.head += 1;
    for (const child of visit.node.children) this.queue.push(visitOf(child, visit));
    return { done: false, value: visit };
  }

  [Symbol.iterator](): this {
    return this;
  }
}

/** The aggregate. `for (const v of tree)` walks depth-first; each loop gets a fresh iterator. */
export class CategoryTree implements Iterable<Visit> {
  constructor(readonly root: CategoryNode) {}

  [Symbol.iterator](): Iterator<Visit> {
    return this.depthFirst();
  }

  /** Generator form of depth-first: recursion with yield*. */
  *depthFirst(): Generator<Visit, void, undefined> {
    function* walk(visit: Visit): Generator<Visit, void, undefined> {
      yield visit;
      for (const child of visit.node.children) yield* walk(visitOf(child, visit));
    }
    yield* walk(visitOf(this.root));
  }

  /** Generator form of breadth-first. */
  *breadthFirst(): Generator<Visit, void, undefined> {
    const queue: Visit[] = [visitOf(this.root)];
    for (let head = 0; head < queue.length; head++) {
      const visit = queue[head];
      if (!visit) break;
      yield visit;
      for (const child of visit.node.children) queue.push(visitOf(child, visit));
    }
  }

  depthFirstIterator(): DepthFirstIterator {
    return new DepthFirstIterator(this.root);
  }

  breadthFirstIterator(): BreadthFirstIterator {
    return new BreadthFirstIterator(this.root);
  }

  /** Stops walking as soon as it finds a match: the rest of the tree is never visited. */
  find(predicate: (visit: Visit) => boolean): Visit | undefined {
    for (const visit of this) if (predicate(visit)) return visit;
    return undefined;
  }
}

const node = (id: string, name: string, children: CategoryNode[] = []): CategoryNode => ({ id, name, children });

export const sampleCategories = (): CategoryNode =>
  node('c0', 'Catalog', [
    node('c1', 'Beverages', [node('c11', 'Tea', [node('c111', 'Green Tea'), node('c112', 'Masala Chai')]), node('c12', 'Coffee')]),
    node('c2', 'Kitchen', [node('c21', 'Mugs'), node('c22', 'Kettles')]),
    node('c3', 'Gifts'),
  ]);
