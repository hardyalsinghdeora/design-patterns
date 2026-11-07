/**
 * REPOSITORY
 * Give the domain a collection-like interface for its aggregates (find, save, delete) and
 * keep storage behind it: services depend on the interface, storage is swapped underneath.
 *
 * Example domain: orders, stored in memory (tests, prototypes) or in SQL. Money in paise.
 */

/* --------------------------------- Domain --------------------------------- */

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'cancelled';
const STATUSES: readonly OrderStatus[] = ['pending', 'paid', 'shipped', 'cancelled'];

/** The aggregate. It knows its rules and nothing about tables or SQL. */
export class Order {
  constructor(
    readonly id: string,
    readonly customerId: string,
    private currentStatus: OrderStatus,
    readonly totalMinor: number,
    readonly createdAtMs: number,
  ) {}

  get status(): OrderStatus {
    return this.currentStatus;
  }

  markPaid(): void {
    if (this.currentStatus !== 'pending') throw new Error(`Order ${this.id} is ${this.currentStatus}, cannot be paid`);
    this.currentStatus = 'paid';
  }

  cancel(): void {
    if (this.currentStatus === 'shipped') throw new Error(`Order ${this.id} has shipped, cannot be cancelled`);
    this.currentStatus = 'cancelled';
  }
}

/* ---------------------- Specifications (query objects) --------------------- */

export type OrderColumn = 'id' | 'customer_id' | 'status' | 'total_minor' | 'created_at_ms';
export type SqlValue = string | number;
export type ConditionOp = '=' | '<' | '>=';

export interface Condition<C extends string> {
  column: C;
  op: ConditionOp;
  value: SqlValue;
}

/**
 * A spec is data, not a callback, so each repository can translate it: the in-memory one
 * filters rows, the SQL one renders a WHERE clause. Conditions are ANDed.
 */
export interface OrderSpec {
  readonly conditions: readonly Condition<OrderColumn>[];
}

export const byCustomer = (customerId: string): OrderSpec => ({ conditions: [{ column: 'customer_id', op: '=', value: customerId }] });
export const withStatus = (status: OrderStatus): OrderSpec => ({ conditions: [{ column: 'status', op: '=', value: status }] });
export const createdBefore = (ms: number): OrderSpec => ({ conditions: [{ column: 'created_at_ms', op: '<', value: ms }] });
export const allOf = (...specs: OrderSpec[]): OrderSpec => ({ conditions: specs.flatMap((s) => s.conditions) });

export function matchesRow<C extends string>(row: Readonly<Record<C, SqlValue>>, conditions: readonly Condition<C>[]): boolean {
  return conditions.every(({ column, op, value }) => {
    const actual = row[column];
    if (op === '=') return actual === value;
    if (op === '<') return actual < value;
    return actual >= value;
  });
}

/* ---------------------------- The repository port -------------------------- */

/** Lives next to the domain. Speaks in Orders and specs, never in rows or SQL. */
export interface OrderRepository {
  findById(id: string): Promise<Order | undefined>;
  findBy(spec: OrderSpec): Promise<Order[]>;
  save(order: Order): Promise<void>;
  delete(id: string): Promise<void>;
}

/* ------------------------------ Mapping helpers ---------------------------- */

export type OrderRow = Record<OrderColumn, SqlValue>;
export type SqlRow = Readonly<Record<string, SqlValue | null>>;
export const ORDER_COLUMNS: readonly OrderColumn[] = ['id', 'customer_id', 'status', 'total_minor', 'created_at_ms'];

export function orderToRow(order: Order): OrderRow {
  return {
    id: order.id,
    customer_id: order.customerId,
    status: order.status,
    total_minor: order.totalMinor,
    created_at_ms: order.createdAtMs,
  };
}

/** Rows come from outside the type system, so check them instead of casting. */
export function rowToOrder(row: SqlRow): Order {
  const { id, customer_id, status, total_minor, created_at_ms } = row;
  const isStatus = (s: unknown): s is OrderStatus => STATUSES.some((known) => known === s);
  if (typeof id !== 'string' || typeof customer_id !== 'string' || !isStatus(status) || typeof total_minor !== 'number' || typeof created_at_ms !== 'number') {
    throw new Error(`Malformed orders row: ${JSON.stringify(row)}`);
  }
  return new Order(id, customer_id, status, total_minor, created_at_ms);
}

/**
 * Identity map: within one repository instance a row id maps to exactly one Order object,
 * so two lookups never hand out two copies that drift apart.
 */
class OrderIdentityMap {
  private readonly loaded = new Map<string, Order>();

  get(id: string): Order | undefined {
    return this.loaded.get(id);
  }
  hydrate(row: SqlRow): Order {
    const cached = typeof row.id === 'string' ? this.loaded.get(row.id) : undefined;
    if (cached) return cached;
    const order = rowToOrder(row);
    this.loaded.set(order.id, order);
    return order;
  }
  remember(order: Order): void {
    this.loaded.set(order.id, order);
  }
  forget(id: string): void {
    this.loaded.delete(id);
  }
}

const byCreatedThenId = (a: OrderRow, b: OrderRow) =>
  Number(a.created_at_ms) - Number(b.created_at_ms) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/* --------------------------- Adapter 1: in memory -------------------------- */

/**
 * Stores row snapshots, not live objects: mutating an Order without save() must not
 * change "the database", or tests would pass here and fail against SQL.
 */
