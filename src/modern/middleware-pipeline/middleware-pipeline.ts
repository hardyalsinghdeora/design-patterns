/**
 * MIDDLEWARE PIPELINE
 * Compose small (ctx, next) functions into one handler. Each middleware runs code before `await next()`,
 * the rest of the pipeline runs inside that call, then it runs code after: the onion model (Koa-style).
 *
 * Example domain: an invoicing HTTP API with logging, timing, error handling, auth and body validation.
 * Amounts are integers in minor units (paise).
 */

/* ------------------------------------------------------------------------ */
/* The typed context every middleware shares.                                */
/* ------------------------------------------------------------------------ */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface AuthUser {
  id: string;
  roles: readonly string[];
}

/** What middlewares hand to later middlewares. Typed, unlike Koa's `ctx.state: any`. */
export interface AppState {
  requestId: string;
  user?: AuthUser;
}

export interface Context {
  request: HttpRequest;
  response: HttpResponse;
  state: AppState;
}

/** Koa's default: nothing matched yet means 404. */
export function createContext(request: HttpRequest, requestId: string): Context {
  return { request, response: { status: 404, headers: {}, body: { error: 'Not Found' } }, state: { requestId } };
}

/* ------------------------------------------------------------------------ */
/* compose(): the whole pattern in fifteen lines.                            */
/* ------------------------------------------------------------------------ */

export type Next = () => Promise<void>;
export type Middleware<C> = (ctx: C, next: Next) => Promise<void> | void;

export function compose<C>(middlewares: readonly Middleware<C>[]): (ctx: C, next?: Next) => Promise<void> {
  const stack = [...middlewares]; // later use() calls must not change an already-composed pipeline
  return (ctx, finalNext) => {
    let lastIndex = -1;
    const dispatch = (i: number): Promise<void> => {
      // Calling next() twice would run the rest of the pipeline twice (double charge, double write).
      if (i <= lastIndex) return Promise.reject(new Error('next() called multiple times'));
      lastIndex = i;
      if (i === stack.length) return finalNext ? finalNext() : Promise.resolve();
      try {
        // Promise.resolve() so a sync middleware and a sync throw behave like async ones.
        return Promise.resolve(stack[i](ctx, () => dispatch(i + 1)));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    return dispatch(0);
  };
}

/* ------------------------------------------------------------------------ */
/* Classic object form: a Pipeline that accepts functions or objects with    */
/* handle(ctx, next). Useful when a middleware has dependencies and state.   */
/* ------------------------------------------------------------------------ */

export interface MiddlewareObject<C> {
  handle(ctx: C, next: Next): Promise<void> | void;
}

export class Pipeline<C> {
  private readonly stack: Middleware<C>[] = [];
  private composed?: (ctx: C) => Promise<void>;

  use(middleware: Middleware<C> | MiddlewareObject<C>): this {
    this.stack.push(typeof middleware === 'function' ? middleware : (ctx, next) => middleware.handle(ctx, next));
    this.composed = undefined;
    return this;
  }

  run(ctx: C): Promise<void> {
    this.composed ??= compose(this.stack);
    return this.composed(ctx);
  }
}

/* ------------------------------------------------------------------------ */
/* Middlewares. Each knows one concern and nothing about the others.         */
/* ------------------------------------------------------------------------ */

export interface Clock {
  now(): number;
}

export class ManualClock implements Clock {
  constructor(private ms = 0) {}
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export type LogSink = (line: string) => void;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Outermost, so it sees the final status, whatever happened inside. */
export function requestLogger(log: LogSink): Middleware<Context> {
  return async (ctx, next) => {
    const { method, path } = ctx.request;
    log(`--> ${ctx.state.requestId} ${method} ${path}`);
    try {
      await next();
    } finally {
      log(`<-- ${ctx.state.requestId} ${method} ${path} ${ctx.response.status}`);
    }
  };
}

export function timing(clock: Clock): Middleware<Context> {
  return async (ctx, next) => {
    const start = clock.now();
    try {
      await next();
    } finally {
      ctx.response.headers['x-response-time'] = `${clock.now() - start}ms`;
    }
  };
}

/** Turns anything thrown downstream into a response. Internal details never reach the client. */
export function errorHandler(log: LogSink): Middleware<Context> {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.response.status = err.status;
        ctx.response.body = err.details.length ? { error: err.message, details: err.details } : { error: err.message };
        return;
      }
      log(`!!! ${ctx.state.requestId} ${err instanceof Error ? err.message : String(err)}`);
      ctx.response.status = 500;
      ctx.response.body = { error: 'Internal Server Error', requestId: ctx.state.requestId };
    }
  };
}

