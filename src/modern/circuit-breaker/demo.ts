import {
  CircuitOpenError,
  FlakyPaymentGateway,
  ManualClock,
  PaymentService,
  createGatewayBreaker,
} from './circuit-breaker';

const clock = new ManualClock();
const gateway = new FlakyPaymentGateway();
const breaker = createGatewayBreaker(clock);
const service = new PaymentService(gateway, breaker);

breaker.onStateChange((c) => console.log(`  [event] t=${c.at / 1000}s ${c.from} -> ${c.to}: ${c.reason}`));

const pay = async (label: string) => {
  try {
    const receipt = await service.charge({ paymentId: label, amountMinor: 49_900, currency: 'INR' });
    console.log(`  ${label}: ${receipt.status}${receipt.gatewayRef ? ` (${receipt.gatewayRef})` : ''}  state=${breaker.state}`);
  } catch (error) {
    console.log(`  ${label}: error ${(error as Error).message}  state=${breaker.state}`);
  }
};

console.log('\n1. Healthy gateway, then a 4xx (the request is wrong, the gateway is fine):');
gateway.willReply('ok', 'bad-request');
await pay('pay_1');
await pay('pay_2');

console.log('\n2. Gateway starts timing out. Fallback parks charges; the window fills up:');
gateway.setDefault('timeout');
for (let i = 3; i <= 8; i++) await pay(`pay_${i}`);
console.log(`  gateway was called ${gateway.calls} times; ${breaker.metrics().notPermittedCalls} calls short-circuited`);

console.log('\n3. Without a fallback the caller sees CircuitOpenError immediately:');
try {
  await breaker.execute(() => gateway.charge({ paymentId: 'raw', amountMinor: 100, currency: 'INR' }));
} catch (error) {
  if (error instanceof CircuitOpenError) console.log(`  ${error.message}`);
}

console.log('\n4. 30 s later the gateway has recovered; two trial calls close the circuit:');
clock.advance(30_000);
gateway.setDefault('ok');
await pay('pay_9');
await pay('pay_10');

console.log(`\nParked for the capture job: ${service.parked.map((r) => r.paymentId).join(', ')}\n`);
