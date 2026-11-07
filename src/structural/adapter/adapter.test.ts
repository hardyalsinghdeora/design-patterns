import { describe, expect, it } from 'vitest';
import {
  CheckoutService,
  GatewayError,
  GatewayToLegacyAdapter,
  LegacyPayKit,
  LegacyPayKitAdapter,
  LegacyPayKitClassAdapter,
  LegacySdkError,
  SandboxCardGateway,
  adaptPayKit,
  parseLegacyXml,
  type ChargeRequest,
  type LegacyIssuer,
} from './adapter';

/** A scripted bank: returns the queued response codes, or fails like a dropped socket. */
class ScriptedIssuer implements LegacyIssuer {
  readonly charges: Array<{ cardNo: string; paise: number }> = [];
  constructor(
    private readonly codes: string[] = [],
    private readonly down = false,
  ) {}
  authorise(cardNo: string, paise: number): string {
    this.charges.push({ cardNo, paise });
    if (this.down) throw new Error('ECONNRESET');
    return this.codes.shift() ?? '00';
  }
  reverse(): string {
    return '00';
  }
}

const request = (over: Partial<ChargeRequest> = {}): ChargeRequest => ({
  orderId: 'ord_1',
  amountMinor: 49_900,
  currency: 'INR',
  cardNumber: '4111 1111 1111 1111',
  ...over,
});

describe('Adapter: legacy PayKit behind PaymentGateway', () => {
  it('maps the domain request onto the positional legacy call', async () => {
    const issuer = new ScriptedIssuer();
    await new LegacyPayKitAdapter(new LegacyPayKit(issuer)).charge(request());
    expect(issuer.charges).toEqual([{ cardNo: '4111111111111111', paise: 49_900 }]);
  });

  it('maps the XML reply onto a typed result', async () => {
    const result = await new LegacyPayKitAdapter(new LegacyPayKit(new ScriptedIssuer())).charge(request());
    expect(result).toEqual({ status: 'succeeded', chargeId: 'PK000001', amountMinor: 49_900, cardLast4: '1111' });
  });

  it('translates issuer response codes into domain decline reasons', async () => {
    const gateway = new LegacyPayKitAdapter(new LegacyPayKit(new ScriptedIssuer(['51', '54', '91', '05', '99'])));
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await gateway.charge(request()));
    expect(results.map((r) => (r.status === 'declined' ? [r.reason, r.retryable] : r.status))).toEqual([
      ['insufficient_funds', false],
      ['expired_card', false],
      ['issuer_unavailable', true],
      ['do_not_honour', false],
      ['unknown', false],
    ]);
  });

  it('translates SDK errors into GatewayError and never leaks LegacySdkError', async () => {
    const down = new LegacyPayKitAdapter(new LegacyPayKit(new ScriptedIssuer([], true)));
    const err = await down.charge(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).not.toBeInstanceOf(LegacySdkError);
    expect(err).toMatchObject({ code: 'network', retryable: true });

    const issuer = new ScriptedIssuer();
    const usd = new LegacyPayKitAdapter(new LegacyPayKit(issuer)).charge(request({ currency: 'USD' }));
    await expect(usd).rejects.toMatchObject({ code: 'unsupported_currency' });
    expect(issuer.charges).toHaveLength(0); // refused before reaching the SDK
  });

  it('object, class and functional adapters behave identically', async () => {
    const gateways = [
      new LegacyPayKitAdapter(new LegacyPayKit(new ScriptedIssuer(['00', '51']))),
      new LegacyPayKitClassAdapter(new ScriptedIssuer(['00', '51'])),
      adaptPayKit(new LegacyPayKit(new ScriptedIssuer(['00', '51']))),
    ];
    for (const g of gateways) {
      expect(await g.charge(request())).toMatchObject({ status: 'succeeded', chargeId: 'PK000001' });
      expect(await g.charge(request())).toMatchObject({ status: 'declined', reason: 'insufficient_funds' });
    }
  });

  it('adapts refunds too', async () => {
    const gateway = new LegacyPayKitAdapter(new LegacyPayKit(new ScriptedIssuer()));
    expect(await gateway.refund('PK000001', 10_000)).toEqual({ status: 'refunded', refundId: 'RFPK000001', amountMinor: 10_000 });
  });
});

describe('the client depends only on PaymentGateway', () => {
  it('swaps the legacy adapter for a native gateway at runtime', async () => {
    const checkout = new CheckoutService(new LegacyPayKitAdapter(new LegacyPayKit(new ScriptedIssuer())));
    expect(await checkout.pay(request())).toEqual({ outcome: 'paid', chargeId: 'PK000001', gateway: 'paykit-legacy' });

    checkout.useGateway(new SandboxCardGateway(() => 'sb_1'));
    expect(await checkout.pay(request())).toEqual({ outcome: 'paid', chargeId: 'sb_1', gateway: 'sandbox' });
  });

  it('turns a dropped connection into a retryable outcome', async () => {
    const checkout = new CheckoutService(new LegacyPayKitAdapter(new LegacyPayKit(new ScriptedIssuer([], true))));
    expect(await checkout.pay(request())).toMatchObject({ outcome: 'error', code: 'network', retryable: true });
  });

  it('reverse adapter lets callback-style code run on a modern gateway', async () => {
    const legacyFacing = new GatewayToLegacyAdapter(new SandboxCardGateway(() => 'sb_9'), () => 'legacy_ord');
    const xml = await new Promise<string>((resolve, reject) =>
      legacyFacing.chargeCard('4111111111111111', 1_000, (err, body) => (err ? reject(err) : resolve(body ?? ''))),
    );
    expect(parseLegacyXml(xml)).toEqual({ rc: '00', txn: 'sb_9', amt: '1000' });
  });
});
