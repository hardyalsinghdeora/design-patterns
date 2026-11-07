import { InMemoryDatabase, Order, PaymentService, UnitOfWork, type WriteOp, orderMapper } from './unit-of-work';

let failOn: ((w: WriteOp) => boolean) | undefined;
const db = new InMemoryDatabase((w) => failOn?.(w) ?? false).seed('orders', [
  orderMapper.toRow(new Order('ord_1', 'cus_asha', 1_49_900)),
  orderMapper.toRow(new Order('ord_2', 'cus_ravi', 49_900)),
]);
let seq = 0;
const service = new PaymentService(db, () => `pay_${++seq}`);
const show = (label: string) => {
  console.log(`   ${label}`);
  for (const t of ['orders', 'payments']) for (const r of db.rows(t)) console.log(`     ${t.padEnd(8)} ${JSON.stringify(r)}`);
};

console.log('\n1) Changes are tracked in memory until commit:');
const uow = new UnitOfWork(db);
const order = await uow.orders.get('ord_1');
order.markPaid();
console.log('   same object for the same id:', order === (await uow.orders.get('ord_1')));
console.log('   pending:', JSON.stringify(uow.pendingChanges()));
console.log('   database log so far:', JSON.stringify(db.log));
uow.rollback();
console.log('   rolled back the unit; nothing was ever written');

console.log('\n2) capture(ord_1) commits an UPDATE and an INSERT in one transaction:');
await service.capture('ord_1');
console.log('   log:', db.log.join(' | '));
show('committed rows:');

console.log('\n3) refund(pay_1) fails on its second write:');
db.log.length = 0;
failOn = (w) => w.op === 'update' && w.table === 'payments';
await service.refund('pay_1').catch((err: Error) => console.log(`   error: ${err.message}`));
console.log('   log:', db.log.join(' | '));
show('rows are exactly as before:');

console.log('\n4) Same refund once the database recovers:');
failOn = undefined;
db.log.length = 0;
await service.refund('pay_1');
console.log('   log:', db.log.join(' | '));
show('committed rows:');
console.log();
