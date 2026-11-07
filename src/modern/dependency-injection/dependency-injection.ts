/**
 * DEPENDENCY INJECTION
 * A class receives its collaborators through its constructor instead of creating or looking them up,
 * and one composition root decides which implementations to wire. A small typed container can automate that.
 *
 * Example domain: an invoicing service that needs a clock, ids, a repository, a payment gateway and a notifier.
 * Amounts are integers in minor units (paise).
 */
import { randomUUID } from 'node:crypto';

/* ------------------------------------------------------------------------ */
/* The service's dependencies, as interfaces it owns.                        */
/* ------------------------------------------------------------------------ */

export interface Clock {
  now(): number; // epoch ms
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceMinor: number;
}

export type InvoiceStatus = 'open' | 'paid' | 'payment_failed';

export interface Invoice {
  id: string;
  customerId: string;
  lines: LineItem[];
  totalMinor: number;
  issuedAt: number;
  dueAt: number;
  status: InvoiceStatus;
  paymentReference?: string;
}

export interface InvoiceRepository {
  save(invoice: Invoice): void;
  findById(id: string): Invoice | undefined;
}

export interface ChargeRequest {
  customerId: string;
  amountMinor: number;
  idempotencyKey: string;
}

export interface ChargeResult {
  ok: boolean;
  reference?: string;
  declineReason?: string;
}

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

export interface Notifier {
  send(to: string, subject: string, body: string): Promise<void>;
}

/* ------------------------------------------------------------------------ */
/* The service. It never calls `new` on a collaborator, never reads          */
/* Date.now() and never imports a concrete gateway: all of it is injected.   */
/* ------------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

export class InvoicingService {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly invoices: InvoiceRepository,
    private readonly gateway: PaymentGateway,
    private readonly notifier: Notifier,
  ) {}

  issue(customerId: string, lines: LineItem[], dueInDays = 15): Invoice {
    if (lines.length === 0) throw new Error('An invoice needs at least one line');
    const totalMinor = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0);
    const issuedAt = this.clock.now();
    const invoice: Invoice = {
      id: this.ids.next('inv'),
      customerId,
      lines,
      totalMinor,
      issuedAt,
      dueAt: issuedAt + dueInDays * DAY_MS,
      status: 'open',
    };
    this.invoices.save(invoice);
    return invoice;
  }

  async collect(invoiceId: string): Promise<Invoice> {
    const invoice = this.invoices.findById(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
    if (invoice.status === 'paid') return invoice; // never charge twice

    // The invoice id is the idempotency key: a retried collect() cannot double-charge.
    const result = await this.gateway.charge({
      customerId: invoice.customerId,
      amountMinor: invoice.totalMinor,
      idempotencyKey: invoice.id,
    });
    const updated: Invoice = result.ok
      ? { ...invoice, status: 'paid', paymentReference: result.reference }
      : { ...invoice, status: 'payment_failed' };
    this.invoices.save(updated);

    await this.notifier.send(
      invoice.customerId,
      result.ok ? `Payment received for ${invoice.id}` : `Payment failed for ${invoice.id}`,
      result.ok ? `We received ${invoice.totalMinor}.` : `Reason: ${result.declineReason ?? 'unknown'}`,
    );
    return updated;
  }
}

/* ------------------------------------------------------------------------ */
/* Production-style implementations.                                         */
/* ------------------------------------------------------------------------ */

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class RandomIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_${randomUUID().slice(0, 8)}`;
  }
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly rows = new Map<string, Invoice>();
  save(invoice: Invoice): void {
    this.rows.set(invoice.id, invoice);
  }
  findById(id: string): Invoice | undefined {
    return this.rows.get(id);
  }
}

/** Stands in for an HTTP gateway client: approves up to a per-charge limit. */
export class SimulatedPaymentGateway implements PaymentGateway {
  constructor(private readonly limitMinor: number) {}
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    return request.amountMinor <= this.limitMinor
      ? { ok: true, reference: `ch_${request.idempotencyKey}` }
      : { ok: false, declineReason: 'limit_exceeded' };
  }
}

/** Collects messages; a real one would call an email or SMS provider. Doubles as a test spy. */
export class InMemoryNotifier implements Notifier {
  readonly sent: { to: string; subject: string; body: string }[] = [];
  async send(to: string, subject: string, body: string): Promise<void> {
    this.sent.push({ to, subject, body });
  }
}

/* ------------------------------------------------------------------------ */
/* Test doubles: possible only because nothing is hard-wired.                */
/* ------------------------------------------------------------------------ */

export class FixedClock implements Clock {
  constructor(private ms: number) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.n}`;
  }
}

export class FakePaymentGateway implements PaymentGateway {
  readonly charges: ChargeRequest[] = [];
  constructor(private readonly scripted: ChargeResult[] = []) {}
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(request);
    return this.scripted.shift() ?? { ok: true, reference: `fake_${this.charges.length}` };
  }
}

/* ------------------------------------------------------------------------ */
/* A minimal typed container: tokens, factories, scopes, cycle detection.    */
/* ------------------------------------------------------------------------ */

