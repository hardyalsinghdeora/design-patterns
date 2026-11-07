/**
 * BULKHEAD
 * Give each downstream dependency its own fixed pool of concurrent calls with a bounded queue, so one slow dependency can exhaust only its own compartment and never the capacity other calls need.
 */

/* Example domain: checkout calls inventory and payments; inventory goes slow. Amounts are in paise. */

export class BulkheadFullError extends Error {
  constructor(
    readonly bulkhead: string,
    readonly maxConcurrent: number,
    readonly maxQueue: number,
  ) {
    super(`Bulkhead "${bulkhead}" is full (${maxConcurrent} running, ${maxQueue} queued)`);
    this.name = 'BulkheadFullError';
  }
}

export class BulkheadAbortedError extends Error {
  constructor(readonly bulkhead: string) {
    super(`Gave up waiting for a slot in bulkhead "${bulkhead}"`);
    this.name = 'BulkheadAbortedError';
  }
}

export type Release = () => void;

interface Waiter {
  grant: () => void;
}

/**
 * Counting semaphore with a bounded FIFO wait queue. `tryAcquire` returns
 * undefined when both the permits and the queue are used up: the caller
 * rejects immediately instead of waiting forever. No timers: a waiter leaves
 * the queue through an AbortSignal the caller controls.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly permits: number,
    readonly maxQueue: number,
  ) {
    if (!Number.isInteger(permits) || permits < 1) throw new RangeError('permits must be a positive integer');
    if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new RangeError('maxQueue must be a non-negative integer');
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  tryAcquire(onAbort: () => Error, signal?: AbortSignal): Promise<Release> | undefined {
    if (signal?.aborted) return Promise.reject(onAbort());
    if (this.active < this.permits) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiters.length >= this.maxQueue) return undefined;

    return new Promise<Release>((resolve, reject) => {
      const abort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(onAbort());
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', abort);
          resolve(this.releaser());
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Release is idempotent: calling it twice must not mint an extra permit. */
  private releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.grant(); // hand the permit straight over; `active` is unchanged
      else this.active--;
    };
  }
}

export interface BulkheadConfig {
  maxConcurrent: number;
  maxQueue: number;
}

export interface BulkheadMetrics {
  name: string;
  maxConcurrent: number;
  maxQueue: number;
  active: number;
  queued: number;
  rejected: number;
  abandoned: number;
  completed: number;
  failed: number;
}

export class Bulkhead {
  private readonly semaphore: Semaphore;
  private rejected = 0;
  private abandoned = 0;
  private completed = 0;
  private failed = 0;

  constructor(
    readonly name: string,
    private readonly config: BulkheadConfig,
  ) {
    this.semaphore = new Semaphore(config.maxConcurrent, config.maxQueue);
  }

  /**
   * Admission is decided synchronously, at call time: either a slot, a place
   * in the queue, or an immediate BulkheadFullError. The permit is released in
   * `finally`, so a call that throws can never leak capacity.
   */
  async execute<T>(call: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    const permit = this.semaphore.tryAcquire(() => new BulkheadAbortedError(this.name), options.signal);
    if (!permit) {
      this.rejected++;
      throw new BulkheadFullError(this.name, this.config.maxConcurrent, this.config.maxQueue);
    }
    let release: Release;
    try {
      release = await permit;
    } catch (error) {
      this.abandoned++;
      throw error;
    }
    try {
      const result = await call();
      this.completed++;
      return result;
    } catch (error) {
      this.failed++;
      throw error;
    } finally {
      release();
    }
  }

  metrics(): BulkheadMetrics {
    return {
      name: this.name,
      ...this.config,
      active: this.semaphore.activeCount,
      queued: this.semaphore.queuedCount,
      rejected: this.rejected,
      abandoned: this.abandoned,
      completed: this.completed,
      failed: this.failed,
    };
  }
}

/** One compartment per dependency, sized independently. */
export class BulkheadRegistry {
  private readonly pools = new Map<string, Bulkhead>();

