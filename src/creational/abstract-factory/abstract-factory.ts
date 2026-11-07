/**
 * ABSTRACT FACTORY
 * One factory interface creates a family of related objects; swap the factory and every product changes together.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/* Example domain: a checkout that can run on a Razorpay-like or a Stripe-like
   gateway. Both are in-memory simulations that mimic each API's dialect
   (id prefixes, signature headers, event names); nothing talks to a network.
   Amounts are integers in minor units. */

export type ProviderName = 'razorpay' | 'stripe';

export interface ChargeRequest {
  orderId: string;
  amountMinor: number;
  currency: string;
}

/** Products carry their family in the type, so a Stripe payment cannot reach a Razorpay refund handler. */
export interface Payment<P extends ProviderName = ProviderName> {
  readonly provider: P;
  readonly id: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface Refund<P extends ProviderName = ProviderName> {
  readonly provider: P;
  readonly id: string;
  readonly paymentId: string;
  readonly amountMinor: number;
}

export type WebhookEventType = 'payment.succeeded' | 'refund.processed' | 'ignored';

/** Each family translates its own webhook dialect into this one shape. */
export interface WebhookEvent<P extends ProviderName = ProviderName> {
  readonly provider: P;
  readonly type: WebhookEventType;
  readonly objectId: string;
}

/** Lower-cased header names, as Node's http module delivers them. */
export type HttpHeaders = Readonly<Record<string, string | undefined>>;

/* --- Abstract products --- */

export interface PaymentClient<P extends ProviderName> {
  readonly provider: P;
  charge(request: ChargeRequest): Payment<P>;
}

export interface WebhookVerifier<P extends ProviderName> {
  readonly provider: P;
  verify(rawBody: string, headers: HttpHeaders): WebhookEvent<P>;
}

export interface RefundHandler<P extends ProviderName> {
  readonly provider: P;
  refund(payment: Payment<P>, amountMinor?: number): Refund<P>;
}

/* --- Abstract factory --- */

export interface PaymentProviderFactory<P extends ProviderName = ProviderName> {
  readonly provider: P;
  createPaymentClient(): PaymentClient<P>;
  createWebhookVerifier(): WebhookVerifier<P>;
  createRefundHandler(): RefundHandler<P>;
}

/** Injected so tests control ids and time; library code never reads the real clock. */
export interface RuntimeDeps {
  nextId: () => string;
  nowSeconds: () => number;
}

export interface ProviderDeps extends RuntimeDeps {
  webhookSecret: string;
}

export class WebhookSignatureError extends Error {
  constructor(
    readonly provider: ProviderName,
    reason: string,
  ) {
    super(`${provider} webhook rejected: ${reason}`);
    this.name = 'WebhookSignatureError';
  }
}

const hmacHex = (secret: string, payload: string): string => createHmac('sha256', secret).update(payload).digest('hex');

/** Constant-time comparison: a plain === leaks how many leading characters matched. */
function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

/**
 * State shared by the products of ONE factory instance. This is why products
 * from the same factory work together: the refund handler knows the payments
 * the client made, and both are bound to the same provider.
 */
export class PaymentLedger<P extends ProviderName> {
  private readonly payments = new Map<string, Payment<P>>();
  private readonly refunded = new Map<string, number>();

  constructor(readonly provider: P) {}

  record(payment: Payment<P>): void {
    this.payments.set(payment.id, payment);
  }

  /** Validates and reserves a refund; returns the amount actually refunded. */
  reserveRefund(payment: Payment<ProviderName>, requestedMinor: number | undefined): number {
    // Runtime guard for callers who erased the family type (casts, JSON, `PaymentProviderFactory` without P).
    if (payment.provider !== this.provider) {
      throw new Error(`Payment ${payment.id} belongs to ${payment.provider}, not ${this.provider}`);
    }
    const known = this.payments.get(payment.id);
    if (!known) throw new Error(`Unknown ${this.provider} payment ${payment.id}`);
    const already = this.refunded.get(payment.id) ?? 0;
    const remaining = known.amountMinor - already;
    const amount = requestedMinor ?? remaining;
    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
      throw new Error(`Refund of ${amount} exceeds the ${remaining} still refundable on ${payment.id}`);
    }
    this.refunded.set(payment.id, already + amount);
    return amount;
  }
}

