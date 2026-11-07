/**
 * SINGLETON
 * Make sure a class has exactly one instance per process and give every caller
 * one well-known way to reach it.
 *
 * Example domain: the registry of database connection pools and the application
 * ConfigService. Two pool registries double the open connections; two configs
 * disagree about the same setting.
 */

export interface PoolOptions {
  readonly maxConnections: number;
}

export interface PooledConnection {
  readonly id: string;
}

const DEFAULT_POOL_OPTIONS: PoolOptions = { maxConnections: 10 };

/**
 * An in-memory stand-in for `pg.Pool`: hands out at most `maxConnections` at once
 * and reuses released ones. This is the expensive, stateful thing worth sharing.
 */
export class ConnectionPool {
  private opened = 0;
  private closed = false;
  private readonly idle: PooledConnection[] = [];
  private readonly busy = new Set<string>();

  constructor(
    readonly name: string,
    readonly options: PoolOptions,
  ) {}

  acquire(): PooledConnection {
    if (this.closed) throw new Error(`Pool "${this.name}" is closed`);
    const connection = this.idle.pop() ?? this.open();
    this.busy.add(connection.id);
    return connection;
  }

  release(connection: PooledConnection): void {
    if (this.busy.delete(connection.id)) this.idle.push(connection);
  }

  get inUse(): number {
    return this.busy.size;
  }

  close(): void {
    this.closed = true;
    this.idle.length = 0;
    this.busy.clear();
  }

  private open(): PooledConnection {
    if (this.opened >= this.options.maxConnections) {
      throw new Error(`Pool "${this.name}" exhausted: all ${this.options.maxConnections} connections in use`);
    }
    this.opened += 1;
    return { id: `${this.name}#${this.opened}` };
  }
}

/** What consumers need from the registry. Depending on this, not on the class, is what makes injection possible. */
export interface PoolProvider {
  pool(name: string): ConnectionPool;
}

/* ------------------------------------------------------------------------ */
/* 1. Classic GoF singleton, LAZY: the class polices its own instance count. */
/* ------------------------------------------------------------------------ */

export class ConnectionPoolRegistry implements PoolProvider {
  private static instance: ConnectionPoolRegistry | undefined;
  private static created = 0;

  private readonly pools = new Map<string, ConnectionPool>();

  /** Private: `new ConnectionPoolRegistry()` anywhere else is a compile error. */
  private constructor() {
    ConnectionPoolRegistry.created += 1;
  }

  /**
   * LAZY: nothing is built until the first caller asks, so scripts and tests that
   * never touch the database never create pools. No lock is needed: JavaScript
   * runs this check-then-create on one thread, so two callers cannot interleave
   * here (the race that double-checked locking exists for in Java).
   */
  static getInstance(): ConnectionPoolRegistry {
    ConnectionPoolRegistry.instance ??= new ConnectionPoolRegistry();
    return ConnectionPoolRegistry.instance;
  }

  /** How many registries this process has built. A working singleton keeps it at 1 per reset. */
  static get instancesCreated(): number {
    return ConnectionPoolRegistry.created;
  }

  /**
   * The hook every classic singleton grows once it has tests: close whatever the
   * previous test left open and forget the instance, so the next getInstance()
   * starts clean. Its existence is the clearest sign of the testing cost.
   */
  static resetForTests(): void {
    ConnectionPoolRegistry.instance?.closeAll();
    ConnectionPoolRegistry.instance = undefined;
  }

  /**
   * One pool per database name, created on first use. `options` only matter the
   * first time; a later caller asking for different options gets an error rather
   * than silently receiving a pool configured by someone else.
   */
  pool(name: string, options?: PoolOptions): ConnectionPool {
    const existing = this.pools.get(name);
    if (existing) {
      if (options && options.maxConnections !== existing.options.maxConnections) {
        throw new Error(
          `Pool "${name}" already exists with maxConnections=${existing.options.maxConnections}, not ${options.maxConnections}`,
        );
      }
      return existing;
    }
    const created = new ConnectionPool(name, options ?? DEFAULT_POOL_OPTIONS);
    this.pools.set(name, created);
    return created;
  }

