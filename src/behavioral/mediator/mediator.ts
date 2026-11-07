/**
 * MEDIATOR
 * Components never call each other; they report to one mediator, which owns the
 * interaction rules. Inventory, Payment, Shipping and Notification share no imports.
 *
 * Example domain: fulfilling an order (reserve stock, charge, ship, notify, compensate).
 * Amounts are integers in minor units (paise).
 */

/* ------------------------------------------------------------------------ */
/* The two roles                                                             */
/* ------------------------------------------------------------------------ */

export interface Message {
  readonly type: string;
}

/** The mediator interface: the only thing a component knows about the outside world. */
export interface Mediator<E extends Message> {
  notify(sender: string, event: E): void;
}

/** A colleague. It holds a reference to the mediator and to nothing else in the system. */
export abstract class Component<E extends Message> {
  abstract readonly name: string;
  private mediator: Mediator<E> | undefined;

  attach(mediator: Mediator<E>): void {
    this.mediator = mediator;
  }

  protected emit(event: E): void {
    if (!this.mediator) throw new Error(`${this.name} is not attached to a mediator`);
    this.mediator.notify(this.name, event);
  }
}

/* ------------------------------------------------------------------------ */
/* Order fulfilment                                                          */
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
}

/** What components report. A discriminated union, so the mediator's switch is exhaustive. */
export type FulfilmentEvent =
  | { readonly type: 'OrderSubmitted'; readonly order: Order }
  | { readonly type: 'StockReserved'; readonly orderId: string }
  | { readonly type: 'StockUnavailable'; readonly orderId: string; readonly reason: string }
  | { readonly type: 'PaymentCaptured'; readonly orderId: string; readonly paymentId: string }
  | { readonly type: 'PaymentFailed'; readonly orderId: string; readonly reason: string }
  | { readonly type: 'ShipmentBooked'; readonly orderId: string; readonly trackingId: string }
  | { readonly type: 'ShipmentFailed'; readonly orderId: string; readonly reason: string };

export class InventoryComponent extends Component<FulfilmentEvent> {
  readonly name = 'inventory';
  private readonly reservations = new Map<string, Map<string, number>>();

  constructor(private readonly stock: Map<string, number>) {
    super();
  }

  reserve(order: Order): void {
    const wanted = new Map<string, number>();
    for (const line of order.lines) wanted.set(line.sku, (wanted.get(line.sku) ?? 0) + line.quantity);
    for (const [sku, quantity] of wanted) {
      if (this.available(sku) < quantity) {
        this.emit({ type: 'StockUnavailable', orderId: order.id, reason: `${sku}: ${this.available(sku)} left, ${quantity} wanted` });
        return;
      }
    }
    for (const [sku, quantity] of wanted) this.stock.set(sku, this.available(sku) - quantity);
    this.reservations.set(order.id, wanted);
    this.emit({ type: 'StockReserved', orderId: order.id });
  }

  /** Idempotent compensation: releasing twice, or releasing nothing, is safe. */
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

export type GatewayResult = { ok: true; reference: string } | { ok: false; reason: string };
export interface PaymentGateway {
  charge(orderId: string, amountMinor: number): GatewayResult;
  refund(paymentId: string, amountMinor: number): void;
}

export class PaymentComponent extends Component<FulfilmentEvent> {
  readonly name = 'payment';

  constructor(private readonly gateway: PaymentGateway) {
    super();
  }

  charge(orderId: string, amountMinor: number): void {
    const result = this.gateway.charge(orderId, amountMinor);
    if (result.ok) this.emit({ type: 'PaymentCaptured', orderId, paymentId: result.reference });
    else this.emit({ type: 'PaymentFailed', orderId, reason: result.reason });
  }

  refund(paymentId: string, amountMinor: number): void {
    this.gateway.refund(paymentId, amountMinor);
  }
}

export type BookCourier = (order: Order) => GatewayResult;

export class ShippingComponent extends Component<FulfilmentEvent> {
  readonly name = 'shipping';

  constructor(private readonly bookCourier: BookCourier) {
    super();
  }

