/**
 * OBJECT POOL
 * Keep a bounded set of expensive, reusable objects and lend them out instead of creating one per use.
 * Callers acquire, use and release; the pool caps the total, queues waiters, and replaces broken objects.
 *
 * Example domain: a database connection pool. Opening a connection (TCP + TLS + auth) costs far more
 * than a query, and the database only accepts so many, so connections are borrowed, not created.
 * No timers in here: time comes from an injected Clock, and waiting is done with deferred promises.
 */

export interface Clock {
  now(): number;
}

export class ManualClock implements Clock {
  constructor(private ms = 0) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** A promise whose resolve/reject live outside it: how a waiter is parked until a connection frees up. */
export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* ------------------------------------------------------------------------ */
/* The pooled resource and its factory.                                      */
/* ------------------------------------------------------------------------ */

export class ConnectionLostError extends Error {
  constructor(connectionId: string) {
    super(`Connection ${connectionId} lost`);
    this.name = 'ConnectionLostError';
  }
}

export class DbConnection {
  private healthy = true;
  private closed = false;
  queries = 0;

  constructor(readonly id: string) {}

  async query(sql: string): Promise<string> {
    if (this.closed) throw new Error(`Connection ${this.id} is closed`);
    if (!this.healthy) throw new ConnectionLostError(this.id);
    this.queries += 1;
    return `${this.id} ran: ${sql}`;
  }

  isHealthy(): boolean {
    return this.healthy && !this.closed;
  }

