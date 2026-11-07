import {
  CustomerRules,
  InMemoryOrderRepository,
  OrderRules,
  SqlOrderQueryBuilder,
  creditLineEligibility,
  toMongo,
  type Customer,
  type Order,
} from './specification';

const base: Customer = {
  id: 'c0',
  country: 'IN',
  creditScore: 760,
  annualIncomeMinor: 9_00_000_00,
  overdueInvoices: 0,
  accountAgeDays: 400,
  kycVerified: true,
};
const customers: Customer[] = [
  { ...base, id: 'alice' },
  { ...base, id: 'bob', creditScore: 640, annualIncomeMinor: 15_00_000_00, accountAgeDays: 500 },
  { ...base, id: 'chen', country: 'SG', overdueInvoices: 2 },
  { ...base, id: 'dana', country: 'US', kycVerified: false },
  { ...base, id: 'eve', creditScore: 650, annualIncomeMinor: 15_00_000_00, accountAgeDays: 100 },
];

const eligible = creditLineEligibility();
console.log('\nCredit-line rule:', eligible.describe());
for (const c of customers) {
  const reasons = eligible.explain(c);
  console.log(`  ${c.id.padEnd(6)} ${reasons.length === 0 ? 'ELIGIBLE' : 'rejected: ' + reasons.join(', ')}`);
}

console.log('\nThe same leaf, reused in a stricter rule:');
const vip = CustomerRules.creditScoreAtLeast(700).and(CustomerRules.accountAgeAtLeast(365));
console.log('  ', vip.describe(), '->', customers.filter((c) => vip.isSatisfiedBy(c)).map((c) => c.id));

const orders: Order[] = [
  { id: 'o1', customerId: 'alice', status: 'paid', totalMinor: 80_000, country: 'IN' },
  { id: 'o2', customerId: 'bob', status: 'paid', totalMinor: 500, country: 'IN' },
  { id: 'o3', customerId: 'chen', status: 'shipped', totalMinor: 1_20_000, country: 'SG' },
  { id: 'o4', customerId: 'dana', status: 'cancelled', totalMinor: 90_000, country: 'US' },
];
const bigFulfilled = OrderRules.statusIn('paid', 'shipped')
  .and(OrderRules.totalAtLeast(50_000))
  .and(OrderRules.shipsTo('IN').or(OrderRules.shipsTo('SG')));

console.log('\nOne order rule, three backends:');
console.log('  in memory :', new InMemoryOrderRepository(orders).find(bigFulfilled).map((o) => o.id));
const sql = new SqlOrderQueryBuilder().build(bigFulfilled);
console.log('  SQL       :', sql.text);
console.log('  params    :', sql.params);
console.log('  Mongo     :', JSON.stringify(toMongo(bigFulfilled.toQuery())));
console.log();
