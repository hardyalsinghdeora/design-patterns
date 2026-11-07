/**
 * OBSERVER
 * A subject keeps a list of observers and notifies all of them when something
 * happens, without knowing what they are. OrderService announces OrderPlaced;
 * email, analytics and inventory react, and the service imports none of them.
 *
 * Example domain: order domain events. Amounts are integers in minor units (paise).
 */

/* ------------------------------------------------------------------------ */
/* The subject: a typed, generic event emitter                               */
/* ------------------------------------------------------------------------ */

/** Observer, idiomatic TypeScript form: a function that receives the payload. */
export type Listener<T> = (payload: T) => void;

/** Observer, classic GoF form: an object with one `update` method (the DOM calls it `handleEvent`). */
export interface Observer<T> {
  update(payload: T): void;
}

/** The emitter accepts either form, as `addEventListener` and RxJS's `subscribe` do. */
export type Subscriber<T> = Listener<T> | Observer<T>;

export type Unsubscribe = () => void;

/**
 * Event name -> payload type. All of the emitter's type safety comes from this
 * one map. Declare it with `type`, not `interface`: interfaces have no implicit
 * index signature, so they do not satisfy `Record<string, unknown>`.
 */
export type EventMap = Record<string, unknown>;

export interface ListenerFailure {
  event: string;
  listener: string;
  error: unknown;
}

export interface EmitReport {
  event: string;
  delivered: number;
  failures: ListenerFailure[];
}

/** The half of the emitter that observers get: they can subscribe, only the subject emits. */
export interface Subscribable<Events extends EventMap> {
  on<K extends keyof Events & string>(event: K, subscriber: Subscriber<Events[K]>): Unsubscribe;
  once<K extends keyof Events & string>(event: K, subscriber: Subscriber<Events[K]>): Unsubscribe;
  off<K extends keyof Events & string>(event: K, subscriber: Subscriber<Events[K]>): boolean;
}

export interface EmitterOptions {
  /** Where isolated failures go: a logger, a metric, a retry queue. */
  onListenerError?: (failure: ListenerFailure) => void;
}

interface Registration {
  readonly once: boolean;
}

export class EventEmitter<Events extends EventMap> implements Subscribable<Events> {
  // One insertion-ordered map per event: listeners run in subscription order,
  // and a subscriber is a key, so it can only be registered once per event.
  private readonly registry: { [K in keyof Events]?: Map<Subscriber<Events[K]>, Registration> } = {};

  constructor(private readonly options: EmitterOptions = {}) {}

  on<K extends keyof Events & string>(event: K, subscriber: Subscriber<Events[K]>): Unsubscribe {
    return this.add(event, subscriber, false);
  }

  /** Delivered at most once: removed before it is called, so even a throwing listener cannot run twice. */
  once<K extends keyof Events & string>(event: K, subscriber: Subscriber<Events[K]>): Unsubscribe {
    return this.add(event, subscriber, true);
  }

  off<K extends keyof Events & string>(event: K, subscriber: Subscriber<Events[K]>): boolean {
    return this.registry[event]?.delete(subscriber) ?? false;
  }

  listenerCount(event: keyof Events & string): number {
    return this.registry[event]?.size ?? 0;
  }

  /**
   * Notify every subscriber of `event`. A throwing subscriber is isolated: the
   * others still run, and the failure is reported instead of reaching the
   * publisher. (Node's EventEmitter rethrows and skips the remaining listeners.)
   */
  emit<K extends keyof Events & string>(event: K, payload: Events[K]): EmitReport {
    const report: EmitReport = { event, delivered: 0, failures: [] };
    const registrations = this.registry[event];
    if (!registrations) return report;

    // Snapshot: subscribing or unsubscribing during this emit affects the next one, not this one.
    for (const [subscriber, registration] of [...registrations]) {
      if (registration.once) registrations.delete(subscriber);
      try {
        if (typeof subscriber === 'function') subscriber(payload);
        else subscriber.update(payload);
        report.delivered += 1;
      } catch (error) {
        const failure: ListenerFailure = { event, listener: nameOf(subscriber), error };
        report.failures.push(failure);
        this.options.onListenerError?.(failure);
      }
    }
    return report;
  }

  private add<K extends keyof Events & string>(event: K, subscriber: Subscriber<Events[K]>, once: boolean): Unsubscribe {
    // Typed explicitly: TypeScript cannot carry a narrowing through a mapped type indexed by a generic key.
    const registrations: Map<Subscriber<Events[K]>, Registration> = this.registry[event] ?? new Map();
    this.registry[event] = registrations;
    // Subscribing twice is a no-op, as with the DOM's addEventListener. Node's
    // EventEmitter would call the listener twice: the classic double email.
    const registration = registrations.get(subscriber) ?? { once };
    registrations.set(subscriber, registration);

    // The handle removes this registration only, never a later re-subscription.
    return () => {
      if (registrations.get(subscriber) === registration) registrations.delete(subscriber);
    };
  }
}

function nameOf<T>(subscriber: Subscriber<T>): string {
  if (typeof subscriber === 'function') return subscriber.name || 'anonymous listener';
  return subscriber.constructor.name;
}

/* ------------------------------------------------------------------------ */
/* The concrete subject: an order service that announces domain events       */
/* ------------------------------------------------------------------------ */

