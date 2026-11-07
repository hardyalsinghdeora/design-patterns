import { describe, expect, it } from 'vitest';
import {
  AuthMiddleware,
  HttpError,
  ManualClock,
  Pipeline,
  buildInvoiceApi,
  compose,
  createContext,
  errorHandler,
  requestLogger,
  timing,
  type AuthUser,
  type Context,
  type HttpRequest,
  type Middleware,
} from './middleware-pipeline';

const users: Record<string, AuthUser> = { 'tok-asha': { id: 'u_asha', roles: ['billing'] }, 'tok-root': { id: 'u_root', roles: ['admin'] } };
const verifyToken = (t: string) => users[t];

const post = (body: unknown, token?: string): HttpRequest => ({
  method: 'POST',
  path: '/invoices',
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body,
});

const api = () => {
  const lines: string[] = [];
  const clock = new ManualClock(1_000);
  return { lines, clock, handle: buildInvoiceApi({ clock, log: (l) => lines.push(l), verifyToken }) };
};

describe('compose (the onion)', () => {
  it('runs code before next() outside-in and code after next() inside-out', async () => {
    const trace: string[] = [];
    const layer =
      (name: string): Middleware<object> =>
      async (_ctx, next) => {
        trace.push(`${name} in`);
        await next();
        trace.push(`${name} out`);
      };
    await compose([layer('a'), layer('b'), layer('c')])({}, async () => {
      trace.push('handler');
    });
    expect(trace).toEqual(['a in', 'b in', 'c in', 'handler', 'c out', 'b out', 'a out']);
  });

  it('rejects when a middleware calls next() twice', async () => {
    const twice: Middleware<object> = async (_ctx, next) => {
      await next();
      await next();
    };
    await expect(compose([twice, () => undefined])({})).rejects.toThrow('next() called multiple times');
  });

  it('the error middleware catches sync throws and async rejections downstream', async () => {
    const log: string[] = [];
    const ctx = createContext({ method: 'GET', path: '/x', headers: {} }, 'r1');
    await compose<Context>([errorHandler((l) => log.push(l)), () => {
      throw new Error('db down');
    }])(ctx);
    expect(ctx.response).toMatchObject({ status: 500, body: { error: 'Internal Server Error', requestId: 'r1' } });

    const ctx2 = createContext({ method: 'GET', path: '/x', headers: {} }, 'r2');
    await compose<Context>([errorHandler((l) => log.push(l)), async () => Promise.reject(new HttpError(409, 'Duplicate invoice'))])(ctx2);
    expect(ctx2.response).toMatchObject({ status: 409, body: { error: 'Duplicate invoice' } });
    expect(log).toEqual(['!!! r1 db down']);
  });
});

describe('the invoice API pipeline', () => {
  it('short-circuits at auth without calling next(), while outer layers still unwind', async () => {
    const { handle, lines } = api();
    const res = await handle(post({ customerId: 'cus_1', amountMinor: 1_000 }), 'r1');
    expect(res.status).toBe(401);
    expect(res.headers['x-response-time']).toBe('0ms');
    expect(lines).toEqual(['--> r1 POST /invoices', '<-- r1 POST /invoices 401']);
    expect((await handle({ method: 'GET', path: '/health', headers: {} }, 'r2')).status).toBe(200);
  });

  it('times the request with the injected clock', async () => {
    const clock = new ManualClock(0);
    const slow: Middleware<Context> = (ctx) => {
      clock.advance(42);
      ctx.response.status = 200;
    };
    const ctx = createContext({ method: 'GET', path: '/slow', headers: {} }, 'r1');
    await new Pipeline<Context>().use(timing(clock)).use(slow).run(ctx);
    expect(ctx.response.headers['x-response-time']).toBe('42ms');
  });

  it('validates the body: 400 with every problem listed, or a typed body for the handler', async () => {
    const { handle } = api();
    const bad = await handle(post({ customerId: '', amountMinor: 10.5 }, 'tok-asha'), 'r1');
    expect(bad).toMatchObject({
      status: 400,
      body: { error: 'Invalid request body', details: ['customerId must be a non-empty string', 'amountMinor must be a positive integer (minor units)'] },
    });
    const ok = await handle(post({ customerId: 'cus_1', amountMinor: 2_499_00 }, 'tok-asha'), 'r2');
    expect(ok).toMatchObject({ status: 201, body: { id: 'inv_r2', customerId: 'cus_1', amountMinor: 2_499_00, createdBy: 'u_asha' } });
  });

  it('maps role checks and unexpected errors to responses, and logs the final status', async () => {
    const { handle, lines } = api();
    const del = (token: string): HttpRequest => ({ method: 'DELETE', path: '/invoices', headers: { authorization: `Bearer ${token}` } });
    expect((await handle(del('tok-asha'), 'r1')).status).toBe(403);
    expect((await handle(del('tok-root'), 'r2')).status).toBe(500);
    expect(lines.filter((l) => l.startsWith('<--') || l.startsWith('!!!'))).toEqual([
      '<-- r1 DELETE /invoices 403',
      '!!! r2 ledger connection refused',
      '<-- r2 DELETE /invoices 500',
    ]);
  });

  it('accepts new middleware, function or object, without touching the existing ones', async () => {
    const lines: string[] = [];
    const tagged = new Pipeline<Context>()
      .use(requestLogger((l) => lines.push(l)))
      .use({ handle: async (ctx, next) => { ctx.response.headers['x-request-id'] = ctx.state.requestId; await next(); } })
      .use(new AuthMiddleware(verifyToken))
      .use((ctx) => {
        ctx.response.status = 204;
      });
    const ctx = createContext({ method: 'GET', path: '/me', headers: { authorization: 'Bearer tok-root' } }, 'r9');
    await tagged.run(ctx);
    expect(ctx.response).toMatchObject({ status: 204, headers: { 'x-request-id': 'r9' } });
    expect(ctx.state.user?.id).toBe('u_root');
    expect(lines).toEqual(['--> r9 GET /me', '<-- r9 GET /me 204']);
  });
});
