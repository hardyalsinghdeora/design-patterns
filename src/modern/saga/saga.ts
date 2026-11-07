/**
 * SAGA
 * A business transaction that spans services runs as a sequence of local steps, each paired
 * with a compensating action; when a step fails, the completed steps are undone in reverse order.
 *
 * Example domain: placing an order across Inventory, Payment and Shipping, shown twice:
 * orchestration (a central SagaOrchestrator with a persisted state machine) and choreography
 * (services reacting to each other's events on an in-memory bus). Amounts in paise.
 */

export interface OrderLine {
  sku: string;
  quantity: number;
}

export interface OrderContext {
  orderId: string;
  lines: OrderLine[];
  amountMinor: number;
  address: string;
}

export class TransientError extends Error {}
export class OutOfStockError extends Error {}
export class PaymentDeclinedError extends Error {}
export class IllegalTransitionError extends Error {}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Test seam shared by the fake services: records every call, fails chosen operations N times. */
export class FaultInjector {
  readonly calls: string[] = [];
  private readonly failures = new Map<string, number>();

  fail(op: string, times = Number.POSITIVE_INFINITY): this {
    this.failures.set(op, times);
    return this;
  }

  hit(op: string): void {
    this.calls.push(op);
    const remaining = this.failures.get(op) ?? 0;
    if (remaining > 0) {
      this.failures.set(op, remaining - 1);
      throw new TransientError(`${op} failed (injected)`);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* The participating services. Each owns its data and offers an action plus  */
/* its compensation. Both are idempotent, keyed by orderId, because a saga   */
/* will redeliver after crashes and retries.                                 */
/* ------------------------------------------------------------------------ */

export class InventoryService {
  private readonly stock: Map<string, number>;
  private readonly reservations = new Map<string, OrderLine[]>();

  constructor(initial: Record<string, number>, private readonly faults = new FaultInjector()) {
    this.stock = new Map(Object.entries(initial));
  }

  reserve(orderId: string, lines: OrderLine[]): void {
    this.faults.hit('inventory.reserve');
    if (this.reservations.has(orderId)) return; // redelivered command: already done
    for (const line of lines) {
      if ((this.stock.get(line.sku) ?? 0) < line.quantity) throw new OutOfStockError(`${line.sku} out of stock`);
    }
    for (const line of lines) this.stock.set(line.sku, (this.stock.get(line.sku) ?? 0) - line.quantity);
    this.reservations.set(orderId, lines);
  }

  release(orderId: string): void {
    this.faults.hit('inventory.release');
    const lines = this.reservations.get(orderId);
    if (!lines) return; // nothing reserved, or released already
    for (const line of lines) this.stock.set(line.sku, (this.stock.get(line.sku) ?? 0) + line.quantity);
    this.reservations.delete(orderId);
  }

  available(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }
}

export class PaymentService {
  private readonly captures = new Map<string, number>();
  private readonly refunded = new Set<string>();

  constructor(
    private readonly faults = new FaultInjector(),
    private readonly declineAboveMinor = Number.POSITIVE_INFINITY,
  ) {}

  charge(orderId: string, amountMinor: number): void {
    this.faults.hit('payment.charge');
    if (this.captures.has(orderId)) return;
    if (amountMinor > this.declineAboveMinor) throw new PaymentDeclinedError(`card declined for ${amountMinor}`);
    this.captures.set(orderId, amountMinor);
  }

  refund(orderId: string): void {
    this.faults.hit('payment.refund');
    if (!this.captures.has(orderId) || this.refunded.has(orderId)) return;
    this.refunded.add(orderId);
  }

  netCapturedMinor(): number {
    let total = 0;
    for (const [orderId, amount] of this.captures) if (!this.refunded.has(orderId)) total += amount;
    return total;
  }
}

export class ShippingService {
  private readonly shipments = new Map<string, string>();

  constructor(private readonly faults = new FaultInjector()) {}

  schedule(orderId: string, address: string): void {
    this.faults.hit('shipping.schedule');
    if (this.shipments.has(orderId)) return;
    this.shipments.set(orderId, address);
  }

  cancel(orderId: string): void {
    this.faults.hit('shipping.cancel');
    this.shipments.delete(orderId);
  }

  activeShipments(): number {
    return this.shipments.size;
  }
}

export interface OrderServices {
  inventory: InventoryService;
  payment: PaymentService;
  shipping: ShippingService;
}

/* ------------------------------------------------------------------------ */
/* Shared retry: compensations must eventually succeed, so they are retried */
/* with exponential backoff. sleep is injected; no timers in library code.  */
/* ------------------------------------------------------------------------ */

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultRetry: RetryPolicy = { attempts: 3, baseDelayMs: 100, sleep: () => Promise.resolve() };

export async function retry(
  fn: () => void | Promise<void>,
  policy: RetryPolicy,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let error = '';
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      await fn();
      return { ok: true };
    } catch (err) {
      error = messageOf(err);
      if (attempt < policy.attempts) await policy.sleep(policy.baseDelayMs * 2 ** (attempt - 1));
    }
  }
  return { ok: false, error };
}

/* ------------------------------------------------------------------------ */
/* 1. ORCHESTRATION: one coordinator knows the steps and drives them.       */
/* ------------------------------------------------------------------------ */

export interface SagaStep<C> {
  readonly name: string;
  execute(ctx: C): void | Promise<void>;
  compensate(ctx: C): void | Promise<void>;
}

export type SagaStatus = 'STARTED' | 'COMPENSATING' | 'COMPLETED' | 'FAILED';

/** The only legal moves. COMPLETED and FAILED are terminal. */
const TRANSITIONS: Record<SagaStatus, readonly SagaStatus[]> = {
  STARTED: ['COMPLETED', 'COMPENSATING'],
  COMPENSATING: ['FAILED'],
  COMPLETED: [],
  FAILED: [],
};

/** Persisted after every step, so a crashed coordinator resumes instead of starting over. */
export interface SagaState {
  sagaId: string;
  status: SagaStatus;
  completedSteps: string[];
  compensatedSteps: string[];
  failedStep?: string;
  lastError?: string;
  history: SagaStatus[];
}

export interface SagaStore {
  load(sagaId: string): SagaState | undefined;
  save(state: SagaState): void;
}

/** Stores copies, like a database row would: nobody can mutate persisted state by reference. */
export class InMemorySagaStore implements SagaStore {
  private readonly rows = new Map<string, SagaState>();