  book(order: Order): void {
    const result = this.bookCourier(order);
    if (result.ok) this.emit({ type: 'ShipmentBooked', orderId: order.id, trackingId: result.reference });
    else this.emit({ type: 'ShipmentFailed', orderId: order.id, reason: result.reason });
  }
}

export class NotificationComponent extends Component<FulfilmentEvent> {
  readonly name = 'notifications';

  constructor(private readonly sendEmail: (to: string, text: string) => void) {
    super();
  }

  send(to: string, text: string): void {
    this.sendEmail(to, text);
  }
}

export interface FulfilmentComponents {
  inventory: InventoryComponent;
  payment: PaymentComponent;
  shipping: ShippingComponent;
  notifications: NotificationComponent;
}

export type FulfilmentStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface FulfilmentRecord {
  readonly order: Order;
  readonly status: FulfilmentStatus;
  readonly paymentId?: string;
  readonly trackingId?: string;
  readonly failureReason?: string;
}

/**
 * The concrete mediator. Every rule about *who reacts to what, in which order,
 * and how to undo on failure* lives here and nowhere else.
 */
export class OrderFulfilmentMediator implements Mediator<FulfilmentEvent> {
  /** `sender:EventType` in processing order; tests and logs read the conversation from it. */
  readonly trace: string[] = [];
  private readonly records = new Map<string, FulfilmentRecord>();
  // Run-to-completion queue: a component's call returns before the next step
  // starts, so the order of steps is the order of events, not a deep call stack.
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(protected readonly components: FulfilmentComponents) {
    const { inventory, payment, shipping, notifications } = components;
    for (const component of [inventory, payment, shipping, notifications]) component.attach(this);
  }

  submit(order: Order): FulfilmentRecord {
    if (this.records.has(order.id)) throw new Error(`Order ${order.id} was already submitted`);
    this.records.set(order.id, { order, status: 'PENDING' });
    this.notify('client', { type: 'OrderSubmitted', order });
    return this.status(order.id);
  }

  status(orderId: string): FulfilmentRecord {
    const record = this.records.get(orderId);
    if (!record) throw new Error(`Unknown order ${orderId}`);
    return { ...record };
  }

  notify(sender: string, event: FulfilmentEvent): void {
    this.enqueue(sender, event.type, () => this.handle(event));
  }

