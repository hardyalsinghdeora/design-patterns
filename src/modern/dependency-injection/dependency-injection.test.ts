import { describe, expect, it } from 'vitest';
import {
  CircularDependencyError,
  Container,
  FakePaymentGateway,
  FixedClock,
  InMemoryInvoiceRepository,
  InMemoryNotifier,
  InvoicingService,
  LocatorInvoicingService,
  MissingProviderError,
  SequentialIdGenerator,
  TOKENS,
  Token,
  registerInvoicing,
} from './dependency-injection';

const lines = [
  { description: 'Pro plan, May', quantity: 1, unitPriceMinor: 4_999_00 },
  { description: 'Extra seats', quantity: 3, unitPriceMinor: 500_00 },
];
const T0 = Date.UTC(2026, 4, 1);

describe('Container', () => {
  it('resolves the whole invoicing graph from the composition root', async () => {
    const container = registerInvoicing();
    const service = container.resolve(TOKENS.invoicing);
    expect(service).toBeInstanceOf(InvoicingService);
    const invoice = service.issue('cus_1', lines);
    expect(invoice.totalMinor).toBe(6_499_00);
    expect((await service.collect(invoice.id)).status).toBe('paid');
  });

  it('singleton scope returns the same instance, shared by everything that depends on it', () => {
    const container = registerInvoicing();
    expect(container.resolve(TOKENS.invoices)).toBe(container.resolve(TOKENS.invoices));
    const invoice = container.resolve(TOKENS.invoicing).issue('cus_1', lines);
    expect(container.resolve(TOKENS.invoices).findById(invoice.id)).toEqual(invoice);
  });

  it('transient scope builds a new instance on every resolve, and factories run lazily', () => {
    let built = 0;
    const draft = new Token<{ n: number }>('InvoiceDraft');
    const container = new Container().register(draft, () => ({ n: ++built }), 'transient');
    expect(built).toBe(0);
    const a = container.resolve(draft);
    const b = container.resolve(draft);
    expect(a).not.toBe(b);
    expect([a.n, b.n]).toEqual([1, 2]);
  });

  it('detects a circular dependency and names the cycle', () => {
    const a = new Token<{ b: unknown }>('A');
    const b = new Token<{ a: unknown }>('B');
    const container = new Container()
      .register(a, (c) => ({ b: c.resolve(b) }))
      .register(b, (c) => ({ a: c.resolve(a) }));
    expect(() => container.resolve(a)).toThrow(CircularDependencyError);
    expect(() => container.resolve(a)).toThrow('Circular dependency: A -> B -> A');
  });

  it('reports a missing provider together with who needed it', () => {
    const partial = new Container().register(
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
    expect(() => partial.resolve(TOKENS.invoicing)).toThrow(MissingProviderError);
    expect(() => partial.resolve(TOKENS.invoicing)).toThrow('No provider for Clock (needed by InvoicingService)');
  });

  it('lets a test swap one dependency by re-registering its token', async () => {
    const fake = new FakePaymentGateway([{ ok: false, declineReason: 'insufficient_funds' }]);
    const container = registerInvoicing().registerValue(TOKENS.gateway, fake);
    const service = container.resolve(TOKENS.invoicing);
    const invoice = service.issue('cus_1', lines);
    expect((await service.collect(invoice.id)).status).toBe('payment_failed');
    expect(fake.charges).toHaveLength(1);
  });
});

describe('InvoicingService with hand-made fakes (no container needed)', () => {
  const build = (gateway = new FakePaymentGateway()) => {
    const clock = new FixedClock(T0);
    const notifier = new InMemoryNotifier();
    const repo = new InMemoryInvoiceRepository();
    const service = new InvoicingService(clock, new SequentialIdGenerator(), repo, gateway, notifier);
    return { service, gateway, notifier, repo };
  };

  it('is deterministic: ids, dates and messages come from the injected fakes', async () => {
    const { service, notifier } = build(new FakePaymentGateway([{ ok: false, declineReason: 'card_expired' }]));
    const invoice = service.issue('cus_7', lines, 30);
    expect(invoice).toMatchObject({ id: 'inv_1', issuedAt: T0, dueAt: T0 + 30 * 86_400_000, status: 'open' });
    await service.collect('inv_1');
    expect(notifier.sent).toEqual([{ to: 'cus_7', subject: 'Payment failed for inv_1', body: 'Reason: card_expired' }]);
  });

  it('uses the invoice id as idempotency key and never charges a paid invoice twice', async () => {
    const { service, gateway } = build();
    service.issue('cus_7', lines);
    expect((await service.collect('inv_1')).paymentReference).toBe('fake_1');
    await service.collect('inv_1');
    expect(gateway.charges).toEqual([{ customerId: 'cus_7', amountMinor: 6_499_00, idempotencyKey: 'inv_1' }]);
  });
});

describe('Service Locator, for contrast', () => {
  it('constructs without its dependencies and only fails when a method runs', async () => {
    const service = new LocatorInvoicingService(new Container());
    await expect(service.collect('inv_1')).rejects.toThrow(MissingProviderError);
  });
});
