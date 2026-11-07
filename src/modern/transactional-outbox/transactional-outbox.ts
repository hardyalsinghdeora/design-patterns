/**
 * TRANSACTIONAL OUTBOX
 * Write the business change and the event announcing it in the same local transaction; a separate relay publishes outbox rows to the broker afterwards, so an event is never lost and never sent for a change that rolled back.
 */

/* Example domain: an order service announcing OrderPlaced to a shipping service. Amounts are in paise. */

export interface Clock {
  now(): number;
}

export interface Row {
  id: string;
}

export class UniqueViolationError extends Error {
  constructor(
    readonly table: string,
    readonly rowId: string,
  ) {
    super(`duplicate key "${rowId}" in table "${table}"`);
    this.name = 'UniqueViolationError';
  }
}

export interface Transaction<S extends Record<string, Row>> {
  get<K extends keyof S & string>(table: K, id: string): S[K] | undefined;
  /** Throws UniqueViolationError if the id exists: the inbox relies on this. */
  insert<K extends keyof S & string>(table: K, row: S[K]): void;
  update<K extends keyof S & string>(table: K, id: string, patch: Partial<S[K]>): void;
  scan<K extends keyof S & string>(table: K): S[K][];
}

type Tables = Map<string, Map<string, Row>>;

/** Buffers writes; nothing is visible to anyone else until applyTo() runs at commit. */
class StagedTransaction<S extends Record<string, Row>> implements Transaction<S> {
  private readonly staged: Tables = new Map();

  constructor(private readonly committed: Tables) {}

  get<K extends keyof S & string>(table: K, id: string): S[K] | undefined {
    const row = this.staged.get(table)?.get(id) ?? this.table(table).get(id);
    return row === undefined ? undefined : (structuredClone(row) as S[K]);
  }

  insert<K extends keyof S & string>(table: K, row: S[K]): void {
    if (this.get(table, row.id) !== undefined) throw new UniqueViolationError(table, row.id);
    this.stage(table).set(row.id, structuredClone(row));
  }

  update<K extends keyof S & string>(table: K, id: string, patch: Partial<S[K]>): void {
    const current = this.get(table, id);
    if (current === undefined) throw new Error(`no row "${id}" in table "${table}"`);
    this.stage(table).set(id, { ...current, ...patch, id });
  }

  scan<K extends keyof S & string>(table: K): S[K][] {
    const merged = new Map(this.table(table));
    for (const [id, row] of this.staged.get(table) ?? []) merged.set(id, row);
    return [...merged.values()].map((row) => structuredClone(row) as S[K]);
  }

  applyTo(committed: Tables): void {
    for (const [table, rows] of this.staged) {
      const target = committed.get(table);
      if (!target) throw new Error(`unknown table "${table}"`);
      for (const [id, row] of rows) target.set(id, row);
    }
  }

  private table(name: string): Map<string, Row> {
    const t = this.committed.get(name);
    if (!t) throw new Error(`unknown table "${name}"`);
    return t;
  }

  private stage(name: string): Map<string, Row> {
    this.table(name); // validate the name
    let t = this.staged.get(name);
    if (!t) {
      t = new Map();
      this.staged.set(name, t);
    }
    return t;
  }
}

/**
 * The transactional database fake. Transactions are serialized (one at a
 * time), all-or-nothing, and isolated by copying rows in and out. It is the
 * one guarantee the outbox needs: two writes to two tables commit together.
 */
export class InMemoryDatabase<S extends Record<string, Row>> {
  private readonly committed: Tables = new Map();
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private commitFailure: Error | undefined;

  constructor(tables: ReadonlyArray<keyof S & string>) {
    for (const t of tables) this.committed.set(t, new Map());
  }