export class InMemoryOrderRepository implements OrderRepository {
  private readonly identity = new OrderIdentityMap();

  constructor(private readonly rows: Map<string, OrderRow> = new Map()) {}

  async findById(id: string): Promise<Order | undefined> {
    const row = this.rows.get(id);
    return this.identity.get(id) ?? (row ? this.identity.hydrate(row) : undefined);
  }

  async findBy(spec: OrderSpec): Promise<Order[]> {
    return [...this.rows.values()]
      .filter((row) => matchesRow(row, spec.conditions))
      .sort(byCreatedThenId)
      .map((row) => this.identity.hydrate(row));
  }

  async save(order: Order): Promise<void> {
    this.rows.set(order.id, orderToRow(order));
    this.identity.remember(order);
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
    this.identity.forget(id);
  }
}

/* ------------------------- A tiny SQL query builder ------------------------ */

export interface SqlQuery {
  sql: string;
  params: SqlValue[];
}

/** Column names are typed literals, never user input; only values become $n parameters. */
export class SelectBuilder<C extends string> {
  private readonly conditions: Condition<C>[] = [];
  private readonly ordering: C[] = [];

  constructor(
    private readonly table: string,
    private readonly columns: readonly C[],
  ) {}

  where(column: C, op: ConditionOp, value: SqlValue): this {
    this.conditions.push({ column, op, value });
    return this;
  }

  whereAll(conditions: readonly Condition<C>[]): this {
    this.conditions.push(...conditions);
    return this;
  }

  orderBy(...columns: C[]): this {
    this.ordering.push(...columns);
    return this;
  }

  build(): SqlQuery {
    const params: SqlValue[] = [];
    const where = this.conditions.map((c) => `${c.column} ${c.op} $${params.push(c.value)}`);
    let sql = `SELECT ${this.columns.join(', ')} FROM ${this.table}`;
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    if (this.ordering.length > 0) sql += ` ORDER BY ${this.ordering.join(', ')}`;
    return { sql, params };
  }
}

export const select = <C extends string>(table: string, columns: readonly C[]) => new SelectBuilder<C>(table, columns);

export function upsert<C extends string>(table: string, row: Readonly<Record<C, SqlValue>>, key: C): SqlQuery {
  const columns = Object.keys(row) as C[];
  const params = columns.map((c) => row[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const updates = columns.filter((c) => c !== key).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${key}) DO UPDATE SET ${updates}`,
    params,
  };
}

export function deleteFrom<C extends string>(table: string, column: C, value: SqlValue): SqlQuery {
  return { sql: `DELETE FROM ${table} WHERE ${column} = $1`, params: [value] };
}

/* ----------------------------- Adapter 2: SQL ------------------------------ */

/** The only thing the repository needs from a driver (pg, mysql2, a test stub). */
export type Execute = (sql: string, params: readonly SqlValue[]) => Promise<readonly SqlRow[]>;

export class SqlOrderRepository implements OrderRepository {
  private readonly identity = new OrderIdentityMap();

  constructor(private readonly execute: Execute) {}

  async findById(id: string): Promise<Order | undefined> {
    const cached = this.identity.get(id);
    if (cached) return cached; // no round trip for an aggregate we already hold
    const { sql, params } = select('orders', ORDER_COLUMNS).where('id', '=', id).build();
    const [row] = await this.execute(sql, params);
    return row ? this.identity.hydrate(row) : undefined;
  }

  async findBy(spec: OrderSpec): Promise<Order[]> {
    const { sql, params } = select('orders', ORDER_COLUMNS).whereAll(spec.conditions).orderBy('created_at_ms', 'id').build();
    const rows = await this.execute(sql, params);
    return rows.map((row) => this.identity.hydrate(row));
  }

  async save(order: Order): Promise<void> {
    const { sql, params } = upsert('orders', orderToRow(order), 'id');
    await this.execute(sql, params);
    this.identity.remember(order);
  }

  async delete(id: string): Promise<void> {
    const { sql, params } = deleteFrom('orders', 'id', id);
    await this.execute(sql, params);
    this.identity.forget(id);
  }
}

/* --------------------------------- Service --------------------------------- */

/** Depends on the port only. Clock and id generator are injected so tests are deterministic. */
export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly clock: () => number,
    private readonly newId: () => string,
  ) {}

  async place(customerId: string, totalMinor: number): Promise<Order> {
    if (!Number.isInteger(totalMinor) || totalMinor <= 0) throw new Error('Order total must be a positive integer in minor units');
    const order = new Order(this.newId(), customerId, 'pending', totalMinor, this.clock());
    await this.orders.save(order);
    return order;
  }

  async pay(orderId: string): Promise<Order> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    order.markPaid();
    await this.orders.save(order);
    return order;
  }

  /** Housekeeping job: cancel orders left unpaid for longer than maxAgeMs. */
  async cancelStalePending(maxAgeMs: number): Promise<string[]> {
    const stale = await this.orders.findBy(allOf(withStatus('pending'), createdBefore(this.clock() - maxAgeMs)));
    for (const order of stale) {
      order.cancel();
      await this.orders.save(order);
    }
    return stale.map((o) => o.id);
  }

  async lifetimeSpendMinor(customerId: string): Promise<number> {
    const orders = await this.orders.findBy(byCustomer(customerId));
    return orders.filter((o) => o.status === 'paid' || o.status === 'shipped').reduce((sum, o) => sum + o.totalMinor, 0);
  }
}
