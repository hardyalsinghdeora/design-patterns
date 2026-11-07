import { ManualClock, buildInvoiceApi, compose, type HttpRequest, type Middleware } from './middleware-pipeline';

console.log('\n1) The onion: code before next() runs outside-in, code after runs inside-out');
const trace: string[] = [];
const layer =
  (name: string): Middleware<object> =>
  async (_ctx, next) => {
    trace.push(`${name}:before`);
    await next();
    trace.push(`${name}:after`);
  };
await compose([layer('logger'), layer('timing'), layer('auth')])({}, async () => {
  trace.push('HANDLER');
});
console.log('  ', trace.join(' -> '));

console.log('\n2) The invoice API: logger > timing > errorHandler > /health > auth > routes');
const clock = new ManualClock(0);
const users = { 'tok-asha': { id: 'u_asha', roles: ['billing'] }, 'tok-root': { id: 'u_root', roles: ['admin'] } };
const handle = buildInvoiceApi({
  clock,
  log: (line) => console.log('   log', line),
  verifyToken: (t) => (t === 'tok-asha' || t === 'tok-root' ? users[t] : undefined),
});

const requests: [string, HttpRequest][] = [
  ['health, no token', { method: 'GET', path: '/health', headers: {} }],
  ['create, no token', { method: 'POST', path: '/invoices', headers: {}, body: {} }],
  ['create, bad body', { method: 'POST', path: '/invoices', headers: { authorization: 'Bearer tok-asha' }, body: { customerId: 'cus_1', amountMinor: 99.5 } }],
  ['create, valid', { method: 'POST', path: '/invoices', headers: { authorization: 'Bearer tok-asha' }, body: { customerId: 'cus_1', amountMinor: 2_499_00 } }],
  ['delete, not admin', { method: 'DELETE', path: '/invoices', headers: { authorization: 'Bearer tok-asha' } }],
  ['delete, admin, ledger down', { method: 'DELETE', path: '/invoices', headers: { authorization: 'Bearer tok-root' } }],
];

let n = 0;
for (const [label, request] of requests) {
  n += 1;
  const res = await handle(request, `r${n}`);
  console.log(`   ${label.padEnd(27)} => ${res.status} ${JSON.stringify(res.body)} (${res.headers['x-response-time']})`);
}
console.log();
