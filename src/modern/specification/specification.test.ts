import { describe, expect, it } from 'vitest';
import {
  AtLeast,
  CompositeSpecification,
  CustomerRules,
  Equals,
  InMemoryOrderRepository,
  OrderRules,
  SqlOrderQueryBuilder,
  allOf,
  asPredicate,
  creditLineEligibility,
  evaluateQuery,
  negate,
  toMongo,
  toSql,
  type Customer,
  type Order,
  type Query,
} from './specification';

const order = (id: string, status: Order['status'], totalMinor: number, country = 'IN', customerId = 'c1'): Order => ({
  id,
  customerId,
  status,
  totalMinor,
  country,
});

const customer = (over: Partial<Customer>): Customer => ({
  id: 'c',
  country: 'IN',
  creditScore: 760,
  annualIncomeMinor: 9_00_000_00,
  overdueInvoices: 0,
  accountAgeDays: 400,
  kycVerified: true,
  ...over,
});

const orders: Order[] = [
  order('o1', 'paid', 80_000),
  order('o2', 'paid', 500),
  order('o3', 'pending', 80_000, 'SG'),
  order('o4', 'shipped', 1_20_000, 'SG', 'c9'),
  order('o5', 'cancelled', 90_000, 'US'),
];

describe('composition', () => {
  const paid = new Equals<Order>('status', 'paid');
  const big = new AtLeast<Order>('totalMinor', 1_000);

  it('and/or/not follow the boolean truth table', () => {
    const rows: [Order, boolean, boolean][] = [
      [order('a', 'paid', 5_000), true, true],
      [order('b', 'paid', 10), true, false],
      [order('c', 'pending', 5_000), false, true],
      [order('d', 'pending', 10), false, false],
    ];
    for (const [o, p, b] of rows) {
      expect(paid.and(big).isSatisfiedBy(o)).toBe(p && b);
      expect(paid.or(big).isSatisfiedBy(o)).toBe(p || b);
      expect(paid.not().isSatisfiedBy(o)).toBe(!p);
      expect(paid.and(big.not()).isSatisfiedBy(o)).toBe(p && !b);
    }
  });

  it('reuses the same leaf in different policies without changing it', () => {
    const goodScore = CustomerRules.creditScoreAtLeast(700);
    const premium = goodScore.and(CustomerRules.accountAgeAtLeast(1_000));
    const anyGood = goodScore.or(CustomerRules.incomeAtLeast(50_00_000_00));
    const c = customer({ creditScore: 720, accountAgeDays: 30 });
    expect(goodScore.isSatisfiedBy(c)).toBe(true);
    expect(premium.isSatisfiedBy(c)).toBe(false);
    expect(anyGood.isSatisfiedBy(c)).toBe(true);
    expect(goodScore.describe()).toBe('credit score >= 700');
  });

  it('accepts a brand-new rule class and composes it with existing ones', () => {
    class NotDenyListed extends CompositeSpecification<Order> {
      constructor(private readonly denied: string[]) {
        super();
      }
      isSatisfiedBy(o: Order): boolean {
        return !this.denied.includes(o.customerId);
      }
      describe(): string {
        return 'customer not deny-listed';
      }
      toQuery(): Query {
        return { op: 'not', clause: { op: 'in', field: 'customerId', values: this.denied } };
      }
    }
    const spec = OrderRules.totalAtLeast(50_000).and(new NotDenyListed(['c9']));
    expect(new InMemoryOrderRepository(orders).find(spec).map((o) => o.id)).toEqual(['o1', 'o3', 'o5']);
    expect(toSql(spec.toQuery()).text).toBe('(total_minor >= $1 AND NOT (customer_id IN ($2)))');
  });
});

describe('query translation', () => {
  const spec = OrderRules.statusIn('paid', 'shipped')
    .and(OrderRules.totalAtLeast(50_000))
    .and(OrderRules.shipsTo('IN').or(OrderRules.shipsTo('SG')));

  it('turns a composed spec into a flat, parameterised SQL WHERE clause', () => {
    expect(new SqlOrderQueryBuilder().build(spec)).toEqual({
      text: 'SELECT * FROM orders WHERE (status IN ($1, $2) AND total_minor >= $3 AND (country = $4 OR country = $5))',
      params: ['paid', 'shipped', 50_000, 'IN', 'SG'],
    });
  });

  it('turns the same spec into a Mongo filter', () => {
    expect(toMongo(OrderRules.totalAtLeast(100).and(OrderRules.statusIn('paid').not()).toQuery())).toEqual({
      $and: [{ totalMinor: { $gte: 100 } }, { $nor: [{ status: { $in: ['paid'] } }] }],
    });
  });

  it('the query means exactly what isSatisfiedBy means, record by record', () => {
    const specs = [spec, spec.not(), OrderRules.statusIn('cancelled').or(OrderRules.totalAtLeast(1_00_000))];
    for (const s of specs) {
      const q = s.toQuery();
      for (const o of orders) expect(evaluateQuery(q, o)).toBe(s.isSatisfiedBy(o));
    }
    expect(new InMemoryOrderRepository(orders).find(spec).map((o) => o.id)).toEqual(['o1', 'o4']);
  });
});

describe('explanations', () => {
  const eligible = creditLineEligibility();

  it('passes good customers with no reasons, via either branch of the OR', () => {
    expect(eligible.explain(customer({}))).toEqual([]);
    expect(eligible.isSatisfiedBy(customer({ creditScore: 640, annualIncomeMinor: 15_00_000_00 }))).toBe(true);
  });

  it('lists every failed leaf with the actual value', () => {
    expect(eligible.explain(customer({ kycVerified: false, country: 'US' }))).toEqual([
      'KYC verified (was false)',
      'country in IN/SG (was US)',
    ]);
  });

  it('explains a failed OR branch by branch, and a failed NOT', () => {
    const c = customer({ creditScore: 650, annualIncomeMinor: 15_00_000_00, accountAgeDays: 100 });
    expect(eligible.explain(c)).toEqual([
      'needs one of: [credit score >= 700 (was 650)] or [account age >= 365 days (was 100)]',
    ]);
    expect(OrderRules.statusIn('cancelled').not().explain(orders[4])).toEqual(['must not be: status in cancelled']);
  });
});

describe('functional form', () => {
  it('composes predicates and adapts a specification into one', () => {
    const ok = allOf<Order>(asPredicate(OrderRules.statusIn('paid')), negate((o) => o.totalMinor < 1_000));
    expect(orders.filter(ok).map((o) => o.id)).toEqual(['o1']);
  });
});
