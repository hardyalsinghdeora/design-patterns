/**
 * ADAPTER
 * Convert the interface of an existing class into the one clients expect, so a
 * legacy callback-and-XML payment SDK can sit behind the app's PaymentGateway.
 *
 * Example domain: an old bank SDK ("PayKit") that we cannot change, adapted to
 * a promise-based, typed gateway. Amounts are integers in minor units (paise).
 */

/* ------------------------------------------------------------------------ */
/* The adaptee: a legacy SDK we do not own. Callbacks, strings, XML replies. */
/* ------------------------------------------------------------------------ */

/** Node-style callback the SDK uses. `xml` is a flat XML-ish reply. */
export type LegacyCallback = (err: LegacySdkError | null, xml?: string) => void;

export class LegacySdkError extends Error {
  constructor(
    readonly sdkCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'LegacySdkError';
  }
}

/** The bank on the other side of the SDK. Injected so the example is deterministic. */
export interface LegacyIssuer {
  /** Returns an ISO-8583-style response code ('00' = approved) or throws on a socket error. */
  authorise(cardNo: string, paise: number): string;
  reverse(txnRef: string, paise: number): string;
}

/** The surface of the SDK that old modules in the code base call. */
export interface LegacyPayKitApi {
  chargeCard(cardNo: string, paise: number, cb: LegacyCallback): void;
  refundTxn(txnRef: string, paise: number, cb: LegacyCallback): void;
}

export class LegacyPayKit implements LegacyPayKitApi {
  private seq = 0;

  constructor(private readonly issuer: LegacyIssuer) {}

  chargeCard(cardNo: string, paise: number, cb: LegacyCallback): void {
    if (!/^\d{12,19}$/.test(cardNo)) return cb(new LegacySdkError('E_FORMAT', 'card number must be 12-19 digits'));
    if (!Number.isInteger(paise) || paise <= 0) return cb(new LegacySdkError('E_FORMAT', 'amount must be positive paise'));
    let rc: string;
    try {
      rc = this.issuer.authorise(cardNo, paise);
    } catch (e) {
      return cb(new LegacySdkError('E_NET', e instanceof Error ? e.message : 'network error'));
    }
    const txn = `PK${String(++this.seq).padStart(6, '0')}`;
    // Note: this SDK calls back synchronously. The adapter's Promise hides that.
    cb(null, `<resp><rc>${rc}</rc><txn>${txn}</txn><amt>${paise}</amt><last4>${cardNo.slice(-4)}</last4></resp>`);
  }

  refundTxn(txnRef: string, paise: number, cb: LegacyCallback): void {
    let rc: string;
    try {
      rc = this.issuer.reverse(txnRef, paise);
    } catch (e) {
      return cb(new LegacySdkError('E_NET', e instanceof Error ? e.message : 'network error'));
    }
    cb(null, `<resp><rc>${rc}</rc><txn>RF${txnRef}</txn><amt>${paise}</amt></resp>`);
  }
}

/* ------------------------------------------------------------------------ */
/* The target: what the application wants to depend on.                     */
/* ------------------------------------------------------------------------ */

export type Currency = 'INR' | 'USD';

export interface ChargeRequest {
  orderId: string;
  amountMinor: number;
  currency: Currency;
  cardNumber: string;
}

export type DeclineReason = 'do_not_honour' | 'insufficient_funds' | 'expired_card' | 'issuer_unavailable' | 'unknown';

export type ChargeResult =
  | { status: 'succeeded'; chargeId: string; amountMinor: number; cardLast4: string }
  | { status: 'declined'; chargeId: string; reason: DeclineReason; retryable: boolean };

export type RefundResult =
  | { status: 'refunded'; refundId: string; amountMinor: number }
  | { status: 'failed'; reason: DeclineReason; retryable: boolean };

export type GatewayErrorCode = 'invalid_request' | 'unsupported_currency' | 'network' | 'bad_response' | 'unknown';

/** The only error type callers of a PaymentGateway ever see. */
export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface PaymentGateway {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(chargeId: string, amountMinor: number): Promise<RefundResult>;
}

/* ------------------------------------------------------------------------ */
/* Translation helpers shared by every adapter form.                         */
/* ------------------------------------------------------------------------ */

const RESPONSE_CODES: Record<string, { reason: DeclineReason; retryable: boolean }> = {
  '05': { reason: 'do_not_honour', retryable: false },
  '51': { reason: 'insufficient_funds', retryable: false },
  '54': { reason: 'expired_card', retryable: false },
  '91': { reason: 'issuer_unavailable', retryable: true },
};