  transaction<R>(work: (tx: Transaction<S>) => R | Promise<R>): Promise<R> {
    const run = this.queue.then(async () => {
      const tx = new StagedTransaction<S>(this.committed);
      const result = await work(tx); // a throw here discards every staged write: rollback
      if (this.commitFailure) {
        const error = this.commitFailure;
        this.commitFailure = undefined;
        throw error;
      }
      tx.applyTo(this.committed);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Like a database sequence: monotonic, and a rolled-back value leaves a gap. */
  nextSequence(): number {
    return ++this.sequence;
  }

  /** Failure injection: the next commit fails (disk full, serialization failure, lost connection). */
  failNextCommit(error: Error): void {
    this.commitFailure = error;
  }

  /** Read outside any transaction, for tests and the demo. */
  snapshot<K extends keyof S & string>(table: K): S[K][] {
    return [...(this.committed.get(table)?.values() ?? [])].map((row) => structuredClone(row) as S[K]);
  }
}

/* ------------------------------------------------------------------------ */
/* Order side: orders table plus the outbox table, one database.             */
/* ------------------------------------------------------------------------ */

export interface Order extends Row {
  customerId: string;
  totalMinor: number;
  status: 'PLACED';
  createdAt: number;
}

export interface OrderPlacedPayload {
  orderId: string;
  customerId: string;
  totalMinor: number;
}

export interface OutboxEvent extends Row {
  sequence: number;
  aggregateId: string;
  type: 'OrderPlaced';
  payload: OrderPlacedPayload;
  createdAt: number;
  publishedAt: number | null;
  attempts: number;
  lastError: string | null;
}

export type OrderSchema = { orders: Order; outbox: OutboxEvent };

export const createOrderDatabase = () => new InMemoryDatabase<OrderSchema>(['orders', 'outbox']);

export interface PlaceOrder {
  orderId: string;
  customerId: string;
  totalMinor: number;
}

export class OrderService {
  constructor(
    private readonly db: InMemoryDatabase<OrderSchema>,
    private readonly clock: Clock,
  ) {}

  /** One transaction, two inserts. There is no broker call here at all. */
  placeOrder(command: PlaceOrder): Promise<Order> {
    return this.db.transaction((tx) => {
      const now = this.clock.now();
      const order: Order = { id: command.orderId, customerId: command.customerId, totalMinor: command.totalMinor, status: 'PLACED', createdAt: now };
      tx.insert('orders', order);
      const sequence = this.db.nextSequence();
      tx.insert('outbox', {
        id: `evt_${String(sequence).padStart(6, '0')}`,
        sequence,
        aggregateId: order.id,
        type: 'OrderPlaced',
        payload: { orderId: order.id, customerId: order.customerId, totalMinor: order.totalMinor },
        createdAt: now,
        publishedAt: null,
        attempts: 0,
        lastError: null,
      });
      return order;
    });
  }
}

/* ------------------------------------------------------------------------ */
/* The broker fake: publishing and consuming are decoupled, as in Kafka/SQS. */
/* ------------------------------------------------------------------------ */

export interface BrokerMessage {
  /** The outbox event id: stable across re-publishes, so consumers can dedupe on it. */
  messageId: string;
  key: string;
  type: string;
  payload: OrderPlacedPayload;
}

export class BrokerUnavailableError extends Error {
  constructor() {
    super('broker unavailable');
    this.name = 'BrokerUnavailableError';
  }
}

type Handler = (message: BrokerMessage) => Promise<void>;

export class FakeBroker {
  available = true;
  /** Everything ever accepted, duplicates included. */
  readonly published: Array<{ topic: string; message: BrokerMessage }> = [];
  private readonly undelivered: Array<{ topic: string; message: BrokerMessage }> = [];
  private readonly handlers = new Map<string, Handler[]>();
  async publish(topic: string, message: BrokerMessage): Promise<void> {
    if (!this.available) throw new BrokerUnavailableError();
    this.published.push({ topic, message });
    this.undelivered.push({ topic, message });
  }

  subscribe(topic: string, handler: Handler): void {
    this.handlers.set(topic, [...(this.handlers.get(topic) ?? []), handler]);
  }

  /** Push accepted messages to subscribers; a message leaves only once every handler succeeded. */
  async deliverPending(): Promise<number> {
    let delivered = 0;
    for (let next = this.undelivered[0]; next; next = this.undelivered[0]) {
      for (const handler of this.handlers.get(next.topic) ?? []) await handler(next.message);
      this.undelivered.shift();
      delivered++;
    }
    return delivered;
  }
}

/* ------------------------------------------------------------------------ */
/* The relay (polling publisher)                                             */
/* ------------------------------------------------------------------------ */

/** Idiomatic TS: page through pending events lazily with an async generator. */
export async function* unpublishedEvents(db: InMemoryDatabase<OrderSchema>, pageSize: number): AsyncGenerator<OutboxEvent> {
  let after = 0;
  for (;;) {
    const page = await db.transaction((tx) =>
      tx
        .scan('outbox')
        .filter((e) => e.publishedAt === null && e.sequence > after)
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, pageSize),
    );
    if (page.length === 0) return;
    yield* page;
    after = page[page.length - 1]?.sequence ?? after;
  }
}

export interface RelayOptions {
  topic: string;
  pageSize: number;
  maxPerPoll: number;
  /** Test seam: runs after a successful publish, before the row is marked. Throw to simulate a crash. */
  afterPublish?: (event: OutboxEvent) => void;
}

export interface PollResult {
  published: number;
  /** The event the poll stopped at because the broker refused it; later events wait behind it. */
  blockedAt?: string;
}

/**
 * Publish, then mark. If the process dies between the two steps the event is
 * published again on the next poll: at-least-once delivery, by design. The
 * scheduler (setInterval, a worker loop, a cron) lives outside this class.
 */
export class OutboxRelay {
  constructor(
    private readonly db: InMemoryDatabase<OrderSchema>,
    private readonly broker: FakeBroker,
    private readonly clock: Clock,
    private readonly options: RelayOptions,
  ) {}

  async pollOnce(): Promise<PollResult> {
    let published = 0;
    for await (const event of unpublishedEvents(this.db, this.options.pageSize)) {
      if (published >= this.options.maxPerPoll) break;
      try {
        await this.broker.publish(this.options.topic, toMessage(event));
      } catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        await this.db.transaction((tx) => tx.update('outbox', event.id, { attempts: event.attempts + 1, lastError }));
        return { published, blockedAt: event.id }; // stop: publishing later events now would reorder them
      }
      this.options.afterPublish?.(event);
      await this.db.transaction((tx) => tx.update('outbox', event.id, { publishedAt: this.clock.now(), attempts: event.attempts + 1 }));
      published++;
    }
    return { published };
  }
}

const toMessage = (event: OutboxEvent): BrokerMessage => ({
  messageId: event.id,
  key: event.aggregateId,
  type: event.type,
  payload: event.payload,
});

/* ------------------------------------------------------------------------ */
/* Consumer side: its own database with an inbox (dedup) table.              */
/* ------------------------------------------------------------------------ */

export interface InboxEntry extends Row {
  processedAt: number;
}

export interface Shipment extends Row {
  orderId: string;
  status: 'PENDING';
}

export type ShippingSchema = { inbox: InboxEntry; shipments: Shipment };

export const createShippingDatabase = () => new InMemoryDatabase<ShippingSchema>(['inbox', 'shipments']);

/**
 * Effectively-once processing on top of at-least-once delivery: the inbox row
 * and the side effect commit in one transaction, so a redelivered message
 * finds its inbox row and is skipped.
 */
export class ShippingConsumer {
  processed = 0;
  duplicates = 0;
  private shipmentSeq = 0;