  protected enqueue(sender: string, type: string, step: () => void): void {
    this.trace.push(`${sender}:${type}`);
    this.queue.push(step);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) next();
    } finally {
      this.draining = false;
      this.queue.length = 0; // a throwing step must not leave half a conversation queued
    }
  }

  protected handle(event: FulfilmentEvent): void {
    const { inventory, shipping, notifications } = this.components;
    switch (event.type) {
      case 'OrderSubmitted':
        return inventory.reserve(event.order);
      case 'StockReserved':
        return this.capturePayment(event.orderId);
      case 'StockUnavailable':
        return this.fail(event.orderId, event.reason);
      case 'PaymentCaptured':
        this.update(event.orderId, { paymentId: event.paymentId });
        return shipping.book(this.record(event.orderId).order);
      case 'PaymentFailed':
        return this.fail(event.orderId, event.reason);
      case 'ShipmentBooked': {
        const { order } = this.update(event.orderId, { trackingId: event.trackingId, status: 'COMPLETED' });
        return notifications.send(order.customerEmail, `Order ${order.id} shipped, tracking ${event.trackingId}`);
      }
      case 'ShipmentFailed':
        return this.fail(event.orderId, event.reason);
      default:
        return assertNever(event);
    }
  }

  /** Protected so a subclass can insert a step before payment (see FraudCheckedFulfilmentMediator). */
  protected capturePayment(orderId: string): void {
    const { order } = this.record(orderId);
    this.components.payment.charge(order.id, order.totalMinor);
  }

  /** Compensate in reverse order of acquisition: refund, then release stock, then tell the customer. */
  protected fail(orderId: string, reason: string): void {
    const record = this.update(orderId, { status: 'FAILED', failureReason: reason });
    const { payment, inventory, notifications } = this.components;
    if (record.paymentId) payment.refund(record.paymentId, record.order.totalMinor);
    inventory.release(orderId);
    notifications.send(record.order.customerEmail, `Order ${orderId} could not be fulfilled: ${reason}`);
  }

  protected record(orderId: string): FulfilmentRecord {
    const record = this.records.get(orderId);
    if (!record) throw new Error(`Unknown order ${orderId}`);
    return record;
  }

  private update(orderId: string, patch: Partial<Omit<FulfilmentRecord, 'order'>>): FulfilmentRecord {
    const next = { ...this.record(orderId), ...patch };
    this.records.set(orderId, next);
    return next;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled event ${JSON.stringify(value)}`);
}

/* ------------------------------------------------------------------------ */
/* Adding a component: fraud screening between stock and payment.            */
/* Inventory, Payment, Shipping and Notification are not edited.             */
/* ------------------------------------------------------------------------ */

export type FraudEvent =
  | { readonly type: 'FraudCleared'; readonly orderId: string }
  | { readonly type: 'FraudRejected'; readonly orderId: string; readonly reason: string };

export class FraudCheckComponent extends Component<FraudEvent> {
  readonly name = 'fraud';

  constructor(
    private readonly score: (order: Order) => number,
    private readonly maxScore: number,
  ) {
    super();
  }

  assess(order: Order): void {
    const score = this.score(order);
    if (score <= this.maxScore) this.emit({ type: 'FraudCleared', orderId: order.id });
    else this.emit({ type: 'FraudRejected', orderId: order.id, reason: `fraud score ${score} > ${this.maxScore}` });
  }
}

export class FraudCheckedFulfilmentMediator extends OrderFulfilmentMediator implements Mediator<FraudEvent> {
  constructor(
    components: FulfilmentComponents,
    private readonly fraud: FraudCheckComponent,
  ) {
    super(components);
    fraud.attach(this);
  }

  override notify(sender: string, event: FulfilmentEvent | FraudEvent): void {
    if (event.type === 'FraudCleared' || event.type === 'FraudRejected') {
      this.enqueue(sender, event.type, () => this.handleFraud(event));
    } else {
      super.notify(sender, event);
    }
  }

  protected override handle(event: FulfilmentEvent): void {
    // The one rule that changes: stock reserved -> screen first, pay later.
    if (event.type === 'StockReserved') return this.fraud.assess(this.record(event.orderId).order);
    super.handle(event);
  }

  private handleFraud(event: FraudEvent): void {
    if (event.type === 'FraudCleared') this.capturePayment(event.orderId);
    else this.fail(event.orderId, event.reason);
  }
}

/* ------------------------------------------------------------------------ */
/* Mini example: a chat room. Users never hold references to each other.     */
/* ------------------------------------------------------------------------ */

export type ChatEvent = { readonly type: 'Message'; readonly text: string; readonly to?: string };

export class ChatUser extends Component<ChatEvent> {
  readonly inbox: string[] = [];

  constructor(readonly name: string) {
    super();
  }

  say(text: string): void {
    this.emit({ type: 'Message', text });
  }

  whisper(to: string, text: string): void {
    this.emit({ type: 'Message', text, to });
  }

  receive(from: string, text: string): void {
    this.inbox.push(`${from}: ${text}`);
  }
}

export class ChatRoom implements Mediator<ChatEvent> {
  private readonly members = new Map<string, ChatUser>();

  join(user: ChatUser): this {
    user.attach(this);
    this.members.set(user.name, user);
    return this;
  }

  leave(name: string): void {
    this.members.delete(name);
  }

  /** Routing rules live in the room: broadcast skips the sender; a whisper reaches one member or bounces. */
  notify(sender: string, event: ChatEvent): void {
    if (event.to !== undefined) {
      const recipient = this.members.get(event.to);
      if (recipient) recipient.receive(`${sender} (private)`, event.text);
      else this.members.get(sender)?.receive('room', `${event.to} is not in the room`);
      return;
    }
    for (const member of this.members.values()) if (member.name !== sender) member.receive(sender, event.text);
  }
}