  load(sagaId: string): SagaState | undefined {
    const row = this.rows.get(sagaId);
    return row ? structuredClone(row) : undefined;
  }

  save(state: SagaState): void {
    this.rows.set(state.sagaId, structuredClone(state));
  }
}

function transition(state: SagaState, to: SagaStatus): void {
  if (!TRANSITIONS[state.status].includes(to)) {
    throw new IllegalTransitionError(`saga ${state.sagaId}: ${state.status} -> ${to}`);
  }
  state.status = to;
  state.history.push(to);
}

export class SagaOrchestrator<C> {
  constructor(
    private readonly steps: readonly SagaStep<C>[],
    private readonly store: SagaStore,
    private readonly compensationRetry: RetryPolicy = defaultRetry,
  ) {}

  async run(sagaId: string, ctx: C): Promise<SagaState> {
    const state = this.store.load(sagaId) ?? this.start(sagaId);
    if (state.status === 'COMPLETED' || state.status === 'FAILED') return state; // replayed request
    if (state.status === 'COMPENSATING') return this.compensate(state, ctx); // resume a stuck rollback

    for (const step of this.steps) {
      if (state.completedSteps.includes(step.name)) continue; // resume after a crash
      try {
        await step.execute(ctx);
      } catch (err) {
        state.failedStep = step.name;
        state.lastError = messageOf(err);
        transition(state, 'COMPENSATING');
        this.store.save(state);
        return this.compensate(state, ctx);
      }
      state.completedSteps.push(step.name);
      this.store.save(state);
    }
    transition(state, 'COMPLETED');
    this.store.save(state);
    return state;
  }

  private start(sagaId: string): SagaState {
    const state: SagaState = { sagaId, status: 'STARTED', completedSteps: [], compensatedSteps: [], history: ['STARTED'] };
    this.store.save(state);
    return state;
  }

  /** Undo completed steps in reverse. The failed step itself is not compensated: it did not commit. */
  private async compensate(state: SagaState, ctx: C): Promise<SagaState> {
    for (const name of [...state.completedSteps].reverse()) {
      if (state.compensatedSteps.includes(name)) continue;
      const step = this.steps.find((s) => s.name === name);
      if (!step) throw new Error(`saga ${state.sagaId}: unknown step ${name}`);
      const result = await retry(() => step.compensate(ctx), this.compensationRetry);
      if (!result.ok) {
        // Stay in COMPENSATING: the persisted state tells an operator (or the next run) where to resume.
        state.lastError = `compensating ${name}: ${result.error}`;
        this.store.save(state);
        return state;
      }
      state.compensatedSteps.push(name);
      this.store.save(state);
    }
    transition(state, 'FAILED');
    this.store.save(state);
    return state;
  }
}

/** The order saga's steps as plain objects: in TypeScript a step needs no class of its own. */
export function orderSagaSteps({ inventory, payment, shipping }: OrderServices): SagaStep<OrderContext>[] {
  return [
    {
      name: 'reserve-inventory',
      execute: (c) => inventory.reserve(c.orderId, c.lines),
      compensate: (c) => inventory.release(c.orderId),
    },
    {
      name: 'charge-payment',
      execute: (c) => payment.charge(c.orderId, c.amountMinor),
      compensate: (c) => payment.refund(c.orderId),
    },
    {
      name: 'schedule-shipping',
      execute: (c) => shipping.schedule(c.orderId, c.address),
      compensate: (c) => shipping.cancel(c.orderId),
    },
  ];
}

/* ------------------------------------------------------------------------ */
/* 2. CHOREOGRAPHY: no coordinator. Each service reacts to events and emits  */
/* its own; compensation is triggered by failure events flowing backwards.   */
/* ------------------------------------------------------------------------ */

export type OrderEvent =
  | { type: 'OrderPlaced'; order: OrderContext }
  | { type: 'InventoryReserved'; order: OrderContext }
  | { type: 'InventoryRejected'; orderId: string; reason: string }
  | { type: 'PaymentCaptured'; order: OrderContext }
  | { type: 'PaymentFailed'; orderId: string; reason: string }
  | { type: 'ShipmentScheduled'; orderId: string }
  | { type: 'ShipmentFailed'; orderId: string; reason: string }
  | { type: 'PaymentRefunded'; orderId: string }
  | { type: 'InventoryReleased'; orderId: string }
  | { type: 'CompensationStuck'; orderId: string; step: string; reason: string };

export type OrderEventType = OrderEvent['type'];
type EventOf<T extends OrderEventType> = Extract<OrderEvent, { type: T }>;
type AnyHandler = (event: OrderEvent) => void | Promise<void>;

/** Delivers in publish order; events published by a handler are queued, not delivered re-entrantly. */
export class InMemoryEventBus {
  readonly log: OrderEventType[] = [];
  private readonly handlers = new Map<OrderEventType, AnyHandler[]>();
  private readonly queue: OrderEvent[] = [];
  private draining = false;

