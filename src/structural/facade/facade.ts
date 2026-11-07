/**
 * FACADE
 * One simple entry point (CheckoutFacade.placeOrder) in front of several subsystems that must be
 * called in the right order, with compensation when a later step fails.
 *
 * Example domain: checkout across inventory, payments, shipping and notifications.
 * Amounts are integers in minor units (paise). The subsystems stay public: a facade is a
 * convenience for the common path, not a wall around them.
 */

export interface LineItem {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

export interface Address {
  readonly name: string;
  readonly line1: string;
  readonly city: string;
  readonly postcode: string;
}

export interface CheckoutRequest {
  readonly orderId: string;
  readonly customerEmail: string;
  readonly items: readonly LineItem[];
  readonly address: Address;
  readonly paymentToken: string;
}

/** Every subsystem appends `subsystem.method` here, so tests and the demo can see the call sequence. */
export type CallLog = string[];
export type IdGenerator = (prefix: string) => string;

export const sequentialIds = (): IdGenerator => {
  let n = 0;
  return (prefix) => `${prefix}_${++n}`;
};

export class OutOfStockError extends Error {
  constructor(readonly sku: string, readonly requested: number, readonly available: number) {
    super(`Only ${available} of ${sku} left, ${requested} requested`);
    this.name = 'OutOfStockError';
  }
}

export class PaymentDeclinedError extends Error {
  constructor(readonly reason: string) {
    super(`Payment declined: ${reason}`);
    this.name = 'PaymentDeclinedError';
  }
}

export class NotServiceableError extends Error {
  constructor(readonly postcode: string) {
    super(`We do not deliver to ${postcode} yet`);
    this.name = 'NotServiceableError';
  }
}

/* ------------------------------------------------------------------------ */
/* Subsystems. Each is a perfectly good API on its own; the trouble is that  */
/* checkout needs all four, in order, with rollback.                         */
/* ------------------------------------------------------------------------ */

export class InventoryService {
  private readonly stock: Map<string, number>;
  private readonly reservations = new Map<string, ReadonlyMap<string, number>>();

  constructor(private readonly log: CallLog, private readonly ids: IdGenerator, initialStock: Record<string, number>) {
    this.stock = new Map(Object.entries(initialStock));
  }

  available(sku: string): number {
    return this.stock.get(sku) ?? 0;
  }

  restock(sku: string, quantity: number): void {
    this.log.push('inventory.restock');
    this.stock.set(sku, this.available(sku) + quantity);
  }

  /** All or nothing: a reservation that cannot be met in full holds no stock at all. */
  reserve(items: readonly LineItem[]): string {
    this.log.push('inventory.reserve');
    const wanted = new Map<string, number>();
    for (const item of items) wanted.set(item.sku, (wanted.get(item.sku) ?? 0) + item.quantity);
    for (const [sku, quantity] of wanted) {
      if (this.available(sku) < quantity) throw new OutOfStockError(sku, quantity, this.available(sku));
    }
    for (const [sku, quantity] of wanted) this.stock.set(sku, this.available(sku) - quantity);
    const id = this.ids('res');
    this.reservations.set(id, wanted);
    return id;
  }

  commit(reservationId: string): void {
    this.log.push('inventory.commit');
    if (!this.reservations.delete(reservationId)) throw new Error(`Unknown reservation ${reservationId}`);
  }

  release(reservationId: string): void {
    this.log.push('inventory.release');
    const held = this.reservations.get(reservationId);
    if (!held) return; // idempotent: releasing twice is harmless
    for (const [sku, quantity] of held) this.stock.set(sku, this.available(sku) + quantity);
    this.reservations.delete(reservationId);
  }

  get openReservations(): number {
    return this.reservations.size;
  }
}

export type PaymentStatus = 'authorized' | 'captured' | 'voided';

export class PaymentGateway {
  private readonly payments = new Map<string, { amountMinor: number; status: PaymentStatus }>();

  constructor(
    private readonly log: CallLog,
    private readonly ids: IdGenerator,
    private readonly declinedTokens: ReadonlySet<string> = new Set(),
  ) {}

  authorize(token: string, amountMinor: number): string {
    this.log.push('payments.authorize');
    if (this.declinedTokens.has(token)) throw new PaymentDeclinedError('insufficient funds');
    const id = this.ids('pay');
    this.payments.set(id, { amountMinor, status: 'authorized' });
    return id;
  }

  capture(paymentId: string): void {
    this.log.push('payments.capture');
    const payment = this.payments.get(paymentId);
    if (payment?.status !== 'authorized') throw new Error(`Cannot capture ${paymentId}`);
    payment.status = 'captured';
  }

  void(paymentId: string): void {
    this.log.push('payments.void');
    const payment = this.payments.get(paymentId);
    if (payment?.status === 'authorized') payment.status = 'voided';
  }

  status(paymentId: string): PaymentStatus | undefined {
    return this.payments.get(paymentId)?.status;
  }

  amountOf(paymentId: string): number | undefined {
    return this.payments.get(paymentId)?.amountMinor;
  }
}

export class ShippingService {
  static readonly FLAT_RATE_MINOR = 4_900;
  static readonly FREE_ABOVE_MINOR = 999 * 100;
  /** Flip to false to simulate the carrier API being down. */
  carrierAvailable = true;
  private readonly shipments = new Map<string, string>(); // trackingId -> orderId

  constructor(
    private readonly log: CallLog,
    private readonly ids: IdGenerator,
    private readonly serviceablePrefixes: readonly string[],
  ) {}