  constructor(private readonly configs: Readonly<Record<string, BulkheadConfig>>) {}

  get(name: string): Bulkhead {
    let pool = this.pools.get(name);
    if (!pool) {
      const config = this.configs[name];
      if (!config) throw new Error(`No bulkhead configured for "${name}"`);
      pool = new Bulkhead(name, config);
      this.pools.set(name, pool);
    }
    return pool;
  }

  metrics(): BulkheadMetrics[] {
    return [...this.pools.values()].map((p) => p.metrics());
  }
}

/* ------------------------------------------------------------------------ */
/* Functional form: a p-limit style limiter built from a closure.            */
/* ------------------------------------------------------------------------ */

export type Limiter = <T>(call: () => Promise<T>) => Promise<T>;

export function createLimiter(maxConcurrent: number, maxQueue: number, name = 'limiter'): Limiter {
  const bulkhead = new Bulkhead(name, { maxConcurrent, maxQueue });
  return (call) => bulkhead.execute(call);
}

/* ------------------------------------------------------------------------ */
/* Dependencies and the client                                               */
/* ------------------------------------------------------------------------ */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A fake dependency whose calls stay pending until the test settles them, and
 * which measures how many calls it has in flight. That measurement, not the
 * bulkhead's own counters, is what proves the limit holds.
 */
export class ControllableDependency<Req, Res> {
  readonly pending: Array<{ request: Req; deferred: Deferred<Res> }> = [];
  inFlight = 0;
  peakInFlight = 0;
  started = 0;

  protected call(request: Req): Promise<Res> {
    this.started++;
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    const d = deferred<Res>();
    this.pending.push({ request, deferred: d });
    return d.promise.finally(() => {
      this.inFlight--;
    });
  }

  resolveOldest(value: Res): Req {
    const next = this.pending.shift();
    if (!next) throw new Error('no pending call');
    next.deferred.resolve(value);
    return next.request;
  }

  rejectOldest(error: Error): Req {
    const next = this.pending.shift();
    if (!next) throw new Error('no pending call');
    next.deferred.reject(error);
    return next.request;
  }
}

export interface ReserveRequest {
  orderId: string;
  sku: string;
  quantity: number;
}
export interface Reservation {
  reservationId: string;
}
export interface ChargeRequest {
  orderId: string;
  amountMinor: number;
}
export interface ChargeReceipt {
  chargeId: string;
}

export interface InventoryApi {
  reserve(request: ReserveRequest): Promise<Reservation>;
}
export interface PaymentsApi {
  charge(request: ChargeRequest): Promise<ChargeReceipt>;
}

export class FakeInventoryApi extends ControllableDependency<ReserveRequest, Reservation> implements InventoryApi {
  reserve(request: ReserveRequest): Promise<Reservation> {
    return this.call(request);
  }
}

export class FakePaymentsApi extends ControllableDependency<ChargeRequest, ChargeReceipt> implements PaymentsApi {
  charge(request: ChargeRequest): Promise<ChargeReceipt> {
    return this.call(request);
  }
}

/** The client: every outbound call goes through the compartment for its dependency. */
export class CheckoutService {
  constructor(
    private readonly inventory: InventoryApi,
    private readonly payments: PaymentsApi,
    private readonly bulkheads: BulkheadRegistry,
  ) {}

  reserveStock(request: ReserveRequest, signal?: AbortSignal): Promise<Reservation> {
    return this.bulkheads.get('inventory').execute(() => this.inventory.reserve(request), signal ? { signal } : {});
  }

  charge(request: ChargeRequest): Promise<ChargeReceipt> {
    return this.bulkheads.get('payments').execute(() => this.payments.charge(request));
  }
}

export const defaultBulkheads = (): BulkheadRegistry =>
  new BulkheadRegistry({
    inventory: { maxConcurrent: 3, maxQueue: 2 },
    payments: { maxConcurrent: 5, maxQueue: 5 },
  });
