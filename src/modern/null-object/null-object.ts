/**
 * NULL OBJECT
 * Replace "no collaborator" (null/undefined) with an object that implements the same interface and
 * does nothing, or the neutral thing. Callers stop writing `if (logger)`, `if (user)` and `if (cache)`.
 *
 * Example domain: pricing and checkout with an optional logger, metrics, cache and a signed-out shopper.
 * Amounts are integers in minor units (paise).
 */

export type LogFields = Record<string, string | number | boolean>;

/* ------------------------------------------------------------------------ */
/* Logger                                                                    */
/* ------------------------------------------------------------------------ */

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** A real logger for tests and demos; production would write JSON lines to stdout. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string, fields?: LogFields): void {
    this.write('INFO', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write('WARN', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.write('ERROR', message, fields);
  }
  private write(level: string, message: string, fields?: LogFields): void {
    this.lines.push(fields ? `${level} ${message} ${JSON.stringify(fields)}` : `${level} ${message}`);
  }
}

/** Stateless, so one shared instance is enough. */
export class NullLogger implements Logger {
  static readonly instance = new NullLogger();
  private constructor() {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/** Idiomatic TypeScript: an object literal satisfies the interface just as well as a class. */
const noop = (): void => {};
export const noopLogger: Logger = Object.freeze({ info: noop, warn: noop, error: noop });

/* ------------------------------------------------------------------------ */
/* Metrics                                                                   */
/* ------------------------------------------------------------------------ */

export interface Metrics {
  increment(name: string, by?: number): void;
  timing(name: string, ms: number): void;
}

export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, number[]>();
  increment(name: string, by = 1): void {
    this.counters.set(name, this.counter(name) + by);
  }
  timing(name: string, ms: number): void {
    this.timings.set(name, [...(this.timings.get(name) ?? []), ms]);
  }
  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }
}

export class NoopMetrics implements Metrics {
  static readonly instance = new NoopMetrics();
  private constructor() {}
  increment(): void {}
  timing(): void {}
}

/* ------------------------------------------------------------------------ */
/* Cache: a cache that never hits is a correct cache, only slower.           */
/* ------------------------------------------------------------------------ */

export interface Cache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
}

export class MapCache<V> implements Cache<V> {
  private readonly entries = new Map<string, V>();
  get(key: string): V | undefined {
    return this.entries.get(key);
  }
  set(key: string, value: V): void {
    this.entries.set(key, value);
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
}

/** Always a miss. Safe because "not cached" is a valid answer for any cache. */
export class NullCache<V> implements Cache<V> {
  get(): V | undefined {
    return undefined;
  }
  set(): void {}
  delete(): void {}
}

/* ------------------------------------------------------------------------ */
/* The shopper: a signed-out visitor is a customer with no rights.           */
/* ------------------------------------------------------------------------ */

export type Permission = 'orders:create' | 'orders:view' | 'credit:use' | 'refunds:issue';

export interface Customer {
  readonly id: string;
  readonly displayName: string;
  /** For presentation only ("Sign in" button). Business code asks can(), not isGuest. */
  readonly isGuest: boolean;
  can(permission: Permission): boolean;
  discountBasisPoints(): number;
}

export class RegisteredCustomer implements Customer {
  readonly isGuest = false;
  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly permissions: readonly Permission[],
    private readonly tier: 'standard' | 'gold' = 'standard',
  ) {}
  can(permission: Permission): boolean {
    return this.permissions.includes(permission);
  }
  discountBasisPoints(): number {
    return this.tier === 'gold' ? 500 : 0; // 5 % for gold members
  }
}

/** The null customer (a.k.a. GuestUser): no permissions, no discount, a stable id for logs. */
export class AnonymousCustomer implements Customer {
  static readonly instance = new AnonymousCustomer();
  readonly id = 'anonymous';
  readonly displayName = 'Guest';
  readonly isGuest = true;
  private constructor() {}
  can(): boolean {
    return false;
  }
  discountBasisPoints(): number {
    return 0;
  }
}

/** The one place that turns "no session" into the null object; everything downstream gets a Customer. */
export class CustomerDirectory {
  constructor(private readonly sessions: ReadonlyMap<string, Customer>) {}
  resolve(sessionToken: string | undefined): Customer {
    const found = sessionToken === undefined ? undefined : this.sessions.get(sessionToken);
    return found ?? AnonymousCustomer.instance;
  }
}

