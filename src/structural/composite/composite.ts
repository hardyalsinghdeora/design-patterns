/**
 * COMPOSITE
 * Compose objects into trees and let clients treat one item and a group of
 * items the same way: a Bundle prices, weighs and describes itself like a Product.
 *
 * Example domain: order line items where a kit (bundle) contains products or
 * other kits. Amounts are integers in minor units (paise), weights in grams.
 */

export interface PickLine {
  product: Product;
  quantity: number;
}

/** The component: everything the order, the warehouse and the invoice need. */
export interface CatalogItem {
  readonly sku: string;
  readonly name: string;
  price(): number;
  weightGrams(): number;
  describe(depth?: number): string[];
  /** True if `item` is this node or anywhere beneath it. Used to refuse cycles. */
  contains(item: CatalogItem): boolean;
  /** The physical products under this node, with quantities multiplied out. */
  leaves(multiplier?: number): Generator<PickLine>;
}

export function formatMinor(amountMinor: number): string {
  return `Rs ${Math.trunc(amountMinor / 100)}.${String(Math.abs(amountMinor % 100)).padStart(2, '0')}`;
}

const assertWhole = (value: number, what: string): void => {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative integer, got ${value}`);
};

/** The leaf. */
export class Product implements CatalogItem {
  constructor(
    readonly sku: string,
    readonly name: string,
    private readonly priceMinor: number,
    private readonly grams: number,
  ) {
    assertWhole(priceMinor, 'price');
    assertWhole(grams, 'weight');
  }

  price(): number {
    return this.priceMinor;
  }

  weightGrams(): number {
    return this.grams;
  }

  describe(depth = 0): string[] {
    return [`${'  '.repeat(depth)}${this.sku} ${this.name} ${formatMinor(this.priceMinor)}`];
  }

  contains(item: CatalogItem): boolean {
    return item === this;
  }

  *leaves(multiplier = 1): Generator<PickLine> {
    yield { product: this, quantity: multiplier };
  }
}

export class CycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleError';
  }
}

export interface BundleOptions {
  /** Kit discount on the sum of the children, in basis points (1000 = 10 %). */
  discountBps?: number;
  /** The kit's own box and filler. */
  packagingGrams?: number;
}

/** The composite: holds children of the component type, leaves or other bundles. */
export class Bundle implements CatalogItem {
  private readonly children: Array<{ item: CatalogItem; quantity: number }> = [];
  private readonly discountBps: number;
  private readonly packagingGrams: number;

  constructor(
    readonly sku: string,
    readonly name: string,
    options: BundleOptions = {},
  ) {
    this.discountBps = options.discountBps ?? 0;
    this.packagingGrams = options.packagingGrams ?? 0;
    assertWhole(this.discountBps, 'discountBps');
    assertWhole(this.packagingGrams, 'packagingGrams');
    if (this.discountBps > 10_000) throw new RangeError('discount cannot exceed 100 %');
  }

  add(item: CatalogItem, quantity = 1): this {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError('quantity must be a positive integer');
    // A kit inside itself would make price() recurse forever. Sharing a product
    // between two kits is fine (that is a DAG); only a path back to `this` is refused.
    if (item.contains(this)) throw new CycleError(`adding ${item.sku} to ${this.sku} would create a cycle`);
    this.children.push({ item, quantity });
    return this;
  }

  remove(sku: string): boolean {
    const index = this.children.findIndex((c) => c.item.sku === sku);
    if (index === -1) return false;
    this.children.splice(index, 1);
    return true;
  }

  get size(): number {
    return this.children.length;
  }

  /** Sum of the children before this kit's discount. */
  listPrice(): number {
    return this.children.reduce((sum, c) => sum + c.item.price() * c.quantity, 0);
  }

  price(): number {
    const list = this.listPrice();
    return list - Math.round((list * this.discountBps) / 10_000);
  }

  weightGrams(): number {
    return this.children.reduce((sum, c) => sum + c.item.weightGrams() * c.quantity, this.packagingGrams);
  }

  describe(depth = 0): string[] {
    const pad = '  '.repeat(depth);
    const discount = this.discountBps ? ` (-${this.discountBps / 100}% of ${formatMinor(this.listPrice())})` : '';
    const lines = [`${pad}${this.sku} ${this.name} ${formatMinor(this.price())}${discount}`];
    for (const { item, quantity } of this.children) {
      const [first = '', ...rest] = item.describe(depth + 1);
      lines.push(quantity > 1 ? first.replace(/^(\s*)/, `$1${quantity} x `) : first, ...rest);
    }
    return lines;
  }

  contains(item: CatalogItem): boolean {
    return item === this || this.children.some((c) => c.item.contains(item));
  }

  *leaves(multiplier = 1): Generator<PickLine> {
    for (const c of this.children) yield* c.item.leaves(multiplier * c.quantity);
  }
}

/* ------------------------------------------------------------------------ */
/* The client: an order. It never asks "is this a bundle?".                  */
/* ------------------------------------------------------------------------ */

export class Order {
  private readonly lines: Array<{ item: CatalogItem; quantity: number }> = [];

  constructor(
    readonly orderId: string,
    /** Courier rate per started kilogram. */
    private readonly ratePerKgMinor = 4_000,
  ) {}

  add(item: CatalogItem, quantity = 1): this {
    this.lines.push({ item, quantity });
    return this;
  }

  subtotal(): number {
    return this.lines.reduce((sum, l) => sum + l.item.price() * l.quantity, 0);
  }

  weightGrams(): number {
    return this.lines.reduce((sum, l) => sum + l.item.weightGrams() * l.quantity, 0);
  }

  shippingMinor(): number {
    return Math.ceil(this.weightGrams() / 1_000) * this.ratePerKgMinor;
  }

  total(): number {
    return this.subtotal() + this.shippingMinor();
  }

  /** What the warehouse picks: every product, aggregated by SKU across all kits. */
  pickingList(): Map<string, number> {
    const picks = new Map<string, number>();
    for (const line of this.lines) {
      for (const { product, quantity } of line.item.leaves(line.quantity)) {
        picks.set(product.sku, (picks.get(product.sku) ?? 0) + quantity);
      }
    }
    return picks;
  }

  invoiceLines(): string[] {
    return this.lines.flatMap((l) => (l.quantity > 1 ? [`${l.quantity} x`, ...l.item.describe(1)] : l.item.describe()));
  }
}

/* ------------------------------------------------------------------------ */
/* Idiomatic TypeScript: the same tree as plain data with a discriminated    */
/* union, and recursive functions instead of methods. Natural for a catalog  */
/* served as JSON; the class form is better when nodes carry behaviour.      */
/* ------------------------------------------------------------------------ */

export type ItemNode =
  | { kind: 'product'; sku: string; priceMinor: number; grams: number }
  | {
      kind: 'bundle';
      sku: string;
      discountBps: number;
      packagingGrams: number;
      children: Array<{ node: ItemNode; quantity: number }>;
    };

export function priceOf(node: ItemNode): number {
  switch (node.kind) {
    case 'product':
      return node.priceMinor;
    case 'bundle': {
      const list = node.children.reduce((sum, c) => sum + priceOf(c.node) * c.quantity, 0);
      return list - Math.round((list * node.discountBps) / 10_000);
    }
  }
}

export function weightOf(node: ItemNode): number {
  switch (node.kind) {
    case 'product':
      return node.grams;
    case 'bundle':
      return node.children.reduce((sum, c) => sum + weightOf(c.node) * c.quantity, node.packagingGrams);
  }
}
