/**
 * FLYWEIGHT
 * Share the heavy, immutable part of many similar objects (intrinsic state) through a factory,
 * and keep the per-object part (extrinsic state) outside, passed in when needed.
 *
 * Example domain: a marketplace catalogue with millions of listings. Thousands of sellers list
 * the same few hundred product types; brand, category, attributes and icon are identical, only
 * price, stock and seller differ. Amounts are integers in minor units (paise).
 */

export interface ProductTypeSpec {
  readonly brand: string;
  readonly category: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/** Extrinsic state: different for every listing, never stored inside the flyweight. */
export interface ListingState {
  readonly priceMinor: number;
  readonly stock: number;
  readonly sellerId: string;
}

/**
 * The flyweight. Immutable (frozen) because it is shared: if one listing could change
 * its brand, every listing of that type would change with it.
 */
export class ProductType {
  readonly attributes: Readonly<Record<string, string>>;

  constructor(
    readonly key: string,
    readonly brand: string,
    readonly category: string,
    attributes: Readonly<Record<string, string>>,
    /** An inline SVG icon: the kind of payload that makes duplication expensive. Shared per category. */
    readonly iconSvg: string,
  ) {
    this.attributes = Object.freeze({ ...attributes });
    Object.freeze(this);
  }

  title(): string {
    const attrs = Object.entries(this.attributes)
      .map(([name, value]) => `${name}: ${value}`)
      .join(', ');
    return `${this.brand} ${this.category} (${attrs})`;
  }

  /** Operations take the extrinsic state as a parameter instead of storing it. */
  render(state: ListingState): string {
    const price = `Rs ${(state.priceMinor / 100).toFixed(2)}`;
    const stock = state.stock > 0 ? `${state.stock} in stock` : 'out of stock';
    return `${this.title()} | ${price} | ${stock} | sold by ${state.sellerId}`;
  }

