/**
 * CQRS (Command Query Responsibility Segregation)
 * Writes go through command handlers that guard invariants on a write model and emit events;
 * reads are served from separate, denormalised read models that projectors build from those events.
 *
 * Example domain: orders and billing. The write side knows an order's lines and payments; the read
 * side answers "what does this customer owe?" and "which orders are unpaid?" without joins.
 * Amounts are integers in minor units (paise). The projector is driven by hand (catchUp) to make
 * the eventual consistency between the two sides visible.
 */

export type Clock = () => string;

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPriceMinor: number;
}

/* ------------------------------------------------------------------------ */
/* Messages. Commands are requests that may be refused; events are facts.    */
/* ------------------------------------------------------------------------ */

export type Command =
  | { type: 'PlaceOrder'; orderId: string; customerId: string; lines: OrderLine[] }
  | { type: 'RecordPayment'; orderId: string; amountMinor: number }
  | { type: 'CancelOrder'; orderId: string; reason: string };

export type DomainEvent =
  | { type: 'OrderPlaced'; orderId: string; customerId: string; totalMinor: number; at: string }
  | { type: 'PaymentRecorded'; orderId: string; customerId: string; amountMinor: number; at: string }
  | { type: 'OrderCancelled'; orderId: string; customerId: string; reason: string; at: string };

export interface StoredEvent {
  position: number; // global, gap-free: projectors checkpoint on it
  event: DomainEvent;
}

/** Append-only log the command side writes and the query side reads. */
export class EventLog {
  private readonly events: StoredEvent[] = [];

  append(events: readonly DomainEvent[]): void {
    for (const event of events) this.events.push({ position: this.events.length + 1, event });
  }

  readAfter(position: number, limit = Number.POSITIVE_INFINITY): StoredEvent[] {
    return this.events.slice(position, position + limit);
  }

  get head(): number {
    return this.events.length;
  }
}

export class InvariantViolation extends Error {}

/* ------------------------------------------------------------------------ */
/* COMMAND SIDE: a normalised write model that only has to be correct.       */
/* ------------------------------------------------------------------------ */

export type OrderStatus = 'AWAITING_PAYMENT' | 'PAID' | 'CANCELLED';

export class Order {
  private constructor(
    readonly id: string,
    readonly customerId: string,
    readonly lines: readonly OrderLine[],
    private _status: OrderStatus,
    private _paidMinor: number,
  ) {}

  static place(id: string, customerId: string, lines: OrderLine[]): Order {
    if (lines.length === 0) throw new InvariantViolation('an order needs at least one line');
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new InvariantViolation(`bad quantity for ${l.sku}`);
      if (!Number.isInteger(l.unitPriceMinor) || l.unitPriceMinor < 0) throw new InvariantViolation(`bad price for ${l.sku}`);
    }
    return new Order(id, customerId, [...lines], 'AWAITING_PAYMENT', 0);
  }

  get status(): OrderStatus {
    return this._status;
  }

  get totalMinor(): number {
    return this.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0);
  }

  get outstandingMinor(): number {
    return this.totalMinor - this._paidMinor;
  }

  /** Validate everything first, mutate last: a refused command leaves no trace. */
  recordPayment(amountMinor: number): void {
    if (this._status === 'CANCELLED') throw new InvariantViolation(`order ${this.id} is cancelled`);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new InvariantViolation('payment must be a positive integer');
    if (amountMinor > this.outstandingMinor) {
      throw new InvariantViolation(`overpayment: ${amountMinor} > outstanding ${this.outstandingMinor}`);
    }
    this._paidMinor += amountMinor;
    if (this.outstandingMinor === 0) this._status = 'PAID';
  }

  cancel(): void {
    if (this._status === 'CANCELLED') throw new InvariantViolation(`order ${this.id} is already cancelled`);
    if (this._paidMinor > 0) throw new InvariantViolation(`order ${this.id} has payments; refund before cancelling`);
    this._status = 'CANCELLED';
  }
}

export class OrderWriteRepository {
  private readonly orders = new Map<string, Order>();

  has(id: string): boolean {
    return this.orders.has(id);
  }

  get(id: string): Order {
    const order = this.orders.get(id);
    if (!order) throw new InvariantViolation(`order ${id} not found`);
    return order;
  }

  save(order: Order): void {
    this.orders.set(order.id, order);
  }
}

type CommandOf<T extends Command['type']> = Extract<Command, { type: T }>;

export interface CommandHandler<C extends Command> {
  handle(command: C): DomainEvent[];
}

export class PlaceOrderHandler implements CommandHandler<CommandOf<'PlaceOrder'>> {
  constructor(private readonly repo: OrderWriteRepository, private readonly clock: Clock) {}