/** A typed key. Interfaces vanish at runtime, so the container needs a value to look them up by. */
export class Token<T> {
  /** Phantom field: makes Token<Clock> and Token<Notifier> different types. Never set. */
  declare readonly __type?: T;
  constructor(readonly name: string) {}
}

export type Scope = 'singleton' | 'transient';

export interface Resolver {
  resolve<T>(token: Token<T>): T;
}

export type Factory<T> = (resolver: Resolver) => T;

export class CircularDependencyError extends Error {
  constructor(readonly path: string[]) {
    super(`Circular dependency: ${path.join(' -> ')}`);
    this.name = 'CircularDependencyError';
  }
}

export class MissingProviderError extends Error {
  constructor(token: string, requestedBy: string[]) {
    super(`No provider for ${token}${requestedBy.length ? ` (needed by ${requestedBy.join(' -> ')})` : ''}`);
    this.name = 'MissingProviderError';
  }
}

interface Provider {
  factory: Factory<unknown>;
  scope: Scope;
}

export class Container implements Resolver {
  private readonly providers = new Map<Token<unknown>, Provider>();
  private readonly singletons = new Map<Token<unknown>, unknown>();
  /** The tokens currently being built, innermost last: this is how cycles are detected. */
  private readonly resolving: Token<unknown>[] = [];

  register<T>(token: Token<T>, factory: Factory<T>, scope: Scope = 'singleton'): this {
    this.providers.set(token, { factory, scope });
    this.singletons.delete(token); // re-registering (a test override) drops the cached instance
    return this;
  }

  registerValue<T>(token: Token<T>, value: T): this {
    return this.register(token, () => value);
  }

  resolve<T>(token: Token<T>): T {
    if (this.singletons.has(token)) return this.singletons.get(token) as T;
    if (this.resolving.includes(token)) {
      const start = this.resolving.indexOf(token);
      throw new CircularDependencyError([...this.resolving.slice(start), token].map((t) => t.name));
    }
    const provider = this.providers.get(token);
    if (!provider) throw new MissingProviderError(token.name, this.resolving.map((t) => t.name));

    this.resolving.push(token);
    try {
      const instance = provider.factory(this);
      if (provider.scope === 'singleton') this.singletons.set(token, instance);
      // Safe: register<T>() only ever pairs Token<T> with Factory<T>.
      return instance as T;
    } finally {
      this.resolving.pop();
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Composition roots: the ONLY places that know the concrete classes.        */
/* ------------------------------------------------------------------------ */

export const TOKENS = {
  clock: new Token<Clock>('Clock'),
  ids: new Token<IdGenerator>('IdGenerator'),
  invoices: new Token<InvoiceRepository>('InvoiceRepository'),
  gateway: new Token<PaymentGateway>('PaymentGateway'),
  notifier: new Token<Notifier>('Notifier'),
  invoicing: new Token<InvoicingService>('InvoicingService'),
} as const;

/** Container-based wiring. Tests call this, then re-register the tokens they want to fake. */
export function registerInvoicing(container = new Container()): Container {
  return container
    .register(TOKENS.clock, () => new SystemClock())
    .register(TOKENS.ids, () => new RandomIdGenerator())
    .register(TOKENS.invoices, () => new InMemoryInvoiceRepository())
    .register(TOKENS.gateway, () => new SimulatedPaymentGateway(5_00_000_00))
    .register(TOKENS.notifier, () => new InMemoryNotifier())
    .register(
      TOKENS.invoicing,
      (c) =>
        new InvoicingService(
          c.resolve(TOKENS.clock),
          c.resolve(TOKENS.ids),
          c.resolve(TOKENS.invoices),
          c.resolve(TOKENS.gateway),
          c.resolve(TOKENS.notifier),
        ),
    );
}

/** "Pure DI": the idiomatic TypeScript default. Plain constructors in main.ts, checked by the compiler. */
export function composeInvoicingByHand(): InvoicingService {
  return new InvoicingService(
    new SystemClock(),
    new RandomIdGenerator(),
    new InMemoryInvoiceRepository(),
    new SimulatedPaymentGateway(5_00_000_00),
    new InMemoryNotifier(),
  );
}

/* ------------------------------------------------------------------------ */
/* For contrast: SERVICE LOCATOR. The class pulls what it needs from a        */
/* global-ish registry. The constructor no longer tells you its dependencies */
/* and a missing one fails at call time, not at wiring time.                 */
/* ------------------------------------------------------------------------ */

export class LocatorInvoicingService {
  constructor(private readonly locator: Resolver) {}

  async collect(invoiceId: string): Promise<InvoiceStatus> {
    const invoice = this.locator.resolve(TOKENS.invoices).findById(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
    const result = await this.locator.resolve(TOKENS.gateway).charge({
      customerId: invoice.customerId,
      amountMinor: invoice.totalMinor,
      idempotencyKey: invoice.id,
    });
    return result.ok ? 'paid' : 'payment_failed';
  }
}
