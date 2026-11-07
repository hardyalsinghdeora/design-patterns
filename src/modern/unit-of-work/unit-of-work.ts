/**
 * UNIT OF WORK
 * Track every aggregate a business transaction loads, creates or removes, then write all of
 * the changes in one database transaction on commit(): every change once, or none of them.
 *
 * Example domain: capturing and refunding payments, which must change an Order and a
 * Payment together. Money in paise.
 */

/* ------------------------------ Database port ------------------------------ */

export type Row = Readonly<Record<string, string | number>>;

export interface Database {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  select(table: string, id: string): Promise<Row | undefined>;
  insert(table: string, row: Row): Promise<void>;
  update(table: string, row: Row): Promise<void>;
  delete(table: string, id: string): Promise<void>;
}

export interface WriteOp {
  op: 'insert' | 'update' | 'delete';
  table: string;
  id: string;
}

type Tables = Map<string, Map<string, Row>>;
const cloneTables = (t: Tables): Tables => new Map([...t].map(([name, rows]) => [name, new Map(rows)]));

/**
 * Transactional fake. Writes go to a staged copy that replaces the committed tables on
 * commit and is thrown away on rollback. `failWhen` injects a failure on a chosen write.
 */
export class InMemoryDatabase implements Database {
  readonly log: string[] = [];
  readonly reads: string[] = [];
  private committed: Tables = new Map();
  private staged: Tables | undefined;

  constructor(private readonly failWhen: (write: WriteOp) => boolean = () => false) {}

  /** Test setup: rows that already exist before the scenario starts. */
  seed(table: string, rows: Row[]): this {
    const target = this.committed.get(table) ?? new Map<string, Row>();
    for (const row of rows) target.set(String(row.id), row);
    this.committed.set(table, target);
    return this;
  }

  /** What a fresh connection would see: committed data only. */
  rows(table: string): Row[] {
    return [...(this.committed.get(table)?.values() ?? [])];
  }

  async begin(): Promise<void> {
    if (this.staged) throw new Error('Transaction already open');
    this.staged = cloneTables(this.committed);
    this.log.push('BEGIN');
  }

  async commit(): Promise<void> {
    if (!this.staged) throw new Error('No open transaction');
    this.committed = this.staged;
    this.staged = undefined;
    this.log.push('COMMIT');
  }

  async rollback(): Promise<void> {
    this.staged = undefined;
    this.log.push('ROLLBACK');
  }

  async select(table: string, id: string): Promise<Row | undefined> {
    this.reads.push(`${table}/${id}`);
    return (this.staged ?? this.committed).get(table)?.get(id);
  }

  async insert(table: string, row: Row): Promise<void> {
    const rows = this.write({ op: 'insert', table, id: String(row.id) });
    if (rows.has(String(row.id))) throw new Error(`Duplicate key ${table}/${row.id}`);
    rows.set(String(row.id), row);
  }

  async update(table: string, row: Row): Promise<void> {
    const rows = this.write({ op: 'update', table, id: String(row.id) });
    if (!rows.has(String(row.id))) throw new Error(`No row ${table}/${row.id}`);
    rows.set(String(row.id), row);
  }

  async delete(table: string, id: string): Promise<void> {
    this.write({ op: 'delete', table, id }).delete(id);
  }

  private write(w: WriteOp): Map<string, Row> {
    if (!this.staged) throw new Error('Writes are only allowed inside a transaction');
    if (this.failWhen(w)) throw new Error(`Simulated failure on ${w.op} ${w.table}/${w.id}`);
    this.log.push(`${w.op.toUpperCase()} ${w.table}/${w.id}`);
    const rows = this.staged.get(w.table) ?? new Map<string, Row>();
    this.staged.set(w.table, rows);
    return rows;
  }
}

/* --------------------------------- Domain ---------------------------------- */

export type OrderStatus = 'pending' | 'paid' | 'cancelled';
export type PaymentStatus = 'captured' | 'refunded';

export class Order {
  constructor(
    readonly id: string,
    readonly customerId: string,
    readonly totalMinor: number,
    private currentStatus: OrderStatus = 'pending',
  ) {}
  get status(): OrderStatus {
    return this.currentStatus;
  }
  markPaid(): void {
    if (this.currentStatus !== 'pending') throw new Error(`Order ${this.id} is ${this.currentStatus}`);
    this.currentStatus = 'paid';
  }
  cancel(): void {
    this.currentStatus = 'cancelled';
  }
}