  /** Rough heap estimate (UTF-16, two bytes a character) used to show the saving. */
  get approxBytes(): number {
    let chars = this.key.length + this.brand.length + this.category.length + this.iconSvg.length;
    for (const [name, value] of Object.entries(this.attributes)) chars += name.length + value.length;
    return chars * 2;
  }
}

const normalise = (s: string): string => s.trim().toLowerCase();

/** Placeholder icon generator: in production this would be a CDN asset or a sprite. */
const iconFor = (category: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>${category}</title>` +
  `<path d="M3 3h18v18H3z" fill="none" stroke="currentColor"/>${'<circle cx="12" cy="12" r="4"/>'.repeat(8)}</svg>`;

/** The flyweight factory: the only way to get a ProductType, so equal specs share one instance. */
export class ProductTypeFactory {
  private readonly pool = new Map<string, ProductType>();
  private readonly icons = new Map<string, string>(); // a second, coarser level of sharing
  private hitCount = 0;
  private missCount = 0;

  /** Canonical key: case and attribute order must not create duplicates. */
  static keyOf(spec: ProductTypeSpec): string {
    const attrs = Object.entries(spec.attributes)
      .map(([name, value]) => `${normalise(name)}=${normalise(value)}`)
      .sort()
      .join(';');
    return `${normalise(spec.brand)}|${normalise(spec.category)}|${attrs}`;
  }

  get(spec: ProductTypeSpec): ProductType {
    const key = ProductTypeFactory.keyOf(spec);
    const existing = this.pool.get(key);
    if (existing) {
      this.hitCount += 1;
      return existing;
    }
    this.missCount += 1;
    const categoryKey = normalise(spec.category);
    let icon = this.icons.get(categoryKey);
    if (icon === undefined) {
      icon = iconFor(spec.category.trim());
      this.icons.set(categoryKey, icon);
    }
    const sortedAttributes = Object.fromEntries(Object.entries(spec.attributes).sort(([a], [b]) => a.localeCompare(b)));
    const created = new ProductType(key, spec.brand.trim(), spec.category.trim(), sortedAttributes, icon);
    this.pool.set(key, created);
    return created;
  }

  get size(): number {
    return this.pool.size;
  }

  get iconCount(): number {
    return this.icons.size;
  }

  get stats(): { readonly flyweights: number; readonly hits: number; readonly misses: number } {
    return { flyweights: this.pool.size, hits: this.hitCount, misses: this.missCount };
  }

  *types(): IterableIterator<ProductType> {
    yield* this.pool.values();
  }
}

/**
 * Interning by hand. JavaScript compares strings by value, so interning is about memory,
 * not equality: V8 internalizes literals and property names, but strings built at runtime
 * (concatenated, read from a socket or a file) are not guaranteed to be shared.
 */
export class StringInterner {
  private readonly pool = new Map<string, string>();

  intern(value: string): string {
    const existing = this.pool.get(value);
    if (existing !== undefined) return existing;
    this.pool.set(value, value);
    return value;
  }

  get size(): number {
    return this.pool.size;
  }
}

/** The context: one per listing, holding only extrinsic state plus a reference to its flyweight. */
export class Listing implements ListingState {
  constructor(
    readonly id: string,
    readonly type: ProductType,
    public priceMinor: number,
    public stock: number,
    readonly sellerId: string,
  ) {}

  render(): string {
    return this.type.render(this);
  }
}

export interface CatalogStats {
  readonly listings: number;
  readonly flyweights: number;
  /** Bytes of intrinsic state if every listing carried its own copy. */
  readonly unsharedIntrinsicBytes: number;
  /** Bytes of intrinsic state actually held, once, in the factory. */
  readonly sharedIntrinsicBytes: number;
}

/** The client: builds listings from raw specs, always through the factory. */
export class ListingCatalog {
  private readonly listings = new Map<string, Listing>();
  private readonly sellers = new StringInterner();

  constructor(readonly factory: ProductTypeFactory = new ProductTypeFactory()) {}

  add(id: string, spec: ProductTypeSpec, state: ListingState): Listing {
    const listing = new Listing(id, this.factory.get(spec), state.priceMinor, state.stock, this.sellers.intern(state.sellerId));
    this.listings.set(id, listing);
    return listing;
  }

  get(id: string): Listing | undefined {
    return this.listings.get(id);
  }

  stats(): CatalogStats {
    let unshared = 0;
    for (const listing of this.listings.values()) unshared += listing.type.approxBytes;
    let shared = 0;
    for (const type of this.factory.types()) shared += type.approxBytes;
    return {
      listings: this.listings.size,
      flyweights: this.factory.size,
      unsharedIntrinsicBytes: unshared,
      sharedIntrinsicBytes: shared,
    };
  }
}

/* ------------------------------------------------------------------------ */
/* At millions of rows, even one small object per listing is overhead. The   */
/* idiomatic JS answer is columnar: extrinsic state in typed arrays, a row   */
/* number instead of a Listing object, and an index into the flyweight table. */
/* ------------------------------------------------------------------------ */

export class ListingTable {
  private prices: Uint32Array;
  private stocks: Uint32Array;
  private typeIds: Uint32Array;
  private sellerIds: Uint32Array;
  private rows = 0;
  private readonly types: ProductType[] = [];
  private readonly typeIndex = new Map<ProductType, number>();
  private readonly sellerNames: string[] = [];
  private readonly sellerIndex = new Map<string, number>();

  constructor(private readonly factory: ProductTypeFactory, initialCapacity = 1_024) {
    this.prices = new Uint32Array(initialCapacity);
    this.stocks = new Uint32Array(initialCapacity);
    this.typeIds = new Uint32Array(initialCapacity);
    this.sellerIds = new Uint32Array(initialCapacity);
  }

  /** Returns the row number, which plays the role of the listing id. */
  add(spec: ProductTypeSpec, state: ListingState): number {
    if (this.rows === this.prices.length) this.grow();
    const type = this.factory.get(spec);
    let typeId = this.typeIndex.get(type);
    if (typeId === undefined) {
      typeId = this.types.push(type) - 1;
      this.typeIndex.set(type, typeId);
    }
    let sellerId = this.sellerIndex.get(state.sellerId);
    if (sellerId === undefined) {
      sellerId = this.sellerNames.push(state.sellerId) - 1;
      this.sellerIndex.set(state.sellerId, sellerId);
    }
    const row = this.rows++;
    this.prices[row] = state.priceMinor;
    this.stocks[row] = state.stock;
    this.typeIds[row] = typeId;
    this.sellerIds[row] = sellerId;
    return row;
  }

  typeOf(row: number): ProductType {
    const type = this.types[this.typeIds[this.check(row)] ?? -1];
    if (!type) throw new Error(`Corrupt row ${row}`);
    return type;
  }

  stateOf(row: number): ListingState {
    this.check(row);
    return { priceMinor: this.prices[row] ?? 0, stock: this.stocks[row] ?? 0, sellerId: this.sellerNames[this.sellerIds[row] ?? 0] ?? '' };
  }

  setPrice(row: number, priceMinor: number): void {
    this.prices[this.check(row)] = priceMinor;
  }

  render(row: number): string {
    return this.typeOf(row).render(this.stateOf(row));
  }

  get length(): number {
    return this.rows;
  }

  get capacity(): number {
    return this.prices.length;
  }

  private check(row: number): number {
    if (!Number.isInteger(row) || row < 0 || row >= this.rows) throw new RangeError(`No row ${row}`);
    return row;
  }

  private grow(): void {
    const enlarge = (old: Uint32Array): Uint32Array => {
      const next = new Uint32Array(old.length * 2);
      next.set(old);
      return next;
    };
    this.prices = enlarge(this.prices);
    this.stocks = enlarge(this.stocks);
    this.typeIds = enlarge(this.typeIds);
    this.sellerIds = enlarge(this.sellerIds);
  }
}

/**
 * Symbol.for is the runtime's own flyweight registry: the same key always returns the same
 * symbol, across modules and even across realms (iframes, vm contexts). Handy for shared tags.
 */
export const categoryTag = (category: string): symbol => Symbol.for(`catalog.category:${normalise(category)}`);