export interface OrderLine {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

export interface Order {
  readonly id: string;
  readonly customerEmail: string;
  readonly lines: readonly OrderLine[];
  readonly totalMinor: number;
  readonly status: 'PLACED' | 'CANCELLED';
  readonly placedAt: Date;
}

/** Push style: the event carries everything a listener needs, so nobody calls back into the service. */
export interface OrderPlaced {
  readonly orderId: string;
  readonly customerEmail: string;
  readonly lines: readonly OrderLine[];
  readonly totalMinor: number;
  readonly placedAt: Date;
}

/** Pull style: a thin event. A listener that needs more asks the subject (`getOrder`). */
export interface OrderCancelled {
  readonly orderId: string;
  readonly reason: string;
}

export type OrderEvents = {
  OrderPlaced: OrderPlaced;
  OrderCancelled: OrderCancelled;
};

export interface OrderServiceDeps {
  now: () => Date;
  nextId: () => string;
  onListenerError?: (failure: ListenerFailure) => void;
}

export class OrderService {
  private readonly emitter: EventEmitter<OrderEvents>;
  private readonly orders = new Map<string, Order>();

  constructor(private readonly deps: OrderServiceDeps) {
    this.emitter = new EventEmitter<OrderEvents>({ onListenerError: deps.onListenerError });
  }

  /** Observers may subscribe. Only the service announces its own events, so `emit` is not exposed. */
  get events(): Subscribable<OrderEvents> {
    return this.emitter;
  }

  placeOrder(customerEmail: string, lines: readonly OrderLine[]): Order {
    if (lines.length === 0) throw new Error('An order needs at least one line');
    const order: Order = {
      id: this.deps.nextId(),
      customerEmail,
      lines: [...lines],
      totalMinor: lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0),
      status: 'PLACED',
      placedAt: this.deps.now(),
    };
    // Commit first, announce second: a listener must never see an order that was not saved.
    this.orders.set(order.id, order);
    this.emitter.emit('OrderPlaced', {
      orderId: order.id,
      customerEmail,
      lines: order.lines,
      totalMinor: order.totalMinor,
      placedAt: order.placedAt,
    });
    return order;
  }

  cancelOrder(orderId: string, reason: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    if (order.status === 'CANCELLED') return order; // idempotent: no second event
    const cancelled: Order = { ...order, status: 'CANCELLED' };
    this.orders.set(orderId, cancelled);
    this.emitter.emit('OrderCancelled', { orderId, reason });
    return cancelled;
  }

  /** The query side that pull-style observers use. */
  getOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }
}

/* ------------------------------------------------------------------------ */
/* Concrete observers. OrderService imports none of them.                     */
/* ------------------------------------------------------------------------ */

/** Stands in for an SES/SMTP client. It may throw: providers have outages. */
export type SendEmail = (to: string, subject: string) => void;

export class ConfirmationEmailer implements Observer<OrderPlaced> {
  constructor(private readonly send: SendEmail) {}

  update(event: OrderPlaced): void {
    this.send(event.customerEmail, `Order ${event.orderId} confirmed: ${formatRupees(event.totalMinor)}`);
  }
}

export class SalesAnalytics implements Observer<OrderPlaced> {
  private orders = 0;
  private revenueMinor = 0;

  update(event: OrderPlaced): void {
    this.orders += 1;
    this.revenueMinor += event.totalMinor;
  }

  recordCancellation(order: Order): void {
    this.orders -= 1;
    this.revenueMinor -= order.totalMinor;
  }

  get totals(): { orders: number; revenueMinor: number } {
    return { orders: this.orders, revenueMinor: this.revenueMinor };
  }
}

export class InventoryReserver implements Observer<OrderPlaced> {
  /** orderId -> sku -> quantity, so a cancellation releases exactly what was reserved. */
  private readonly reservations = new Map<string, Map<string, number>>();

  constructor(private readonly stock: Map<string, number>) {}

  update(event: OrderPlaced): void {
    const wanted = quantitiesBySku(event.lines);
    // Check every line before changing anything, so a failure leaves stock untouched.
    for (const [sku, quantity] of wanted) {
      const available = this.available(sku);
      if (available < quantity) throw new Error(`Only ${available} of ${sku} left, ${quantity} ordered`);
    }
    for (const [sku, quantity] of wanted) this.stock.set(sku, this.available(sku) - quantity);
    this.reservations.set(event.orderId, wanted);
  }

  /** Idempotent: an order that reserved nothing, or was already released, changes nothing. */
  release(orderId: string): void {
    const reserved = this.reservations.get(orderId);
    if (!reserved) return;
    for (const [sku, quantity] of reserved) this.stock.set(sku, this.available(sku) + quantity);
    this.reservations.delete(orderId);
  }

  available(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }
}

export interface OrderListeners {
  emailer: ConfirmationEmailer;
  analytics: SalesAnalytics;
  inventory: InventoryReserver;
}

/**
 * The composition root: the one place that knows both the subject and its
 * observers. Returns a single handle that detaches all of them.
 */
export function wireOrderListeners(service: OrderService, { emailer, analytics, inventory }: OrderListeners): Unsubscribe {
  const handles = [
    // Push: OrderPlaced carries everything these three need.
    service.events.on('OrderPlaced', inventory),
    service.events.on('OrderPlaced', emailer),
    service.events.on('OrderPlaced', analytics),
    // OrderCancelled carries only the id. Inventory kept its own reservation, so the id is enough.
    service.events.on('OrderCancelled', function releaseStock({ orderId }) {
      inventory.release(orderId);
    }),
    // Pull: analytics needs the total, so it asks the subject for the order.
    service.events.on('OrderCancelled', function reverseRevenue({ orderId }) {
      const order = service.getOrder(orderId);
      if (order) analytics.recordCancellation(order);
    }),
  ];
  return () => handles.forEach((unsubscribe) => unsubscribe());
}

function quantitiesBySku(lines: readonly OrderLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.quantity);
  return totals;
}

/** 49800 -> "Rs 498.00". Integer arithmetic; formatting is the only place rupees appear. */
export function formatRupees(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}Rs ${Math.trunc(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}