/* ------------------------------------------------------------------------ */
/* Pricing. Not everything gets a null object: an unknown SKU is an error,   */
/* and a "NullPrice" of 0 would sell the item for free.                      */
/* ------------------------------------------------------------------------ */

export class UnknownSkuError extends Error {
  constructor(readonly sku: string) {
    super(`Unknown SKU "${sku}"`);
    this.name = 'UnknownSkuError';
  }
}

export class PriceCatalog {
  lookups = 0;
  constructor(private readonly prices: Readonly<Record<string, number>>) {}
  priceOf(sku: string): number {
    this.lookups += 1;
    const price = this.prices[sku];
    if (price === undefined) throw new UnknownSkuError(sku);
    return price;
  }
}

export interface Quote {
  customerId: string;
  sku: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  totalMinor: number;
}

function buildQuote(customerId: string, sku: string, quantity: number, unitPriceMinor: number, discountBp: number): Quote {
  const gross = unitPriceMinor * quantity;
  const discountMinor = Math.round((gross * discountBp) / 10_000);
  return { customerId, sku, quantity, unitPriceMinor, discountMinor, totalMinor: gross - discountMinor };
}

/** BEFORE: every optional collaborator is a branch, and forgetting one is a TypeError in production. */
export class PricingServiceBefore {
  constructor(
    private readonly prices: PriceCatalog,
    private readonly logger?: Logger,
    private readonly metrics?: Metrics,
    private readonly cache?: Cache<number>,
  ) {}

  quote(customer: Customer | null, sku: string, quantity: number): Quote {
    let unit = this.cache ? this.cache.get(sku) : undefined;
    if (unit === undefined) {
      unit = this.prices.priceOf(sku);
      if (this.cache) this.cache.set(sku, unit);
      if (this.metrics) this.metrics.increment('price.cache_miss');
    }
    const discountBp = customer ? customer.discountBasisPoints() : 0;
    const quote = buildQuote(customer ? customer.id : 'anonymous', sku, quantity, unit, discountBp);
    if (this.logger) this.logger.info('quoted', { sku, total: quote.totalMinor });
    return quote;
  }
}

/** AFTER: collaborators always exist. The defaults are the only place absence is decided. */
export class PricingService {
  constructor(
    private readonly prices: PriceCatalog,
    private readonly logger: Logger = NullLogger.instance,
    private readonly metrics: Metrics = NoopMetrics.instance,
    private readonly cache: Cache<number> = new NullCache<number>(),
  ) {}

  quote(customer: Customer, sku: string, quantity: number): Quote {
    let unit = this.cache.get(sku);
    if (unit === undefined) {
      unit = this.prices.priceOf(sku);
      this.cache.set(sku, unit);
      this.metrics.increment('price.cache_miss');
    }
    const quote = buildQuote(customer.id, sku, quantity, unit, customer.discountBasisPoints());
    this.logger.info('quoted', { sku, customer: customer.id, total: quote.totalMinor });
    return quote;
  }
}

export interface CheckoutResult {
  ok: boolean;
  message: string;
  quote?: Quote;
}

/** Guest checkout works; paying with store credit needs a permission the guest simply does not have. */
export class CheckoutService {
  constructor(
    private readonly pricing: PricingService,
    private readonly logger: Logger = NullLogger.instance,
  ) {}

  checkout(customer: Customer, sku: string, quantity: number, useStoreCredit = false): CheckoutResult {
    if (useStoreCredit && !customer.can('credit:use')) {
      this.logger.warn('store credit refused', { customer: customer.id });
      return { ok: false, message: `${customer.displayName} cannot pay with store credit` };
    }
    const quote = this.pricing.quote(customer, sku, quantity);
    return { ok: true, message: `${customer.displayName} pays ${quote.totalMinor}`, quote };
  }
}

/**
 * Null objects are silent by design, which hides misconfiguration ("why are there no logs in prod?").
 * Report the wiring once at startup, in the composition root, instead of checking on every call.
 */
export function wiringReport(deps: { logger: Logger; metrics: Metrics; cache: Cache<number> }): string[] {
  const report: string[] = [];
  if (deps.logger instanceof NullLogger || deps.logger === noopLogger) report.push('logger: null object (logs discarded)');
  if (deps.metrics instanceof NoopMetrics) report.push('metrics: null object (no metrics emitted)');
  if (deps.cache instanceof NullCache) report.push('cache: null object (every lookup hits the catalog)');
  return report;
}
