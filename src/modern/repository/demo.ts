import { type Execute, InMemoryOrderRepository, OrderService, SqlOrderRepository, allOf, byCustomer, withStatus } from './repository';

const HOUR = 3_600_000;
let now = 1_700_000_000_000;
let seq = 0;
const clock = () => now;
const newId = () => `ord_${++seq}`;

console.log('\n1) OrderService on InMemoryOrderRepository (what unit tests use):');
const memory = new InMemoryOrderRepository();
const service = new OrderService(memory, clock, newId);
await service.place('cus_asha', 1_49_900);
await service.place('cus_asha', 49_900);
await service.pay('ord_2');
now += 30 * HOUR;
console.log('   cancelled stale orders:', await service.cancelStalePending(24 * HOUR));
console.log('   lifetime spend of cus_asha (paise):', await service.lifetimeSpendMinor('cus_asha'));
for (const o of await memory.findBy(byCustomer('cus_asha'))) console.log(`   ${o.id} ${o.status.padEnd(9)} ${o.totalMinor}`);

console.log('\n2) Same service, SqlOrderRepository with a logging executor instead of a driver:');
const execute: Execute = async (sql, params) => {
  console.log(`   SQL> ${sql}\n        params ${JSON.stringify(params)}`);
  return sql.startsWith('SELECT')
    ? [{ id: 'ord_7', customer_id: 'cus_ravi', status: 'pending', total_minor: 99_900, created_at_ms: now - 48 * HOUR }]
    : [];
};
const sqlService = new OrderService(new SqlOrderRepository(execute), clock, newId);
await sqlService.pay('ord_7');
console.log('   A specification becomes a parameterised WHERE clause:');
await new SqlOrderRepository(execute).findBy(allOf(byCustomer('cus_ravi'), withStatus('pending')));

console.log('\n3) Identity map: the second findById is served without SQL');
const repo = new SqlOrderRepository(execute);
const a = await repo.findById('ord_7');
const b = await repo.findById('ord_7');
console.log('   same object:', a === b);
console.log();
