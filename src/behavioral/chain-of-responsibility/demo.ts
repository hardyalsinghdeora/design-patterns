import {
  AuthenticationHandler,
  BusinessHandler,
  RateLimitHandler,
  ValidationHandler,
  chain,
  escalate,
  supportDesk,
  validateNewOrder,
  type ApiRequest,
  type SupportTicket,
} from './chain-of-responsibility';

let now = 0; // a fake clock keeps the demo repeatable
let seq = 0;
const api = chain(
  new AuthenticationHandler(new Map([['tok_asha', 'asha']])),
  new RateLimitHandler(3, 60_000, () => now),
  new ValidationHandler(new Map([['POST /orders', validateNewOrder]])),
  new BusinessHandler(new Map([['TEA-250G', 34_900], ['MUG', 29_900]]), () => `ord_${++seq}`),
);

const asha = { authorization: 'Bearer tok_asha' };
function send(label: string, request: ApiRequest): void {
  const response = api.handle(request);
  console.log(`  ${label.padEnd(34)} -> ${response.status} from ${response.handledBy.padEnd(14)} ${JSON.stringify(response.body)}`);
}

console.log('\nAuthentication -> RateLimit (3 per minute) -> Validation -> Business');
send('POST /orders, no token', { method: 'POST', path: '/orders', headers: {}, body: { sku: 'MUG', quantity: 1 } });
send('POST /orders, quantity 0', { method: 'POST', path: '/orders', headers: asha, body: { sku: 'MUG', quantity: 0 } });
send('POST /orders, 2 x TEA-250G', { method: 'POST', path: '/orders', headers: asha, body: { sku: 'TEA-250G', quantity: 2 } });
send('GET /invoices (no such route)', { method: 'GET', path: '/invoices', headers: asha });
send('GET /orders (4th call this minute)', { method: 'GET', path: '/orders', headers: asha });
now += 60_000;
send('GET /orders (a minute later)', { method: 'GET', path: '/orders', headers: asha });

console.log('\nSupport desk, functional form: an array [L1, L2, L3], first answer wins');
const tickets: SupportTicket[] = [
  { id: 'T-101', category: 'password-reset' },
  { id: 'T-102', category: 'refund', refundMinor: 300 * 100 },
  { id: 'T-103', category: 'refund', refundMinor: 4_500 * 100 },
  { id: 'T-104', category: 'outage' },
  { id: 'T-105', category: 'legal' },
];
for (const ticket of tickets) {
  const outcome = escalate(supportDesk, ticket);
  console.log(`  ${ticket.id} ${ticket.category.padEnd(14)} -> ${outcome.tier.padEnd(10)} after ${outcome.hops} hop(s): ${outcome.action}`);
}
console.log();