  handle(cmd: CommandOf<'PlaceOrder'>): DomainEvent[] {
    if (this.repo.has(cmd.orderId)) throw new InvariantViolation(`order ${cmd.orderId} already exists`);
    const order = Order.place(cmd.orderId, cmd.customerId, cmd.lines);
    this.repo.save(order);
    return [{ type: 'OrderPlaced', orderId: order.id, customerId: order.customerId, totalMinor: order.totalMinor, at: this.clock() }];
  }
}

export class RecordPaymentHandler implements CommandHandler<CommandOf<'RecordPayment'>> {
  constructor(private readonly repo: OrderWriteRepository, private readonly clock: Clock) {}

  handle(cmd: CommandOf<'RecordPayment'>): DomainEvent[] {
    // Invariants are checked against the write model, never the read model: the read model may lag.
    const order = this.repo.get(cmd.orderId);
    order.recordPayment(cmd.amountMinor);
    this.repo.save(order);
    return [{ type: 'PaymentRecorded', orderId: order.id, customerId: order.customerId, amountMinor: cmd.amountMinor, at: this.clock() }];
  }
}

export class CancelOrderHandler implements CommandHandler<CommandOf<'CancelOrder'>> {
  constructor(private readonly repo: OrderWriteRepository, private readonly clock: Clock) {}

  handle(cmd: CommandOf<'CancelOrder'>): DomainEvent[] {
    const order = this.repo.get(cmd.orderId);
    order.cancel();
    this.repo.save(order);
    return [{ type: 'OrderCancelled', orderId: order.id, customerId: order.customerId, reason: cmd.reason, at: this.clock() }];
  }
}

/** One handler per command type, enforced by the compiler: forget one and this type fails. */
export type CommandHandlers = { [K in Command['type']]: CommandHandler<CommandOf<K>> };

export class CommandBus {
  constructor(private readonly handlers: CommandHandlers, private readonly log: EventLog) {}

  /** Returns events, never data: the caller reads through the query side. */
  dispatch<C extends Command>(command: C): DomainEvent[] {
    // TypeScript cannot correlate handlers[command.type] with C; the mapped type above guarantees it.
    const handler = this.handlers[command.type] as unknown as CommandHandler<C>;
    const events = handler.handle(command);
    // In production the write-model update and this append share one DB transaction (outbox).
    this.log.append(events);
    return events;
  }
}

export function createCommandSide(clock: Clock, log = new EventLog()) {
  const repo = new OrderWriteRepository();
  const bus = new CommandBus(
    {
      PlaceOrder: new PlaceOrderHandler(repo, clock),
      RecordPayment: new RecordPaymentHandler(repo, clock),
      CancelOrder: new CancelOrderHandler(repo, clock),
    },
    log,
  );
  return { bus, log, repo };
}

/* ------------------------------------------------------------------------ */
/* QUERY SIDE: read models shaped like the screens that use them.           */
/* ------------------------------------------------------------------------ */

export interface Projection<S> {
  readonly name: string;
  reset(): void;
  apply(stored: StoredEvent): void;
  /** A plain, ordered copy: what a rebuild must reproduce. */
  snapshot(): S;
}

export interface OrderRow {
  orderId: string;
  customerId: string;
  status: OrderStatus;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  updatedAt: string;
}

/** The "orders" grid: one flat row per order, already computed. */
export class OrderListProjection implements Projection<OrderRow[]> {
  readonly name = 'order-list';
  private rows = new Map<string, OrderRow>();

  reset(): void {
    this.rows = new Map();
  }

  apply({ event }: StoredEvent): void {
    switch (event.type) {
      case 'OrderPlaced':
        this.rows.set(event.orderId, {
          orderId: event.orderId,
          customerId: event.customerId,
          status: 'AWAITING_PAYMENT',
          totalMinor: event.totalMinor,
          paidMinor: 0,
          outstandingMinor: event.totalMinor,
          updatedAt: event.at,
        });
        return;
      case 'PaymentRecorded': {
        const row = this.rows.get(event.orderId);
        if (!row) return;
        row.paidMinor += event.amountMinor;
        row.outstandingMinor = row.totalMinor - row.paidMinor;
        row.status = row.outstandingMinor === 0 ? 'PAID' : row.status;
        row.updatedAt = event.at;
        return;
      }
      case 'OrderCancelled': {
        const row = this.rows.get(event.orderId);
        if (!row) return;
        row.status = 'CANCELLED';
        row.outstandingMinor = 0;
        row.updatedAt = event.at;
        return;
      }
    }
  }