const declineFor = (rc: string) => RESPONSE_CODES[rc] ?? { reason: 'unknown' as const, retryable: false };

/** Reads `<tag>value</tag>` pairs. Deliberately tiny: the SDK's replies are flat. */
export function parseLegacyXml(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [, tag, value] of xml.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) {
    if (tag !== undefined && value !== undefined) fields[tag] = value;
  }
  return fields;
}

/** Parameter mapping: domain request -> the SDK's positional arguments. */
export function toLegacyArgs(request: ChargeRequest): { cardNo: string; paise: number } {
  // The SDK only speaks INR; refusing here keeps a USD charge from being booked as paise.
  if (request.currency !== 'INR') {
    throw new GatewayError('unsupported_currency', false, `PayKit cannot charge ${request.currency}`);
  }
  return { cardNo: request.cardNumber.replace(/[\s-]/g, ''), paise: request.amountMinor };
}

/** Error translation: SDK codes never cross the adapter boundary. */
export function translateSdkError(err: LegacySdkError): GatewayError {
  if (err.sdkCode === 'E_FORMAT') return new GatewayError('invalid_request', false, err.message);
  if (err.sdkCode === 'E_NET') return new GatewayError('network', true, err.message);
  return new GatewayError('unknown', false, `${err.sdkCode}: ${err.message}`);
}

function required(fields: Record<string, string>, tag: string): string {
  const value = fields[tag];
  if (value === undefined) throw new GatewayError('bad_response', false, `PayKit reply has no <${tag}>`);
  return value;
}

function minor(fields: Record<string, string>): number {
  const amount = Number(required(fields, 'amt'));
  if (!Number.isInteger(amount)) throw new GatewayError('bad_response', false, 'PayKit amount is not an integer');
  return amount;
}

/** Result mapping: XML reply -> typed union. */
export function toChargeResult(xml: string): ChargeResult {
  const f = parseLegacyXml(xml);
  const rc = required(f, 'rc');
  const chargeId = required(f, 'txn');
  if (rc === '00') return { status: 'succeeded', chargeId, amountMinor: minor(f), cardLast4: f['last4'] ?? '' };
  return { status: 'declined', chargeId, ...declineFor(rc) };
}

export function toRefundResult(xml: string): RefundResult {
  const f = parseLegacyXml(xml);
  const rc = required(f, 'rc');
  if (rc === '00') return { status: 'refunded', refundId: required(f, 'txn'), amountMinor: minor(f) };
  return { status: 'failed', ...declineFor(rc) };
}

/** Callback -> Promise. Also normalises the SDK's sync-or-async callback timing. */
function callLegacy(invoke: (cb: LegacyCallback) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    invoke((err, xml) => {
      if (err) reject(translateSdkError(err));
      else if (xml === undefined) reject(new GatewayError('bad_response', false, 'PayKit returned no body'));
      else resolve(xml);
    });
  });
}

/* ------------------------------------------------------------------------ */
/* 1. Object adapter (composition). The default choice.                      */
/* ------------------------------------------------------------------------ */

export class LegacyPayKitAdapter implements PaymentGateway {
  readonly name = 'paykit-legacy';

  constructor(private readonly kit: LegacyPayKitApi) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const { cardNo, paise } = toLegacyArgs(request);
    return toChargeResult(await callLegacy((cb) => this.kit.chargeCard(cardNo, paise, cb)));
  }

  async refund(chargeId: string, amountMinor: number): Promise<RefundResult> {
    return toRefundResult(await callLegacy((cb) => this.kit.refundTxn(chargeId, amountMinor, cb)));
  }
}

/* ------------------------------------------------------------------------ */
/* 2. Class adapter (inheritance). Is-a PayKit and a PaymentGateway, so it   */
/*    also leaks chargeCard/refundTxn to anyone holding the concrete type.   */
/* ------------------------------------------------------------------------ */

export class LegacyPayKitClassAdapter extends LegacyPayKit implements PaymentGateway {
  readonly name = 'paykit-legacy-class';

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const { cardNo, paise } = toLegacyArgs(request);
    return toChargeResult(await callLegacy((cb) => this.chargeCard(cardNo, paise, cb)));
  }

  async refund(chargeId: string, amountMinor: number): Promise<RefundResult> {
    return toRefundResult(await callLegacy((cb) => this.refundTxn(chargeId, amountMinor, cb)));
  }
}

/* ------------------------------------------------------------------------ */
/* 3. Idiomatic TypeScript: a function returning an object literal. Same     */
/*    shape, no class, the adaptee captured in a closure.                    */
/* ------------------------------------------------------------------------ */