/* ------------------------------------------------------------------------ */
/* Family 1: Razorpay-like. INR in paise, ids pay_/rfnd_, HMAC of the raw     */
/* body in X-Razorpay-Signature, events like "payment.captured".            */
/* ------------------------------------------------------------------------ */

interface RazorpayEventBody {
  event?: string;
  payload?: { payment?: { entity?: { id?: string } }; refund?: { entity?: { id?: string } } };
}

export class RazorpayPaymentClient implements PaymentClient<'razorpay'> {
  readonly provider = 'razorpay' as const;
  constructor(
    private readonly ledger: PaymentLedger<'razorpay'>,
    private readonly nextId: () => string,
  ) {}

  charge(request: ChargeRequest): Payment<'razorpay'> {
    if (request.currency !== 'INR') throw new Error(`razorpay: this simulated account settles INR only, got ${request.currency}`);
    if (!Number.isInteger(request.amountMinor) || request.amountMinor < 100) throw new Error('razorpay: minimum charge is 100 paise');
    const payment = { provider: this.provider, id: `pay_${this.nextId()}`, orderId: request.orderId, amountMinor: request.amountMinor, currency: 'INR' };
    this.ledger.record(payment);
    return payment;
  }
}

export class RazorpayWebhookVerifier implements WebhookVerifier<'razorpay'> {
  readonly provider = 'razorpay' as const;
  constructor(private readonly secret: string) {}

  verify(rawBody: string, headers: HttpHeaders): WebhookEvent<'razorpay'> {
    const signature = headers['x-razorpay-signature'];
    if (!signature) throw new WebhookSignatureError(this.provider, 'missing X-Razorpay-Signature header');
    if (!safeEqualHex(signature, hmacHex(this.secret, rawBody))) throw new WebhookSignatureError(this.provider, 'signature mismatch');
    const body = JSON.parse(rawBody) as RazorpayEventBody;
    const type: WebhookEventType =
      body.event === 'payment.captured' ? 'payment.succeeded' : body.event === 'refund.processed' ? 'refund.processed' : 'ignored';
    const objectId = body.payload?.payment?.entity?.id ?? body.payload?.refund?.entity?.id ?? '';
    return { provider: this.provider, type, objectId };
  }
}

export class RazorpayRefundHandler implements RefundHandler<'razorpay'> {
  readonly provider = 'razorpay' as const;
  constructor(
    private readonly ledger: PaymentLedger<'razorpay'>,
    private readonly nextId: () => string,
  ) {}

  refund(payment: Payment<'razorpay'>, amountMinor?: number): Refund<'razorpay'> {
    const amount = this.ledger.reserveRefund(payment, amountMinor);
    return { provider: this.provider, id: `rfnd_${this.nextId()}`, paymentId: payment.id, amountMinor: amount };
  }
}

export class RazorpayFactory implements PaymentProviderFactory<'razorpay'> {
  readonly provider = 'razorpay' as const;
  private readonly ledger = new PaymentLedger('razorpay' as const);
  constructor(private readonly deps: ProviderDeps) {}

  createPaymentClient(): PaymentClient<'razorpay'> {
    return new RazorpayPaymentClient(this.ledger, this.deps.nextId);
  }
  createWebhookVerifier(): WebhookVerifier<'razorpay'> {
    return new RazorpayWebhookVerifier(this.deps.webhookSecret);
  }
  createRefundHandler(): RefundHandler<'razorpay'> {
    return new RazorpayRefundHandler(this.ledger, this.deps.nextId);
  }
}