export class Payment {
  constructor(
    readonly id: string,
    readonly orderId: string,
    readonly amountMinor: number,
    private currentStatus: PaymentStatus = 'captured',
  ) {}
  get status(): PaymentStatus {
    return this.currentStatus;
  }
  refund(): void {
    if (this.currentStatus !== 'captured') throw new Error(`Payment ${this.id} is ${this.currentStatus}`);
    this.currentStatus = 'refunded';
  }
}

/* --------------------------------- Mappers --------------------------------- */

export interface Entity {
  readonly id: string;
}

export interface Mapper<T extends Entity> {
  readonly table: string;
  toRow(entity: T): Row;
  fromRow(row: Row): T;
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`Column ${column} must be text`);
  return value;
}

function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`Column ${column} must be an integer`);
  return value;
}

function oneOf<S extends string>(value: string, allowed: readonly S[]): S {
  const match = allowed.find((a) => a === value);
  if (match === undefined) throw new Error(`Unexpected status ${value}`);
  return match;
}

export const orderMapper: Mapper<Order> = {
  table: 'orders',
  toRow: (o) => ({ id: o.id, customer_id: o.customerId, total_minor: o.totalMinor, status: o.status }),
  fromRow: (r) => new Order(text(r, 'id'), text(r, 'customer_id'), int(r, 'total_minor'), oneOf<OrderStatus>(text(r, 'status'), ['pending', 'paid', 'cancelled'])),
};

export const paymentMapper: Mapper<Payment> = {
  table: 'payments',
  toRow: (p) => ({ id: p.id, order_id: p.orderId, amount_minor: p.amountMinor, status: p.status }),
  fromRow: (r) => new Payment(text(r, 'id'), text(r, 'order_id'), int(r, 'amount_minor'), oneOf<PaymentStatus>(text(r, 'status'), ['captured', 'refunded'])),
};

/* ------------------------------ Unit of Work ------------------------------- */

type EntryState = 'new' | 'clean' | 'removed';

interface Entry {
  readonly mapper: Mapper<Entity>;
  readonly entity: Entity;
  state: EntryState;
  /** Row as loaded; a "clean" entry whose current row differs is dirty. */
  readonly snapshot: string;
}

export interface ChangeSet {
  inserts: string[];
  updates: string[];
  deletes: string[];
}

const keyOf = (table: string, id: string) => `${table}/${id}`;

/**
 * One instance per business transaction (per request, per job). The entries map is both
 * the identity map (one id, one object) and the change tracker.
 */
export class UnitOfWork {
  readonly orders: OrderRepository;
  readonly payments: PaymentRepository;
  private readonly entries = new Map<string, Entry>();
  /** Parents before children, so inserts satisfy foreign keys; deletes run in reverse. */
  private readonly tableOrder: string[] = [orderMapper.table, paymentMapper.table];
  private closed = false;

  constructor(private readonly db: Database) {
    this.orders = new OrderRepository(this);
    this.payments = new PaymentRepository(this);
  }

  /** Called by repositories. Returns the tracked instance if this unit has seen the id. */
  async load<T extends Entity>(mapper: Mapper<T>, id: string): Promise<T | undefined> {
    this.ensureOpen();
    const tracked = this.entries.get(keyOf(mapper.table, id));
    // The cast is safe: entries are keyed by table, and each table has exactly one mapper.
    if (tracked) return tracked.state === 'removed' ? undefined : (tracked.entity as T);
    const row = await this.db.select(mapper.table, id);
    if (!row) return undefined;
    const entity = mapper.fromRow(row);
    this.entries.set(keyOf(mapper.table, id), { mapper, entity, state: 'clean', snapshot: JSON.stringify(mapper.toRow(entity)) });
    return entity;
  }

  registerNew<T extends Entity>(mapper: Mapper<T>, entity: T): void {
    this.ensureOpen();
    const key = keyOf(mapper.table, entity.id);
    if (this.entries.has(key)) throw new Error(`${key} is already tracked`);
    this.entries.set(key, { mapper, entity, state: 'new', snapshot: '' });
  }

  registerRemoved<T extends Entity>(mapper: Mapper<T>, entity: T): void {
    this.ensureOpen();
    const key = keyOf(mapper.table, entity.id);
    const entry = this.entries.get(key);
    if (!entry || entry.entity !== entity) throw new Error(`${key} was not loaded in this unit of work`);
    // Created and removed in the same unit: the database never needs to hear about it.
    if (entry.state === 'new') this.entries.delete(key);
    else entry.state = 'removed';
  }

