import { describe, expect, it } from 'vitest';
import {
  InvariantViolation,
  Projector,
  createCommandSide,
  createQuerySide,
  steppingClock,
  type Projection,
  type StoredEvent,
} from './cqrs';

const line = (unitPriceMinor: number, quantity = 1) => ({ sku: 'seat', quantity, unitPriceMinor });

function setup() {
  const command = createCommandSide(steppingClock());
  const query = createQuerySide(command.log);
  return { ...command, ...query };
}

function seed(bus: ReturnType<typeof setup>['bus']) {
  bus.dispatch({ type: 'PlaceOrder', orderId: 'o1', customerId: 'acme', lines: [line(500_00, 2)] });
  bus.dispatch({ type: 'PlaceOrder', orderId: 'o2', customerId: 'acme', lines: [line(300_00)] });
  bus.dispatch({ type: 'PlaceOrder', orderId: 'o3', customerId: 'globex', lines: [line(200_00)] });
  bus.dispatch({ type: 'RecordPayment', orderId: 'o1', amountMinor: 400_00 });
  bus.dispatch({ type: 'RecordPayment', orderId: 'o1', amountMinor: 600_00 });
  bus.dispatch({ type: 'CancelOrder', orderId: 'o2', reason: 'duplicate' });
}

describe('command side', () => {
  it('enforces invariants and writes nothing when a command is refused', () => {
    const { bus, log } = setup();
    expect(() => bus.dispatch({ type: 'PlaceOrder', orderId: 'o1', customerId: 'c', lines: [] })).toThrow(InvariantViolation);
    bus.dispatch({ type: 'PlaceOrder', orderId: 'o1', customerId: 'c', lines: [line(100_00)] });
    expect(() => bus.dispatch({ type: 'PlaceOrder', orderId: 'o1', customerId: 'c', lines: [line(1)] })).toThrow(/already exists/);
    expect(() => bus.dispatch({ type: 'RecordPayment', orderId: 'o1', amountMinor: 100_01 })).toThrow(/overpayment/);
    bus.dispatch({ type: 'RecordPayment', orderId: 'o1', amountMinor: 50_00 });
    expect(() => bus.dispatch({ type: 'CancelOrder', orderId: 'o1', reason: 'x' })).toThrow(/refund before cancelling/);
    expect(log.head).toBe(2); // only the two accepted commands produced events
  });

  it('emits events as the only output of a command', () => {
    const { bus } = setup();
    const events = bus.dispatch({ type: 'PlaceOrder', orderId: 'o1', customerId: 'acme', lines: [line(250_00, 4)] });
    expect(events).toEqual([{ type: 'OrderPlaced', orderId: 'o1', customerId: 'acme', totalMinor: 1_000_00, at: '2026-01-01T00:00:00.000Z' }]);
  });
});

describe('query side', () => {
  it('makes lag observable: read models are stale until the projector catches up', () => {
    const { bus, queries, projectors } = setup();
    seed(bus);
    expect(queries.customerBalance('acme')).toBeUndefined();
    expect(projectors.map((p) => p.lag())).toEqual([6, 6]);

    projectors[1].catchUp(4); // partial catch-up: balances have seen only the first payment
    expect(queries.customerBalance('acme')).toMatchObject({ paidMinor: 400_00, outstandingMinor: 900_00 });
    expect(projectors[1].lag()).toBe(2);
  });

  it('updates denormalised read models after catch-up', () => {
    const { bus, queries, catchUp } = setup();
    seed(bus);
    expect(catchUp()).toBe(12); // six events into each of two projections
    expect(queries.customerBalance('acme')).toEqual({ customerId: 'acme', openOrders: 0, billedMinor: 1_000_00, paidMinor: 1_000_00, outstandingMinor: 0 });
    expect(queries.order('o1')).toMatchObject({ status: 'PAID', outstandingMinor: 0 });
    expect(queries.order('o2')?.status).toBe('CANCELLED');
    expect(queries.unpaidOrders().map((r) => r.orderId)).toEqual(['o3']);
  });

  it('catch-up is incremental and idempotent: running it again applies nothing', () => {
    const { bus, catchUp, queries } = setup();
    seed(bus);
    catchUp();
    expect(catchUp()).toBe(0);
    bus.dispatch({ type: 'RecordPayment', orderId: 'o3', amountMinor: 50_00 });
    expect(catchUp()).toBe(2);
    expect(queries.customerBalance('globex')?.outstandingMinor).toBe(150_00);
  });

  it('rebuilding from scratch yields the same read models', () => {
    const { bus, projectors, catchUp } = setup();
    seed(bus);
    catchUp();
    const live = projectors.map((p) => p.projection.snapshot());
    projectors.forEach((p) => p.rebuild());
    expect(projectors.map((p) => p.projection.snapshot())).toEqual(live);
  });

  it('adds a new read model later, backfilled from history, without touching existing code', () => {
    const { bus, log } = setup();
    seed(bus);
    class RevenueByDay implements Projection<Record<string, number>> {
      readonly name = 'revenue-by-day';
      private totals: Record<string, number> = {};
      reset(): void {
        this.totals = {};
      }
      apply({ event }: StoredEvent): void {
        if (event.type !== 'PaymentRecorded') return;
        const day = event.at.slice(0, 10);
        this.totals[day] = (this.totals[day] ?? 0) + event.amountMinor;
      }
      snapshot(): Record<string, number> {
        return { ...this.totals };
      }
    }
    const revenue = new Projector(log, new RevenueByDay());
    expect(revenue.lag()).toBe(6);
    revenue.catchUp();
    expect(revenue.projection.snapshot()).toEqual({ '2026-01-01': 1_000_00 });
  });
});
