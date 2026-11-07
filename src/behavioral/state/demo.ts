import { Subscription, type SubscriptionAction, TableDrivenSubscription, allowedActions } from './state';

let day = Date.parse('2026-01-01T00:00:00Z');
const now = () => new Date((day += 86_400_000));
const sub = new Subscription('sub_acme', { planPriceMinor: 99_900, maxFailedAttempts: 3, now });

const attempt = (action: SubscriptionAction) => {
  const from = sub.status;
  try {
    sub[action]();
    console.log(`  ${action.padEnd(7)} ${from.padEnd(9)} -> ${sub.status.padEnd(9)} allowed next: ${allowedActions(sub.status).join(', ') || '(none)'}`);
  } catch (error) {
    console.log(`  ${action.padEnd(7)} ${from.padEnd(9)} !! ${(error as Error).message}`);
  }
};

console.log('\n1. Trial converts, renews, pauses for a month, resumes');
for (const action of ['pay', 'pay', 'pause', 'pay', 'resume'] as const) attempt(action);

console.log('\n2. The card expires: dunning retries, then a payment rescues it');
for (const action of ['fail', 'pause', 'fail', 'pay'] as const) attempt(action);

console.log('\n3. Three failures in a row: dunning gives up');
for (const action of ['fail', 'fail', 'fail', 'resume'] as const) attempt(action);

const s = sub.snapshot();
console.log(`\n  periods paid: ${s.periodsPaid}, collected: Rs ${s.totalPaidMinor / 100}`);
console.log('  history:');
for (const t of sub.history) console.log(`    ${t.at.toISOString().slice(0, 10)}  ${t.from} --${t.action}--> ${t.to}`);

console.log('\n4. The transition-table implementation gives the same answer');
const table = new TableDrivenSubscription('sub_acme', { planPriceMinor: 99_900, maxFailedAttempts: 3 });
for (const action of ['pay', 'pay', 'pause', 'resume', 'fail', 'fail', 'pay', 'fail', 'fail', 'fail'] as const) table[action]();
console.log('  classic:', JSON.stringify(sub.snapshot()));
console.log('  table  :', JSON.stringify(table.snapshot()));
console.log();