/* ------------------------------------------------------------------------ */
/* Family 2: Stripe-like. Lower-case currency codes, ids pi_/re_, a signed   */
/* timestamp in Stripe-Signature (t=...,v1=...) with a replay window.        */
/* ------------------------------------------------------------------------ */

const STRIPE_TOLERANCE_SECONDS = 300;

interface StripeEventBody {
  type?: string;
  data?: { object?: { id?: string } };
}

export class StripePaymentClient implements PaymentClient<'stripe'> {
  readonly provider = 'stripe' as const;
  constructor(
    private readonly ledger: PaymentLedger<'stripe'>,
    private readonly nextId: () => string,
  ) {}

  charge(request: ChargeRequest): Payment<'stripe'> {
    if (!/^[A-Za-z]{3}$/.test(request.currency)) throw new Error(`stripe: invalid currency ${request.currency}`);
    if (!Number.isInteger(request.amountMinor) || request.amountMinor < 50) throw new Error('stripe: minimum charge is 50 minor units');
    const payment = {
      provider: this.provider,
      id: `pi_${this.nextId()}`,
      orderId: request.orderId,
      amountMinor: request.amountMinor,
      currency: request.currency.toLowerCase(),
    };
    this.ledger.record(payment);
    return payment;
  }
}

export class StripeWebhookVerifier implements WebhookVerifier<'stripe'> {
  readonly provider = 'stripe' as const;
  constructor(
    private readonly secret: string,
    private readonly nowSeconds: () => number,
  ) {}

  verify(rawBody: string, headers: HttpHeaders): WebhookEvent<'stripe'> {
    const header = headers['stripe-signature'];
    if (!header) throw new WebhookSignatureError(this.provider, 'missing Stripe-Signature header');
    const parts = new Map(header.split(',').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)] as const));
    const timestamp = Number(parts.get('t'));
    const v1 = parts.get('v1');
    if (!Number.isInteger(timestamp) || !v1) throw new WebhookSignatureError(this.provider, 'malformed Stripe-Signature header');
    // Signing the timestamp is what makes the replay window enforceable.
    if (Math.abs(this.nowSeconds() - timestamp) > STRIPE_TOLERANCE_SECONDS) {
      throw new WebhookSignatureError(this.provider, 'timestamp outside the tolerance window');
    }
    if (!safeEqualHex(v1, hmacHex(this.secret, `${timestamp}.${rawBody}`))) throw new WebhookSignatureError(this.provider, 'signature mismatch');
    const body = JSON.parse(rawBody) as StripeEventBody;
    const type: WebhookEventType =
      body.type === 'payment_intent.succeeded' ? 'payment.succeeded' : body.type === 'charge.refunded' ? 'refund.processed' : 'ignored';
    return { provider: this.provider, type, objectId: body.data?.object?.id ?? '' };
  }
}

export class StripeRefundHandler implements RefundHandler<'stripe'> {
  readonly provider = 'stripe' as const;
  constructor(
    private readonly ledger: PaymentLedger<'stripe'>,
    private readonly nextId: () => string,
  ) {}

  refund(payment: Payment<'stripe'>, amountMinor?: number): Refund<'stripe'> {
    const amount = this.ledger.reserveRefund(payment, amountMinor);
    return { provider: this.provider, id: `re_${this.nextId()}`, paymentId: payment.id, amountMinor: amount };
  }
}

export class StripeFactory implements PaymentProviderFactory<'stripe'> {
  readonly provider = 'stripe' as const;
  private readonly ledger = new PaymentLedger('stripe' as const);
  constructor(private readonly deps: ProviderDeps) {}