  quote(address: Address, subtotalMinor: number): number {
    this.log.push('shipping.quote');
    if (!this.serviceablePrefixes.some((prefix) => address.postcode.startsWith(prefix))) {
      throw new NotServiceableError(address.postcode);
    }
    return subtotalMinor >= ShippingService.FREE_ABOVE_MINOR ? 0 : ShippingService.FLAT_RATE_MINOR;
  }

  createShipment(orderId: string, _address: Address, _items: readonly LineItem[]): string {
    this.log.push('shipping.createShipment');
    if (!this.carrierAvailable) throw new Error('Carrier API timed out');
    const trackingId = this.ids('awb');
    this.shipments.set(trackingId, orderId);
    return trackingId;
  }

  cancelShipment(trackingId: string): void {
    this.log.push('shipping.cancelShipment');
    this.shipments.delete(trackingId);
  }

  get activeShipments(): number {
    return this.shipments.size;
  }
}

export class NotificationService {
  /** Flip to false to simulate the email provider being down. */
  providerAvailable = true;
  readonly outbox: Array<{ readonly to: string; readonly subject: string }> = [];

  constructor(private readonly log: CallLog) {}

  send(to: string, subject: string): void {
    this.log.push('notifications.send');
    if (!this.providerAvailable) throw new Error('Email provider returned 503');
    this.outbox.push({ to, subject });
  }
}

export interface CheckoutSubsystems {
  readonly inventory: InventoryService;
  readonly payments: PaymentGateway;
  readonly shipping: ShippingService;
  readonly notifications: NotificationService;
}

/** Wiring for the demo and tests: four subsystems sharing one call log and one id sequence. */
export function createSubsystems(options: {
  stock: Record<string, number>;
  declinedTokens?: readonly string[];
  serviceablePrefixes?: readonly string[];
}): CheckoutSubsystems & { readonly log: CallLog } {
  const log: CallLog = [];
  const ids = sequentialIds();
  return {
    log,
    inventory: new InventoryService(log, ids, options.stock),
    payments: new PaymentGateway(log, ids, new Set(options.declinedTokens ?? [])),
    shipping: new ShippingService(log, ids, options.serviceablePrefixes ?? ['56', '40', '11']),
    notifications: new NotificationService(log),
  };
}

/* ------------------------------------------------------------------------ */
/* The facade                                                                */
/* ------------------------------------------------------------------------ */

export type CheckoutStep = 'shipping-quote' | 'inventory' | 'payment' | 'shipment' | 'capture';

/** Whatever went wrong inside, the caller gets one error type that names the step. */
export class CheckoutError extends Error {
  constructor(readonly orderId: string, readonly step: CheckoutStep, cause: unknown) {
    super(`Checkout ${orderId} failed at ${step}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'CheckoutError';
  }
}

export interface Receipt {
  readonly orderId: string;
  readonly subtotalMinor: number;
  readonly shippingMinor: number;
  readonly totalMinor: number;
  readonly paymentId: string;
  readonly trackingId: string;
  /** The confirmation email is best-effort: a paid order is not cancelled because SMTP is down. */
  readonly confirmationSent: boolean;
}

export class CheckoutFacade {
  constructor(private readonly subsystems: CheckoutSubsystems) {}

  placeOrder(request: CheckoutRequest): Receipt {
    const { inventory, payments, shipping } = this.subsystems;
    const subtotalMinor = request.items.reduce((sum, item) => sum + item.unitPriceMinor * item.quantity, 0);
    const compensations: Array<() => void> = [];
    let step: CheckoutStep = 'shipping-quote';

    try {
      const shippingMinor = shipping.quote(request.address, subtotalMinor); // no side effects, so it goes first
      const totalMinor = subtotalMinor + shippingMinor;

      step = 'inventory';
      const reservationId = inventory.reserve(request.items);
      compensations.push(() => inventory.release(reservationId));

      step = 'payment';
      const paymentId = payments.authorize(request.paymentToken, totalMinor);
      compensations.push(() => payments.void(paymentId));

      step = 'shipment';
      const trackingId = shipping.createShipment(request.orderId, request.address, request.items);
      compensations.push(() => shipping.cancelShipment(trackingId));

      step = 'capture'; // money moves only once everything else has succeeded
      payments.capture(paymentId);
      inventory.commit(reservationId);

      const confirmationSent = this.sendConfirmation(request, totalMinor, trackingId);
      return { orderId: request.orderId, subtotalMinor, shippingMinor, totalMinor, paymentId, trackingId, confirmationSent };
    } catch (error) {
      for (const compensate of compensations.reverse()) compensate(); // newest first
      throw new CheckoutError(request.orderId, step, error);
    }
  }

  private sendConfirmation(request: CheckoutRequest, totalMinor: number, trackingId: string): boolean {
    try {
      this.subsystems.notifications.send(
        request.customerEmail,
        `Order ${request.orderId} confirmed: Rs ${(totalMinor / 100).toFixed(2)}, tracking ${trackingId}`,
      );
      return true;
    } catch {
      return false; // real code would enqueue a retry here
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Idiomatic TypeScript: in Node the facade is often just a module's public  */
/* surface (checkout/index.ts) exporting a few functions over private        */
/* collaborators. A closure returning a frozen object gives the same shape.  */
/* ------------------------------------------------------------------------ */

export interface CheckoutModule {
  placeOrder(request: CheckoutRequest): Receipt;
  inStock(sku: string, quantity?: number): boolean;
}

export function createCheckoutModule(subsystems: CheckoutSubsystems): CheckoutModule {
  const facade = new CheckoutFacade(subsystems);
  return Object.freeze({
    placeOrder: (request: CheckoutRequest) => facade.placeOrder(request),
    inStock: (sku: string, quantity = 1) => subsystems.inventory.available(sku) >= quantity,
  });
}
