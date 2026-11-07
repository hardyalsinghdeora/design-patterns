/**
 * STRATEGY
 * Define a family of algorithms, put each one behind the same interface, and
 * let the client pick one at runtime. The context (CheckoutService) never
 * switches on a type; adding a payment method is adding a class.
 *
 * Example domain: paying for an order with card, UPI or wallet.
 * Amounts are integers in minor units (paise).
 */

export interface PaymentRequest {
  orderId: string;
  amountMinor: number;
  currency: 'INR';
}

export interface PaymentResult {
  ok: boolean;
  method: string;
  reference?: string;
  feeMinor: number;
  message: string;
}

/** The strategy interface. Everything the context needs, nothing more. */
export interface PaymentStrategy {
  readonly method: string;
  /** Can this strategy handle the request at all (limits, currency, balance)? */
  supports(request: PaymentRequest): boolean;
  pay(request: PaymentRequest): PaymentResult;
}

export class CardPaymentStrategy implements PaymentStrategy {
  readonly method = 'card';

  constructor(private readonly feeBasisPoints = 200) {} // 2.00 %

  supports(request: PaymentRequest): boolean {
    return request.amountMinor > 0;
  }

  pay(request: PaymentRequest): PaymentResult {
    const feeMinor = Math.round((request.amountMinor * this.feeBasisPoints) / 10_000);
    return {
      ok: true,
      method: this.method,
      reference: `card_${request.orderId}`,
      feeMinor,
      message: `Charged ${request.amountMinor} via card, fee ${feeMinor}`,
    };
  }
}

export class UpiPaymentStrategy implements PaymentStrategy {
  readonly method = 'upi';
  /** NPCI per-transaction cap, in paise. */
  private static readonly LIMIT_MINOR = 1_00_000 * 100;

  supports(request: PaymentRequest): boolean {
    return request.amountMinor > 0 && request.amountMinor <= UpiPaymentStrategy.LIMIT_MINOR;
  }

  pay(request: PaymentRequest): PaymentResult {
    return {
      ok: true,
      method: this.method,
      reference: `upi_${request.orderId}`,
      feeMinor: 0,
      message: `Collected ${request.amountMinor} via UPI, no fee`,
    };
  }
}

export class WalletPaymentStrategy implements PaymentStrategy {
  readonly method = 'wallet';

  constructor(private balanceMinor: number) {}

  get balance(): number {
    return this.balanceMinor;
  }

  supports(request: PaymentRequest): boolean {
    return request.amountMinor > 0 && request.amountMinor <= this.balanceMinor;
  }

  pay(request: PaymentRequest): PaymentResult {
    if (!this.supports(request)) {
      return { ok: false, method: this.method, feeMinor: 0, message: 'Insufficient wallet balance' };
    }
    this.balanceMinor -= request.amountMinor;
    return {
      ok: true,
      method: this.method,
      reference: `wal_${request.orderId}`,
      feeMinor: 0,
      message: `Debited ${request.amountMinor} from wallet, balance ${this.balanceMinor}`,
    };
  }
}

/**
 * The context. It owns a registry of strategies and delegates. Note what it
 * does NOT contain: a `switch (method)`. That switch is the smell Strategy removes.
 */
export class CheckoutService {
  private readonly strategies = new Map<string, PaymentStrategy>();

  register(strategy: PaymentStrategy): this {
    this.strategies.set(strategy.method, strategy);
    return this;
  }

  availableMethods(request: PaymentRequest): string[] {
    return [...this.strategies.values()].filter((s) => s.supports(request)).map((s) => s.method);
  }

  pay(method: string, request: PaymentRequest): PaymentResult {
    const strategy = this.strategies.get(method);
    if (!strategy) throw new Error(`Unknown payment method "${method}"`);
    if (!strategy.supports(request)) {
      return { ok: false, method, feeMinor: 0, message: `${method} cannot process this payment` };
    }
    return strategy.pay(request);
  }
}

/* ------------------------------------------------------------------------ */
/* Functional form: in TypeScript a strategy with one method is just a       */
/* function. Use this when there is no state and no second method.           */
/* ------------------------------------------------------------------------ */

export type DiscountStrategy = (subtotalMinor: number) => number;

export const noDiscount: DiscountStrategy = () => 0;

export const percentageOff =
  (percent: number): DiscountStrategy =>
  (subtotalMinor) =>
    Math.round((subtotalMinor * percent) / 100);

export const flatOff =
  (amountMinor: number): DiscountStrategy =>
  (subtotalMinor) =>
    Math.min(amountMinor, subtotalMinor);

/** Pick the best of several strategies: still a strategy. */
export const bestOf =
  (...strategies: DiscountStrategy[]): DiscountStrategy =>
  (subtotalMinor) =>
    Math.max(0, ...strategies.map((s) => s(subtotalMinor)));

export function applyDiscount(subtotalMinor: number, strategy: DiscountStrategy): number {
  return subtotalMinor - strategy(subtotalMinor);
}