  /** What commit() would write right now. Nothing has touched the database yet. */
  pendingChanges(): ChangeSet {
    const { inserts, updates, deletes } = this.computeChanges();
    const keys = (list: Entry[]) => list.map((e) => keyOf(e.mapper.table, e.entity.id));
    return { inserts: keys(inserts), updates: keys(updates), deletes: keys(deletes) };
  }

  async commit(): Promise<ChangeSet> {
    this.ensureOpen();
    const summary = this.pendingChanges();
    const { inserts, updates, deletes } = this.computeChanges();
    this.closed = true;
    if (inserts.length + updates.length + deletes.length === 0) return summary; // read-only: no transaction
    await this.db.begin();
    try {
      for (const e of inserts) await this.db.insert(e.mapper.table, e.mapper.toRow(e.entity));
      for (const e of updates) await this.db.update(e.mapper.table, e.mapper.toRow(e.entity));
      for (const e of deletes) await this.db.delete(e.mapper.table, e.entity.id);
      await this.db.commit();
    } catch (err) {
      await this.db.rollback();
      throw err;
    }
    return summary;
  }

  /** Discard every tracked change. The database was never written, so there is nothing to undo there. */
  rollback(): void {
    this.entries.clear();
    this.closed = true;
  }

  private computeChanges(): { inserts: Entry[]; updates: Entry[]; deletes: Entry[] } {
    const inserts: Entry[] = [];
    const updates: Entry[] = [];
    const deletes: Entry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === 'new') inserts.push(entry);
      else if (entry.state === 'removed') deletes.push(entry);
      // Dirty checking by snapshot: callers cannot forget to "registerDirty".
      else if (JSON.stringify(entry.mapper.toRow(entry.entity)) !== entry.snapshot) updates.push(entry);
    }
    const rank = (e: Entry) => this.tableOrder.indexOf(e.mapper.table);
    inserts.sort((a, b) => rank(a) - rank(b));
    updates.sort((a, b) => rank(a) - rank(b));
    deletes.sort((a, b) => rank(b) - rank(a));
    return { inserts, updates, deletes };
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('This unit of work is closed; start a new one');
  }
}

/* -------------------- Repositories scoped to one unit ---------------------- */

/** Repositories do no I/O of their own on writes: they only register intent with the unit. */
export class TrackedRepository<T extends Entity> {
  constructor(
    private readonly unit: UnitOfWork,
    private readonly mapper: Mapper<T>,
  ) {}

  find(id: string): Promise<T | undefined> {
    return this.unit.load(this.mapper, id);
  }

  async get(id: string): Promise<T> {
    const entity = await this.find(id);
    if (!entity) throw new Error(`${this.mapper.table}/${id} not found`);
    return entity;
  }

  add(entity: T): void {
    this.unit.registerNew(this.mapper, entity);
  }

  remove(entity: T): void {
    this.unit.registerRemoved(this.mapper, entity);
  }
}

export class OrderRepository extends TrackedRepository<Order> {
  constructor(unit: UnitOfWork) {
    super(unit, orderMapper);
  }
}

export class PaymentRepository extends TrackedRepository<Payment> {
  constructor(unit: UnitOfWork) {
    super(unit, paymentMapper);
  }
}

/* ------------------------------------------------------------------------ */
/* Idiomatic TypeScript: a scope function. The closure is the business       */
/* transaction; success commits, a thrown error discards everything.        */
/* ------------------------------------------------------------------------ */

export async function withUnitOfWork<R>(db: Database, work: (uow: UnitOfWork) => Promise<R>): Promise<R> {
  const uow = new UnitOfWork(db);
  let result: R;
  try {
    result = await work(uow);
  } catch (err) {
    uow.rollback();
    throw err;
  }
  await uow.commit();
  return result;
}

export class PaymentService {
  constructor(
    private readonly db: Database,
    private readonly newId: () => string,
  ) {}

  /** Order becomes paid and a payment row appears, or neither happens. */
  capture(orderId: string): Promise<Payment> {
    return withUnitOfWork(this.db, async (uow) => {
      const order = await uow.orders.get(orderId);
      order.markPaid();
      const payment = new Payment(this.newId(), order.id, order.totalMinor);
      uow.payments.add(payment);
      return payment;
    });
  }

  /** Refund and cancel touch two aggregates in two tables, in one transaction. */
  refund(paymentId: string): Promise<void> {
    return withUnitOfWork(this.db, async (uow) => {
      const payment = await uow.payments.get(paymentId);
      payment.refund();
      (await uow.orders.get(payment.orderId)).cancel();
    });
  }
}
