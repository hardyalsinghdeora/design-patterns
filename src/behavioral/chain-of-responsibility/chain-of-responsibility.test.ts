import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationHandler,
  BaseHandler,
  BusinessHandler,
  RateLimitHandler,
  ValidationHandler,
  chain,
  escalate,
  level1,
  level2,
  level3,
  supportDesk,
  validateNewOrder,
  type ApiRequest,
  type ApiResponse,
  type TicketHandler,
} from './chain-of-responsibility';

const tokens = new Map([['tok_asha', 'asha'], ['tok_ravi', 'ravi']]);
const prices = new Map([['TEA-250G', 34_900], ['MUG', 29_900]]);
const validators = new Map([['POST /orders', validateNewOrder]]);

const postOrder = (token: string | undefined, body: unknown): ApiRequest => ({
  method: 'POST',
  path: '/orders',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body,
});
const get = (path: string, token = 'tok_asha'): ApiRequest => ({
  method: 'GET',
  path,
  headers: { authorization: `Bearer ${token}` },
});

function buildApi(limit = 3) {
  let now = 0;
  let seq = 0;
  const business = new BusinessHandler(prices, () => `ord_${++seq}`);
  const validation = new ValidationHandler(validators);
  const api = chain(
    new AuthenticationHandler(tokens),
    new RateLimitHandler(limit, 60_000, () => now),
    validation,
    business,
  );
  return { api, business, validation, advance: (ms: number) => (now += ms) };
}

describe('request pipeline (classic Chain of Responsibility)', () => {
  it('passes a valid request through every link to the business handler', () => {
    const { api, business } = buildApi();
    const response = api.handle(postOrder('tok_asha', { sku: 'TEA-250G', quantity: 2 }));
    expect(response).toMatchObject({
      status: 201,
      handledBy: 'business',
      body: { id: 'ord_1', owner: 'asha', totalMinor: 69_800 },
    });
    expect(business.orders).toHaveLength(1);
  });

  it('lets any link short-circuit: later links never see a rejected request', () => {
    const { api, business, validation } = buildApi();
    const validationSpy = vi.spyOn(validation, 'handle');
    const businessSpy = vi.spyOn(business, 'handle');

    const response = api.handle(postOrder(undefined, { sku: 'TEA-250G', quantity: 1 }));

    expect(response).toMatchObject({ status: 401, handledBy: 'authentication' });
    expect(validationSpy).not.toHaveBeenCalled();
    expect(businessSpy).not.toHaveBeenCalled();
  });

  it('rate-limits per principal on the injected clock, not on real time', () => {
    const { api, advance } = buildApi(2);
    expect(api.handle(get('/orders')).status).toBe(200);
    expect(api.handle(get('/orders')).status).toBe(200);
    expect(api.handle(get('/orders'))).toMatchObject({ status: 429, handledBy: 'rate-limit', body: { retryAfterMs: 60_000 } });
    expect(api.handle(get('/orders', 'tok_ravi')).status).toBe(200); // ravi has his own window

    advance(59_999);
    expect(api.handle(get('/orders')).body).toMatchObject({ retryAfterMs: 1 });
    advance(1);
    expect(api.handle(get('/orders')).status).toBe(200);
  });

  it('rejects a malformed body before the business logic runs', () => {
    const { api, business } = buildApi();
    const response = api.handle(postOrder('tok_asha', { sku: '', quantity: 0 }));
    expect(response).toEqual({
      status: 400,
      handledBy: 'validation',
      body: { errors: ['sku is required', 'quantity must be a positive integer'] },
    });
    expect(business.orders).toHaveLength(0);
  });

  it('gives a different answer when the same links are put in a different order', () => {
    const anonymousWithBadBody = postOrder(undefined, { quantity: -1 });
    const authFirst = chain(
      new AuthenticationHandler(tokens),
      new ValidationHandler(validators),
      new BusinessHandler(prices, () => 'ord_a'),
    );
    const validationFirst = chain(
      new ValidationHandler(validators),
      new AuthenticationHandler(tokens),
      new BusinessHandler(prices, () => 'ord_b'),
    );
    // Auth first: an anonymous caller learns nothing about the body rules.
    expect(authFirst.handle(anonymousWithBadBody).status).toBe(401);
    expect(validationFirst.handle(anonymousWithBadBody).status).toBe(400);
  });

  it('ends explicitly when no link accepts the request', () => {
    const { api } = buildApi();
    expect(api.handle(get('/invoices'))).toEqual({
      status: 404,
      handledBy: 'end-of-chain',
      body: { error: 'No handler for GET /invoices' },
    });
    // A lone handler with no successor ends the same way instead of returning undefined.
    expect(new ValidationHandler(validators).handle(get('/orders')).handledBy).toBe('end-of-chain');
  });

  it('accepts a new handler without touching the existing ones', () => {
    class MaintenanceModeHandler extends BaseHandler {
      override readonly name = 'maintenance';
      constructor(private readonly enabled: () => boolean) {
        super();
      }
      override handle(request: ApiRequest): ApiResponse {
        return this.enabled() && request.method !== 'GET'
          ? this.respond(503, { error: 'Writes are paused for maintenance' })
          : this.passOn(request);
      }
    }
    let maintenance = true;
    const api = chain(
      new MaintenanceModeHandler(() => maintenance),
      new AuthenticationHandler(tokens),
      new ValidationHandler(validators),
      new BusinessHandler(prices, () => 'ord_1'),
    );

    expect(api.handle(postOrder('tok_asha', { sku: 'MUG', quantity: 1 }))).toMatchObject({ status: 503, handledBy: 'maintenance' });
    expect(api.handle(get('/orders')).status).toBe(200);
    maintenance = false;
    expect(api.handle(postOrder('tok_asha', { sku: 'MUG', quantity: 1 })).status).toBe(201);
  });
});

describe('support escalation (functional form: an array of handlers)', () => {
  it('escalates L1 -> L2 -> L3 and ends explicitly when no tier can help', () => {
    expect(escalate(supportDesk, { id: 't1', category: 'password-reset' })).toMatchObject({ tier: 'L1', hops: 1 });
    expect(escalate(supportDesk, { id: 't2', category: 'refund', refundMinor: 2_000 * 100 })).toMatchObject({ tier: 'L2', hops: 2 });
    expect(escalate(supportDesk, { id: 't3', category: 'outage' })).toMatchObject({ tier: 'L3', hops: 3 });
    expect(escalate(supportDesk, { id: 't4', category: 'legal' })).toMatchObject({ tier: 'unassigned', hops: 3 });
  });

  it('adds a tier by adding an array element, and array order still decides who answers', () => {
    const legal: TicketHandler = (ticket) =>
      ticket.category === 'legal' ? { tier: 'Legal', action: 'Forwarded to counsel' } : undefined;
    expect(escalate([...supportDesk, legal], { id: 't4', category: 'legal' })).toMatchObject({ tier: 'Legal', hops: 4 });

    const smallRefund = { id: 't5', category: 'refund', refundMinor: 300 * 100 } as const;
    expect(escalate([level1, level2, level3], smallRefund).tier).toBe('L1');
    expect(escalate([level2, level1, level3], smallRefund).tier).toBe('L2');
  });
});