  createPaymentClient(): PaymentClient<'stripe'> {
    return new StripePaymentClient(this.ledger, this.deps.nextId);
  }
  createWebhookVerifier(): WebhookVerifier<'stripe'> {
    return new StripeWebhookVerifier(this.deps.webhookSecret, this.deps.nowSeconds);
  }
  createRefundHandler(): RefundHandler<'stripe'> {
    return new StripeRefundHandler(this.ledger, this.deps.nextId);
  }
}

/* ------------------------------------------------------------------------ */
/* Client: depends only on the abstract factory and abstract products.       */
/* ------------------------------------------------------------------------ */

export class CheckoutService<P extends ProviderName> {
  private readonly client: PaymentClient<P>;
  private readonly verifier: WebhookVerifier<P>;
  private readonly refunds: RefundHandler<P>;
  private readonly confirmed = new Set<string>();

  constructor(factory: PaymentProviderFactory<P>) {
    // All three products come from one factory, so they cannot disagree about the provider.
    this.client = factory.createPaymentClient();
    this.verifier = factory.createWebhookVerifier();
    this.refunds = factory.createRefundHandler();
  }

  get provider(): P {
    return this.client.provider;
  }

  placeOrder(orderId: string, amountMinor: number, currency: string): Payment<P> {
    return this.client.charge({ orderId, amountMinor, currency });
  }

  handleWebhook(rawBody: string, headers: HttpHeaders): WebhookEvent<P> {
    const event = this.verifier.verify(rawBody, headers);
    if (event.type === 'payment.succeeded') this.confirmed.add(event.objectId);
    return event;
  }

  isConfirmed(paymentId: string): boolean {
    return this.confirmed.has(paymentId);
  }

  refund(payment: Payment<P>, amountMinor?: number): Refund<P> {
    return this.refunds.refund(payment, amountMinor);
  }
}

/* ------------------------------------------------------------------------ */
/* TypeScript-idiomatic selection: a typed record of factory functions,      */
/* chosen once from configuration at the composition root.                   */
/* ------------------------------------------------------------------------ */

const families: { [K in ProviderName]: (deps: ProviderDeps) => PaymentProviderFactory<K> } = {
  razorpay: (deps) => new RazorpayFactory(deps),
  stripe: (deps) => new StripeFactory(deps),
};

export const isProviderName = (value: string): value is ProviderName => Object.hasOwn(families, value);

export interface PaymentConfig {
  /** Usually from an environment variable such as PAYMENT_PROVIDER, hence string. */
  provider: string;
  webhookSecret: string;
}

export function createProviderFactory(config: PaymentConfig, runtime: RuntimeDeps): PaymentProviderFactory {
  if (!isProviderName(config.provider)) {
    throw new Error(`Unknown payment provider "${config.provider}". Configure one of: ${Object.keys(families).join(', ')}`);
  }
  return families[config.provider]({ ...runtime, webhookSecret: config.webhookSecret });
}

/** Plays the gateway's side: builds a signed webhook in the given provider's dialect. Used by the demo and tests. */
export function simulateProviderWebhook(
  provider: ProviderName,
  secret: string,
  type: 'payment.succeeded' | 'refund.processed',
  objectId: string,
  nowSeconds: number,
): { rawBody: string; headers: HttpHeaders } {
  if (provider === 'razorpay') {
    const entity = type === 'payment.succeeded' ? 'payment' : 'refund';
    const event = type === 'payment.succeeded' ? 'payment.captured' : 'refund.processed';
    const rawBody = JSON.stringify({ event, payload: { [entity]: { entity: { id: objectId } } } });
    return { rawBody, headers: { 'x-razorpay-signature': hmacHex(secret, rawBody) } };
  }
  const rawBody = JSON.stringify({ type: type === 'payment.succeeded' ? 'payment_intent.succeeded' : 'charge.refunded', data: { object: { id: objectId } } });
  return { rawBody, headers: { 'stripe-signature': `t=${nowSeconds},v1=${hmacHex(secret, `${nowSeconds}.${rawBody}`)}` } };
}
