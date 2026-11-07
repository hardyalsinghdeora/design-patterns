import {
  Container,
  FakePaymentGateway,
  FixedClock,
  InMemoryInvoiceRepository,
  InMemoryNotifier,
  InvoicingService,
  SequentialIdGenerator,
  TOKENS,
  Token,
  composeInvoicingByHand,
  registerInvoicing,
} from './dependency-injection';

const lines = [
  { description: 'Pro plan, May', quantity: 1, unitPriceMinor: 4_999_00 },
  { description: 'Extra seats', quantity: 3, unitPriceMinor: 500_00 },
];

console.log('\n1) Pure DI: the composition root calls constructors by hand');
const byHand = composeInvoicingByHand();
console.log('  issued', byHand.issue('cus_1', lines).totalMinor, 'paise (random id, system clock)');

console.log('\n2) The same graph, resolved by a typed container');
const container = registerInvoicing();
const service = container.resolve(TOKENS.invoicing);
const inv = service.issue('cus_2', lines);
const paid = await service.collect(inv.id);
console.log('  ', paid.status, paid.paymentReference);
console.log('  singleton repository shared?', container.resolve(TOKENS.invoices).findById(inv.id)?.status === 'paid');

const requestId = new Token<string>('RequestId');
let counter = 0;
container.register(requestId, () => `req_${++counter}`, 'transient');
console.log('  transient RequestId:', container.resolve(requestId), container.resolve(requestId));

console.log('\n3) Circular dependencies are caught at resolve time');
const a = new Token<object>('AuditLog');
const b = new Token<object>('Mailer');
const broken = new Container().register(a, (c) => ({ mailer: c.resolve(b) })).register(b, (c) => ({ audit: c.resolve(a) }));
try {
  broken.resolve(a);
} catch (err) {
  console.log('  ', (err as Error).message);
}

console.log('\n4) Tests inject fakes: fixed clock, sequential ids, a gateway that declines');
const notifier = new InMemoryNotifier();
const testService = new InvoicingService(
  new FixedClock(Date.UTC(2026, 4, 1)),
  new SequentialIdGenerator(),
  new InMemoryInvoiceRepository(),
  new FakePaymentGateway([{ ok: false, declineReason: 'card_expired' }]),
  notifier,
);
const draft = testService.issue('cus_3', lines, 30);
console.log('  ', draft.id, 'due', new Date(draft.dueAt).toISOString().slice(0, 10));
console.log('  ', (await testService.collect(draft.id)).status, '->', notifier.sent[0]?.subject);
console.log();
