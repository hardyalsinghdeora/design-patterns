import {
  Account,
  AccountBalancesProjection,
  AccountRepository,
  ConcurrencyError,
  EventStore,
  SnapshotStore,
  steppingClock,
  type PersistedAccountEvent,
} from './event-sourcing';

const clock = steppingClock();
const store = new EventStore<PersistedAccountEvent>();
const repo = new AccountRepository(store, new SnapshotStore(), clock, { snapshotEvery: 3 });
const rupees = (minor: number) => `Rs ${(minor / 100).toFixed(2)}`;

console.log('\n1. Commands become events; state is a fold over them');
const wallet = Account.open('acc_1', 'user_7', clock);
wallet.deposit(1_000_00, 'upi_1');
wallet.withdraw(250_00, 'ord_1');
repo.save(wallet);
for (const r of store.readStream('acc_1')) console.log(`  v${r.version} ${r.event.type}`);
console.log('  balance:', rupees(wallet.state.balanceMinor));

console.log('\n2. A legacy v1 event already on disk is upcast on read');
store.append('acc_1', store.version('acc_1'), [{ type: 'Deposited', schemaVersion: 1, amount: '125.5', at: clock() }]);
console.log('  stored as  :', JSON.stringify(store.readStream('acc_1', 4)[0]?.event));
console.log('  loaded as  :', rupees(repo.load('acc_1').state.balanceMinor));

console.log('\n3. Optimistic concurrency: two tabs load version', repo.load('acc_1').version);
const tabA = repo.load('acc_1');
const tabB = repo.load('acc_1');
tabA.withdraw(500_00, 'ord_2');
repo.save(tabA);
tabB.withdraw(500_00, 'ord_3');
try {
  repo.save(tabB);
} catch (err) {
  if (err instanceof ConcurrencyError) console.log('  tab B refused:', err.message);
}
const retried = repo.load('acc_1');
console.log('  after reload tab B sees', rupees(retried.state.balanceMinor), '- the second withdrawal would overdraw');

console.log('\n4. Snapshots every 3 events (taken at v3 and v6)');
retried.deposit(50_00, 'refund_1');
repo.save(retried);
retried.deposit(25_00, 'cashback_1');
repo.save(retried);
const fromSnapshot = repo.load('acc_1');
const full = repo.load('acc_1', { useSnapshots: false });
console.log(`  snapshot load replayed ${fromSnapshot.replayedEvents} event(s), full replay ${full.replayedEvents}; same state:`,
  JSON.stringify(fromSnapshot.state) === JSON.stringify(full.state));

console.log('\n5. Temporal query: balance after each version');
for (let v = 1; v <= store.version('acc_1'); v++) console.log(`  as of v${v}: ${rupees(repo.stateAsOf('acc_1', v).balanceMinor)}`);

const projection = new AccountBalancesProjection(store);
projection.catchUp();
console.log('\n6. Projection over all streams: total held', rupees(projection.totalHeldMinor()));
console.log();