  /** Simulates the server or a proxy dropping the socket. */
  breakConnection(): void {
    this.healthy = false;
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export interface ConnectionFactory {
  create(): Promise<DbConnection>;
}

/** Counts handshakes: the number the pool exists to keep small. */
export class FakeConnectionFactory implements ConnectionFactory {
  created = 0;
  async create(): Promise<DbConnection> {
    this.created += 1;
    return new DbConnection(`conn-${this.created}`);
  }
}

/* ------------------------------------------------------------------------ */
/* The pool.                                                                 */
/* ------------------------------------------------------------------------ */

export interface PoolOptions {
  min: number;
  max: number;
  /** How long acquire() may wait in the queue before it rejects. */
  maxWaitMs: number;
  /** A lease held longer than this is reported as a probable leak. */
  leakThresholdMs: number;
  clock: Clock;
  /** Checked on acquire and on release; failing connections are destroyed, never lent out. */
  validate?: (conn: DbConnection) => boolean;
}

export class PoolTimeoutError extends Error {
  constructor(waitedMs: number, holder: string) {
    super(`Timed out after ${waitedMs} ms waiting for a connection (${holder})`);
    this.name = 'PoolTimeoutError';
  }
}

export class PoolClosedError extends Error {
  constructor() {
    super('Pool is closed');
    this.name = 'PoolClosedError';
  }
}

export interface LeakReport {
  connectionId: string;
  holder: string;
  heldMs: number;
}

export interface PoolStats {
  idle: number;
  inUse: number;
  waiting: number;
  total: number;
  destroyed: number;
}

interface Lease {
  acquiredAt: number;
  holder: string;
}

interface Waiter {
  deferred: Deferred<DbConnection>;
  deadline: number;
  holder: string;
}

export class ConnectionPool {
  private idle: DbConnection[] = [];
  private readonly leased = new Map<DbConnection, Lease>();
  private waiters: Waiter[] = [];
  /** Connections being opened right now. They count towards max, or a burst would overshoot it. */
  private creating = 0;
  private destroyed = 0;
  private closed = false;
  private readonly validate: (conn: DbConnection) => boolean;

  constructor(
    private readonly factory: ConnectionFactory,
    private readonly options: PoolOptions,
  ) {
    if (options.min < 0 || options.max < 1 || options.min > options.max) {
      throw new Error(`Invalid pool size: min ${options.min}, max ${options.max}`);
    }
    this.validate = options.validate ?? ((conn) => conn.isHealthy());
  }

  private get size(): number {
    return this.idle.length + this.leased.size + this.creating;
  }

  /** Opens connections up to `min`. Call at startup, and periodically to replace destroyed ones. */
  async warmUp(): Promise<void> {
    const missing = Math.max(0, this.options.min - this.size);
    await Promise.all(Array.from({ length: missing }, () => this.openIdle()));
  }

  /**
   * Lend a connection. Served immediately from idle (validated) or by opening a new one under `max`;
   * otherwise the caller joins a FIFO queue. Not `async`, so the queue position is fixed at call time.
   */
  acquire(holder = 'unknown'): Promise<DbConnection> {
    if (this.closed) return Promise.reject(new PoolClosedError());
    this.expireWaiters();
    if (this.waiters.length === 0) {
      const ready = this.tryLease(holder);
      if (ready) return ready;
    }
    const deferred = defer<DbConnection>();
    this.waiters.push({ deferred, deadline: this.options.clock.now() + this.options.maxWaitMs, holder });
    return deferred.promise;
  }

  release(conn: DbConnection): void {
    if (!this.leased.delete(conn)) {
      throw new Error(`Connection ${conn.id} is not leased from this pool (double release?)`);
    }
    if (this.closed || !this.validate(conn)) this.destroy(conn);
    else this.idle.push(conn);
    this.dispatch();
  }

  /** The loan pattern: the idiomatic way to use a pool. Release happens even when fn throws. */
  async withConnection<R>(fn: (conn: DbConnection) => Promise<R>, holder = 'withConnection'): Promise<R> {
    const conn = await this.acquire(holder);
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }

  /**
   * Housekeeping without timers: expire waiters past their deadline and report leaks. The pool also
   * expires waiters on every acquire and release; the app calls sweep() from its own scheduler.
   */
  sweep(): { timedOut: number; leaks: LeakReport[] } {
    return { timedOut: this.expireWaiters(), leaks: this.detectLeaks() };
  }

  detectLeaks(): LeakReport[] {
    const now = this.options.clock.now();
    return [...this.leased]
      .filter(([, lease]) => now - lease.acquiredAt > this.options.leakThresholdMs)
      .map(([conn, lease]) => ({ connectionId: conn.id, holder: lease.holder, heldMs: now - lease.acquiredAt }));
  }

  stats(): PoolStats {
    return {
      idle: this.idle.length,
      inUse: this.leased.size,
      waiting: this.waiters.length,
      total: this.size,
      destroyed: this.destroyed,
    };
  }

  /** Rejects waiters and closes idle connections; leased ones are closed as they come back. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters) waiter.deferred.reject(new PoolClosedError());
    this.waiters = [];
    for (const conn of this.idle) this.destroy(conn);
    this.idle = [];
  }

  /* --- internals ---------------------------------------------------------- */

  private tryLease(holder: string): Promise<DbConnection> | undefined {
    // LIFO: reuse the most recently returned connection, so a small hot set stays warm.
    for (let conn = this.idle.pop(); conn; conn = this.idle.pop()) {
      if (this.validate(conn)) {
        this.lease(conn, holder);
        return Promise.resolve(conn);
      }
      this.destroy(conn); // went bad while idle: replace it rather than hand it out
    }
    if (this.size < this.options.max) return this.openLeased(holder);
    return undefined;
  }

  private async openLeased(holder: string): Promise<DbConnection> {
    this.creating += 1;
    let conn: DbConnection;
    try {
      conn = await this.factory.create();
    } catch (err) {
      this.creating -= 1;
      this.dispatch();
      throw err;
    }
    this.creating -= 1;
    this.lease(conn, holder); // same synchronous step as the decrement: size never under-counts
    return conn;
  }

  private async openIdle(): Promise<void> {
    this.creating += 1;
    let conn: DbConnection;
    try {
      conn = await this.factory.create();
    } finally {
      this.creating -= 1;
    }
    this.idle.push(conn);
    this.dispatch();
  }

  private lease(conn: DbConnection, holder: string): void {
    this.leased.set(conn, { acquiredAt: this.options.clock.now(), holder });
  }

  private destroy(conn: DbConnection): void {
    conn.close();
    this.destroyed += 1;
  }

  /** Hand freed capacity to waiters, oldest first. */
  private dispatch(): void {
    this.expireWaiters();
    while (this.waiters.length > 0 && !this.closed) {
      const next = this.waiters[0];
      const ready = this.tryLease(next.holder);
      if (!ready) return;
      this.waiters.shift();
      ready.then(next.deferred.resolve, next.deferred.reject);
    }
  }

  private expireWaiters(): number {
    const now = this.options.clock.now();
    const expired = this.waiters.filter((w) => now >= w.deadline);
    if (expired.length === 0) return 0;
    this.waiters = this.waiters.filter((w) => now < w.deadline);
    for (const w of expired) w.deferred.reject(new PoolTimeoutError(this.options.maxWaitMs, w.holder));
    return expired.length;
  }
}