  names(): string[] {
    return [...this.pools.keys()].sort();
  }

  closeAll(): void {
    for (const pool of this.pools.values()) pool.close();
    this.pools.clear();
  }
}

/* ------------------------------------------------------------------------ */
/* 2. TypeScript-idiomatic singleton, EAGER: the module is the singleton.     */
/* ------------------------------------------------------------------------ */

export type ConfigSource = Readonly<Record<string, string | undefined>>;

/**
 * An ordinary class: public constructor, no statics. Tests build their own
 * instances; production code shares the single `config` exported below.
 */
export class ConfigService {
  private readonly values = new Map<string, string>();
  /** Runtime overrides (an operator flips a flag) layered over the startup snapshot. */
  private readonly overrides = new Map<string, string>();

  constructor(source: ConfigSource = {}) {
    // Copy rather than keep a reference: the snapshot should not change under us.
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) this.values.set(key, value);
    }
  }

  get(key: string): string | undefined {
    return this.overrides.get(key) ?? this.values.get(key);
  }

  require(key: string): string {
    const value = this.get(key);
    if (value === undefined || value === '') throw new Error(`Missing required config "${key}"`);
    return value;
  }

  getNumber(key: string, fallback: number): number {
    const raw = this.get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Config "${key}" must be a number, got "${raw}"`);
    return value;
  }

  /** Every holder of this instance sees the change at once: the point of sharing, and its danger. */
  override(key: string, value: string): void {
    this.overrides.set(key, value);
  }

  clearOverrides(): void {
    this.overrides.clear();
  }
}

/**
 * ES modules are evaluated once per process and cached by resolved path, so every
 * `import { config }` receives this same object: a singleton without getInstance().
 * It is EAGER, built when the module is first imported, so the constructor must stay
 * cheap and free of I/O. The classic eager form is the same line inside the class,
 * `private static readonly instance = new X()`, with getInstance() just returning it.
 */
export const config = new ConfigService(process.env);

/* ------------------------------------------------------------------------ */
/* 3. Consumers: reaching for the singleton vs. having it injected.           */
/* ------------------------------------------------------------------------ */

export interface OrderRow {
  readonly orderId: string;
  /** Which pooled connection answered, so the wiring is visible in tests and the demo. */
  readonly servedBy: string;
}

/**
 * Why the classic getInstance() hurts testing: the dependencies are invisible. The
 * constructor takes nothing, yet findById() needs a pool and a config value. A test
 * cannot hand it a fake; it has to configure the process-wide instances and then
 * undo that, or the next test inherits the state.
 */
export class LegacyOrderRepository {
  findById(orderId: string): OrderRow {
    const pool = ConnectionPoolRegistry.getInstance().pool(config.get('ORDERS_DB_POOL') ?? 'orders');
    return runQuery(pool, orderId);
  }
}

/**
 * The dependency-injection alternative: identical logic, but collaborators arrive
 * through the constructor. main() passes the shared instances once; tests pass fresh
 * ones. "Only one" becomes a wiring decision (a lifetime), not a property of the class.
 */
export class OrderRepository {
  constructor(
    private readonly settings: ConfigService,
    private readonly pools: PoolProvider,
  ) {}

  findById(orderId: string): OrderRow {
    const pool = this.pools.pool(this.settings.get('ORDERS_DB_POOL') ?? 'orders');
    return runQuery(pool, orderId);
  }
}

function runQuery(pool: ConnectionPool, orderId: string): OrderRow {
  const connection = pool.acquire();
  try {
    // A real repository would run SQL here; what matters is which connection ran it.
    return { orderId, servedBy: connection.id };
  } finally {
    pool.release(connection);
  }
}