/** Class form: it has a dependency (the token verifier). Short-circuits with 401 by NOT calling next(). */
export class AuthMiddleware implements MiddlewareObject<Context> {
  constructor(private readonly verifyToken: (token: string) => AuthUser | undefined) {}

  handle(ctx: Context, next: Next): Promise<void> | void {
    const match = /^Bearer (.+)$/.exec(ctx.request.headers['authorization'] ?? '');
    const user = match ? this.verifyToken(match[1]) : undefined;
    if (!user) {
      ctx.response.status = 401;
      ctx.response.body = { error: 'Unauthorized' };
      return; // no next(): nothing downstream runs, everything upstream still unwinds
    }
    ctx.state.user = user;
    return next();
  }
}

export function requireRole(role: string): Middleware<Context> {
  return (ctx, next) => {
    if (!ctx.state.user?.roles.includes(role)) throw new HttpError(403, `Requires role ${role}`);
    return next();
  };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export type Parser<T> = (raw: unknown) => ParseResult<T>;

/** Validates, then calls the handler with a typed body. Invalid input becomes a 400 via errorHandler. */
export function validateBody<T>(parse: Parser<T>, handler: (ctx: Context, body: T) => Promise<void> | void): Middleware<Context> {
  return (ctx) => {
    const result = parse(ctx.request.body);
    if (!result.ok) throw new HttpError(400, 'Invalid request body', result.errors);
    return handler(ctx, result.value);
  };
}

/** A matching route handles the request and stops; otherwise it passes through. */
export function route(method: HttpMethod, path: string, handler: Middleware<Context>): Middleware<Context> {
  return (ctx, next) => (ctx.request.method === method && ctx.request.path === path ? handler(ctx, next) : next());
}

/* ------------------------------------------------------------------------ */
/* The application: order of use() is the order of the onion.               */
/* ------------------------------------------------------------------------ */

export interface CreateInvoiceBody {
  customerId: string;
  amountMinor: number;
}

export const parseCreateInvoice: Parser<CreateInvoiceBody> = (raw) => {
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['body must be a JSON object'] };
  const { customerId, amountMinor } = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof customerId !== 'string' || customerId === '') errors.push('customerId must be a non-empty string');
  if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    errors.push('amountMinor must be a positive integer (minor units)');
  }
  return errors.length || typeof customerId !== 'string' || typeof amountMinor !== 'number'
    ? { ok: false, errors }
    : { ok: true, value: { customerId, amountMinor } };
};

export interface InvoiceApiDeps {
  clock: Clock;
  log: LogSink;
  verifyToken: (token: string) => AuthUser | undefined;
}

export function buildInvoiceApi(deps: InvoiceApiDeps): (request: HttpRequest, requestId: string) => Promise<HttpResponse> {
  const app = new Pipeline<Context>()
    .use(requestLogger(deps.log))
    .use(timing(deps.clock))
    .use(errorHandler(deps.log))
    .use(
      route('GET', '/health', (ctx) => {
        ctx.response.status = 200;
        ctx.response.body = { ok: true };
      }),
    ) // before auth on purpose: health checks carry no token
    .use(new AuthMiddleware(deps.verifyToken))
    .use(
      route(
        'POST',
        '/invoices',
        validateBody(parseCreateInvoice, (ctx, body) => {
          ctx.response.status = 201;
          ctx.response.body = { id: `inv_${ctx.state.requestId}`, ...body, createdBy: ctx.state.user?.id };
        }),
      ),
    )
    .use(requireRole('admin'))
    .use(
      route('DELETE', '/invoices', () => {
        throw new Error('ledger connection refused'); // a bug or outage: errorHandler turns it into a 500
      }),
    );

  return async (request, requestId) => {
    const ctx = createContext(request, requestId);
    await app.run(ctx);
    return ctx.response;
  };
}