  get(orderId: string): OrderRow | undefined {
    const row = this.rows.get(orderId);
    return row ? { ...row } : undefined;
  }

  unpaid(): OrderRow[] {
    return this.snapshot().filter((r) => r.status === 'AWAITING_PAYMENT');
  }

  snapshot(): OrderRow[] {
    return [...this.rows.values()].map((r) => ({ ...r })).sort((a, b) => a.orderId.localeCompare(b.orderId));
  }
}

export interface CustomerBalance {
  customerId: string;
  openOrders: number;
  billedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
}

/** The billing dashboard: per-customer totals. Keeps private lookup state, as projections may. */
export class CustomerBalanceProjection implements Projection<CustomerBalance[]> {
  readonly name = 'customer-balance';
  private balances = new Map<string, CustomerBalance>();
  private orderTotals = new Map<string, number>();

  reset(): void {
    this.balances = new Map();
    this.orderTotals = new Map();
  }

  private balance(customerId: string): CustomerBalance {
    let b = this.balances.get(customerId);
    if (!b) {
      b = { customerId, openOrders: 0, billedMinor: 0, paidMinor: 0, outstandingMinor: 0 };
      this.balances.set(customerId, b);
    }
    return b;
  }

  apply({ event }: StoredEvent): void {
    const b = this.balance(event.customerId);
    if (event.type === 'OrderPlaced') {
      this.orderTotals.set(event.orderId, event.totalMinor);
      b.openOrders += 1;
      b.billedMinor += event.totalMinor;
    } else if (event.type === 'PaymentRecorded') {
      b.paidMinor += event.amountMinor;
      const remaining = (this.orderTotals.get(event.orderId) ?? 0) - event.amountMinor;
      this.orderTotals.set(event.orderId, remaining);
      if (remaining === 0) b.openOrders -= 1;
    } else {
      // Only unpaid orders can be cancelled, so the whole total leaves the bill.
      b.billedMinor -= this.orderTotals.get(event.orderId) ?? 0;
      b.openOrders -= 1;
    }
    b.outstandingMinor = b.billedMinor - b.paidMinor;
  }

  get(customerId: string): CustomerBalance | undefined {
    const b = this.balances.get(customerId);
    return b ? { ...b } : undefined;
  }

  snapshot(): CustomerBalance[] {
    return [...this.balances.values()].map((b) => ({ ...b })).sort((a, b) => a.customerId.localeCompare(b.customerId));
  }
}

/**
 * Moves events from the log into one projection and remembers how far it got. Each projection
 * has its own projector and checkpoint, so a new one can start from position 0 on its own.
 */
export class Projector<S> {
  private checkpoint = 0;

  constructor(private readonly log: EventLog, readonly projection: Projection<S>) {}

  get position(): number {
    return this.checkpoint;
  }

  /** How many committed events this read model has not seen yet. */
  lag(): number {
    return this.log.head - this.checkpoint;
  }

  catchUp(maxEvents = Number.POSITIVE_INFINITY): number {
    const batch = this.log.readAfter(this.checkpoint, maxEvents);
    for (const stored of batch) {
      this.projection.apply(stored);
      this.checkpoint = stored.position; // checkpoint per event: a crash replays at most one
    }
    return batch.length;
  }

  /** Throw the read model away and replay history: how you fix a projection bug or change its shape. */
  rebuild(): number {
    this.projection.reset();
    this.checkpoint = 0;
    return this.catchUp();
  }
}

/** The query API. No invariants, no writes, no joins: just reads of prepared data. */
export class BillingQueries {
  constructor(private readonly orders: OrderListProjection, private readonly balances: CustomerBalanceProjection) {}

  order(orderId: string): OrderRow | undefined {
    return this.orders.get(orderId);
  }

  unpaidOrders(): OrderRow[] {
    return this.orders.unpaid();
  }

  customerBalance(customerId: string): CustomerBalance | undefined {
    return this.balances.get(customerId);
  }
}

export function createQuerySide(log: EventLog) {
  const orders = new OrderListProjection();
  const balances = new CustomerBalanceProjection();
  const projectors = [new Projector(log, orders), new Projector(log, balances)] as const;
  return {
    queries: new BillingQueries(orders, balances),
    projectors,
    catchUp: () => projectors.reduce((n, p) => n + p.catchUp(), 0),
  };
}

/** A fixed, ticking clock for demos and tests. */
export function steppingClock(startIso = '2026-01-01T00:00:00.000Z', stepMs = 60_000): Clock {
  let t = Date.parse(startIso) - stepMs;
  return () => new Date((t += stepMs)).toISOString();
}
