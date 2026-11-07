import { describe, expect, it } from 'vitest';
import {
  CircuitOpenError,
  FlakyPaymentGateway,
  GatewayHttpError,
  ManualClock,
  PaymentService,
  createGatewayBreaker,
  type StateChange,
} from './circuit-breaker';

const request = (paymentId = 'pay_1') => ({ paymentId, amountMinor: 49_900, currency: 'INR' as const });
const settle = (p: Promise<unknown>): Promise<unknown> => p.then(
  () => 'ok',
  (e: unknown) => e,
);

function setup() {
  const clock = new ManualClock();
  const breaker = createGatewayBreaker(clock); // 50 % over 10 calls, min 5, open 30 s, 2 trials
  const gateway = new FlakyPaymentGateway();
  const changes: StateChange[] = [];
  breaker.onStateChange((c) => changes.push(c));
  const charge = () => breaker.execute(() => gateway.charge(request()));
  const tripOpen = async () => {
    gateway.willReply('timeout', 'timeout', 'timeout', 'timeout', 'timeout');
    for (let i = 0; i < 5; i++) await settle(charge());
  };
  return { clock, breaker, gateway, changes, charge, tripOpen };
}

describe('CircuitBreaker', () => {
  it('opens once the failure rate crosses the threshold, but not before the minimum number of calls', async () => {
    const { breaker, gateway, changes, charge } = setup();
    gateway.willReply('ok', 'timeout', 'server-error', 'ok', 'timeout');
    for (let i = 0; i < 4; i++) await settle(charge());
    expect(breaker.state).toBe('CLOSED'); // 2 of 4 failed, but 4 < minimumNumberOfCalls
    await settle(charge());
    expect(breaker.state).toBe('OPEN'); // 3 of 5 = 60 %
    expect(changes.map((c) => `${c.from}->${c.to}`)).toEqual(['CLOSED->OPEN']);
  });

  it('rejects fast while open without invoking the inner call', async () => {
    const { clock, gateway, charge, tripOpen } = setup();
    await tripOpen();
    const callsSoFar = gateway.calls;
    clock.advance(10_000);
    const error = await settle(charge());
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as CircuitOpenError).retryAfterMs).toBe(20_000);
    expect(gateway.calls).toBe(callsSoFar);
  });

  it('moves to HALF_OPEN after the open duration and closes when the trial calls succeed', async () => {
    const { clock, breaker, changes, charge, tripOpen } = setup();
    await tripOpen();
    clock.advance(30_000);
    expect(breaker.state).toBe('HALF_OPEN');
    await charge();
    expect(breaker.state).toBe('HALF_OPEN'); // one of two trials done
    await charge();
    expect(breaker.state).toBe('CLOSED');
    expect(changes.map((c) => c.to)).toEqual(['OPEN', 'HALF_OPEN', 'CLOSED']);
  });

  it('reopens for a full open duration when a trial call fails', async () => {
    const { clock, breaker, gateway, charge, tripOpen } = setup();
    await tripOpen();
    clock.advance(30_000);
    gateway.willReply('server-error');
    await settle(charge());
    expect(breaker.state).toBe('OPEN');
    expect(((await settle(charge())) as CircuitOpenError).retryAfterMs).toBe(30_000);
  });

  it('allows only the permitted number of concurrent trial calls in HALF_OPEN', async () => {
    const { clock, breaker, tripOpen } = setup();
    await tripOpen();
    clock.advance(30_000);
    const releases: Array<() => void> = [];
    const slowCall = () => new Promise<string>((resolve) => releases.push(() => resolve('done')));
    const trials = [breaker.execute(slowCall), breaker.execute(slowCall)];
    await expect(breaker.execute(slowCall)).rejects.toBeInstanceOf(CircuitOpenError);
    releases.forEach((release) => release());
    await Promise.all(trials);
    expect(breaker.state).toBe('CLOSED');
  });

  it('uses the fallback when open and when a counted error occurs', async () => {
    const clock = new ManualClock();
    const gateway = new FlakyPaymentGateway('timeout');
    const service = new PaymentService(gateway, createGatewayBreaker(clock));
    const receipts = [];
    for (let i = 0; i < 7; i++) receipts.push(await service.charge(request(`pay_${i}`)));
    expect(receipts.every((r) => r.status === 'queued')).toBe(true);
    expect(gateway.calls).toBe(5); // calls 6 and 7 were short-circuited
    expect(service.parked).toHaveLength(7);
    expect(service.breaker.metrics().notPermittedCalls).toBe(2);
  });

  it('never trips on errors the predicate does not count, and does not hide them behind the fallback', async () => {
    const clock = new ManualClock();
    const gateway = new FlakyPaymentGateway('bad-request');
    const service = new PaymentService(gateway, createGatewayBreaker(clock));
    for (let i = 0; i < 20; i++) {
      const error = await settle(service.charge(request()));
      expect(error).toBeInstanceOf(GatewayHttpError);
    }
    expect(service.breaker.state).toBe('CLOSED');
    expect(service.parked).toHaveLength(0);
    expect(gateway.calls).toBe(20);
  });

  it('wraps a plain function and keeps its signature', async () => {
    const { breaker, gateway, tripOpen } = setup();
    const charge = breaker.wrap(
      (req: ReturnType<typeof request>) => gateway.charge(req),
      (_error, req) => ({ paymentId: req.paymentId, status: 'queued' as const }),
    );
    expect((await charge(request('pay_a'))).status).toBe('captured');
    await tripOpen();
    expect(await charge(request('pay_b'))).toEqual({ paymentId: 'pay_b', status: 'queued' });
  });
});