export function adaptPayKit(kit: LegacyPayKitApi): PaymentGateway {
  return {
    name: 'paykit-fn',
    charge: async (request) => {
      const { cardNo, paise } = toLegacyArgs(request);
      return toChargeResult(await callLegacy((cb) => kit.chargeCard(cardNo, paise, cb)));
    },
    refund: async (chargeId, amountMinor) =>
      toRefundResult(await callLegacy((cb) => kit.refundTxn(chargeId, amountMinor, cb))),
  };
}

/* ------------------------------------------------------------------------ */
/* The other direction: old callback-style modules keep calling chargeCard,  */
/* but the money now moves through a modern gateway (strangler migration).   */
/* ------------------------------------------------------------------------ */

const REASON_TO_RC: Record<DeclineReason, string> = {
  do_not_honour: '05',
  insufficient_funds: '51',
  expired_card: '54',
  issuer_unavailable: '91',
  unknown: '96',
};

function toLegacyError(e: unknown): LegacySdkError {
  if (e instanceof GatewayError) return new LegacySdkError(e.code === 'network' ? 'E_NET' : 'E_FORMAT', e.message);
  return new LegacySdkError('E_UNKNOWN', e instanceof Error ? e.message : String(e));
}

export class GatewayToLegacyAdapter implements LegacyPayKitApi {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly orderIdFor: () => string,
  ) {}

  chargeCard(cardNo: string, paise: number, cb: LegacyCallback): void {
    this.gateway.charge({ orderId: this.orderIdFor(), amountMinor: paise, currency: 'INR', cardNumber: cardNo }).then(
      (r) =>
        cb(
          null,
          r.status === 'succeeded'
            ? `<resp><rc>00</rc><txn>${r.chargeId}</txn><amt>${r.amountMinor}</amt></resp>`
            : `<resp><rc>${REASON_TO_RC[r.reason]}</rc><txn>${r.chargeId}</txn></resp>`,
        ),
      (e: unknown) => cb(toLegacyError(e)),
    );
  }

  refundTxn(txnRef: string, paise: number, cb: LegacyCallback): void {
    this.gateway.refund(txnRef, paise).then(
      (r) =>
        cb(
          null,
          r.status === 'refunded'
            ? `<resp><rc>00</rc><txn>${r.refundId}</txn><amt>${r.amountMinor}</amt></resp>`
            : `<resp><rc>${REASON_TO_RC[r.reason]}</rc></resp>`,
        ),
      (e: unknown) => cb(toLegacyError(e)),
    );
  }
}

/* ------------------------------------------------------------------------ */
/* A native gateway (no adapter needed) and the client.                      */
/* ------------------------------------------------------------------------ */

export class SandboxCardGateway implements PaymentGateway {
  readonly name = 'sandbox';

  constructor(
    private readonly nextId: () => string,
    private readonly limitMinor = 5_00_000,
  ) {}

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const chargeId = this.nextId();
    if (request.amountMinor > this.limitMinor) {
      return { status: 'declined', chargeId, reason: 'insufficient_funds', retryable: false };
    }
    return { status: 'succeeded', chargeId, amountMinor: request.amountMinor, cardLast4: request.cardNumber.slice(-4) };
  }

  async refund(_chargeId: string, amountMinor: number): Promise<RefundResult> {
    return { status: 'refunded', refundId: this.nextId(), amountMinor };
  }
}

export type CheckoutOutcome =
  | { outcome: 'paid'; chargeId: string; gateway: string }
  | { outcome: 'declined'; reason: DeclineReason; retryable: boolean; gateway: string }
  | { outcome: 'error'; code: GatewayErrorCode; retryable: boolean; gateway: string };

/** The client. It knows PaymentGateway and GatewayError, nothing about PayKit. */
export class CheckoutService {
  constructor(private gateway: PaymentGateway) {}

  useGateway(gateway: PaymentGateway): void {
    this.gateway = gateway;
  }

  async pay(request: ChargeRequest): Promise<CheckoutOutcome> {
    const gateway = this.gateway.name;
    try {
      const r = await this.gateway.charge(request);
      return r.status === 'succeeded'
        ? { outcome: 'paid', chargeId: r.chargeId, gateway }
        : { outcome: 'declined', reason: r.reason, retryable: r.retryable, gateway };
    } catch (e) {
      if (e instanceof GatewayError) return { outcome: 'error', code: e.code, retryable: e.retryable, gateway };
      throw e;
    }
  }
}