  subscribe<T extends OrderEventType>(type: T, handler: (event: EventOf<T>) => void | Promise<void>): void {
    const list = this.handlers.get(type) ?? [];
    list.push((event) => handler(event as EventOf<T>)); // safe: only events of `type` reach this list
    this.handlers.set(type, list);
  }

  async publish(event: OrderEvent): Promise<void> {
    this.log.push(event.type);
    this.queue.push(event);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        for (const handler of this.handlers.get(next.type) ?? []) await handler(next);
      }
    } finally {
      this.draining = false;
    }
  }
}

export type OrderOutcome = 'PENDING' | 'COMPLETED' | 'FAILED' | 'STUCK';

/** The order service's view: it only learns the outcome from events. */
export class OrderTracker {
  private readonly outcomes = new Map<string, OrderOutcome>();
  set(orderId: string, outcome: OrderOutcome): void {
    this.outcomes.set(orderId, outcome);
  }
  outcome(orderId: string): OrderOutcome {
    return this.outcomes.get(orderId) ?? 'PENDING';
  }
}

export function wireChoreography(
  bus: InMemoryEventBus,
  { inventory, payment, shipping }: OrderServices,
  compensationRetry: RetryPolicy = defaultRetry,
): OrderTracker {
  const tracker = new OrderTracker();
  const attempt = (fn: () => void): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (err) {
      return messageOf(err);
    }
  };
  const compensate = async (orderId: string, step: string, fn: () => void, done: OrderEvent) => {
    const result = await retry(fn, compensationRetry);
    await bus.publish(result.ok ? done : { type: 'CompensationStuck', orderId, step, reason: result.error });
  };

  // Inventory service
  bus.subscribe('OrderPlaced', async ({ order }) => {
    const reason = attempt(() => inventory.reserve(order.orderId, order.lines));
    await bus.publish(reason ? { type: 'InventoryRejected', orderId: order.orderId, reason } : { type: 'InventoryReserved', order });
  });
  const release = ({ orderId }: { orderId: string }) =>
    compensate(orderId, 'reserve-inventory', () => inventory.release(orderId), { type: 'InventoryReleased', orderId });
  bus.subscribe('PaymentFailed', release);
  bus.subscribe('PaymentRefunded', release);

  // Payment service
  bus.subscribe('InventoryReserved', async ({ order }) => {
    const reason = attempt(() => payment.charge(order.orderId, order.amountMinor));
    await bus.publish(reason ? { type: 'PaymentFailed', orderId: order.orderId, reason } : { type: 'PaymentCaptured', order });
  });
  bus.subscribe('ShipmentFailed', ({ orderId }) =>
    compensate(orderId, 'charge-payment', () => payment.refund(orderId), { type: 'PaymentRefunded', orderId }),
  );

  // Shipping service
  bus.subscribe('PaymentCaptured', async ({ order }) => {
    const reason = attempt(() => shipping.schedule(order.orderId, order.address));
    await bus.publish(reason ? { type: 'ShipmentFailed', orderId: order.orderId, reason } : { type: 'ShipmentScheduled', orderId: order.orderId });
  });

  // Order service: derives the outcome
  bus.subscribe('ShipmentScheduled', ({ orderId }) => tracker.set(orderId, 'COMPLETED'));
  bus.subscribe('InventoryRejected', ({ orderId }) => tracker.set(orderId, 'FAILED'));
  bus.subscribe('InventoryReleased', ({ orderId }) => tracker.set(orderId, 'FAILED'));
  bus.subscribe('CompensationStuck', ({ orderId }) => tracker.set(orderId, 'STUCK'));
  return tracker;
}

/** Map an orchestrated saga's status onto the choreography outcome, to compare the two styles. */
export function outcomeOf(state: SagaState): OrderOutcome {
  if (state.status === 'COMPLETED') return 'COMPLETED';
  if (state.status === 'FAILED') return 'FAILED';
  return state.status === 'COMPENSATING' ? 'STUCK' : 'PENDING';
}