  constructor(
    private readonly db: InMemoryDatabase<ShippingSchema>,
    private readonly clock: Clock,
  ) {}

  readonly handle = async (message: BrokerMessage): Promise<void> => {
    const outcome = await this.db.transaction((tx) => {
      if (tx.get('inbox', message.messageId)) return 'duplicate' as const;
      tx.insert('inbox', { id: message.messageId, processedAt: this.clock.now() });
      tx.insert('shipments', { id: `shp_${++this.shipmentSeq}`, orderId: message.payload.orderId, status: 'PENDING' });
      return 'processed' as const;
    });
    if (outcome === 'processed') this.processed++;
    else this.duplicates++;
  };
}

/* ------------------------------------------------------------------------ */
/* The "before": a dual write. Kept so the tests can show the bug.           */
/* ------------------------------------------------------------------------ */

export class DualWriteOrderService {
  constructor(
    private readonly db: InMemoryDatabase<OrderSchema>,
    private readonly broker: FakeBroker,
    private readonly clock: Clock,
  ) {}

  async placeOrder(command: PlaceOrder): Promise<Order> {
    const order = await this.db.transaction((tx) => {
      const row: Order = { id: command.orderId, customerId: command.customerId, totalMinor: command.totalMinor, status: 'PLACED', createdAt: this.clock.now() };
      tx.insert('orders', row);
      return row;
    });
    // BUG: the order is committed; if this publish fails (or the process dies here) the event is gone for good.
    await this.broker.publish('orders', {
      messageId: `msg_${order.id}`,
      key: order.id,
      type: 'OrderPlaced',
      payload: { orderId: order.id, customerId: order.customerId, totalMinor: order.totalMinor },
    });
    return order;
  }
}
