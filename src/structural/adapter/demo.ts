import {
  CheckoutService,
  GatewayToLegacyAdapter,
  LegacyPayKit,
  LegacyPayKitAdapter,
  SandboxCardGateway,
  type ChargeRequest,
  type LegacyIssuer,
} from './adapter';

// A fake bank: declines big amounts, drops the connection for one card.
const issuer: LegacyIssuer = {
  authorise(cardNo, paise) {
    if (cardNo.endsWith('0000')) throw new Error('ECONNRESET');
    return paise > 1_00_000 ? '51' : '00';
  },
  reverse: () => '00',
};

const kit = new LegacyPayKit(issuer);
console.log('\nThe legacy SDK speaks callbacks and XML:');
kit.chargeCard('4111111111111111', 49_900, (err, xml) => console.log('  chargeCard ->', err ?? xml));

const checkout = new CheckoutService(new LegacyPayKitAdapter(kit));
const order = (amountMinor: number, cardNumber = '4111 1111 1111 1111'): ChargeRequest => ({
  orderId: 'ord_42',
  amountMinor,
  currency: 'INR',
  cardNumber,
});

console.log('\nThe checkout speaks PaymentGateway (via the adapter):');
console.log('  Rs 499      ->', await checkout.pay(order(49_900)));
console.log('  Rs 5,000    ->', await checkout.pay(order(5_00_000)));
console.log('  flaky card  ->', await checkout.pay(order(49_900, '4000 0000 0000 0000')));
console.log('  USD order   ->', await checkout.pay({ ...order(1_000), currency: 'USD' }));

let n = 0;
const sandbox = new SandboxCardGateway(() => `sb_${++n}`);
checkout.useGateway(sandbox);
console.log('\nSwapped to a native gateway, checkout code unchanged:');
console.log('  Rs 499      ->', await checkout.pay(order(49_900)));

console.log('\nReverse adapter: old callback code now runs on the sandbox gateway:');
const legacyFacing = new GatewayToLegacyAdapter(sandbox, () => 'legacy_ord');
await new Promise<void>((done) =>
  legacyFacing.chargeCard('4111111111111111', 2_500, (err, xml) => {
    console.log('  chargeCard ->', err ?? xml);
    done();
  }),
);
console.log();
