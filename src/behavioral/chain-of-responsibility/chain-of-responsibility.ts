/**
 * CHAIN OF RESPONSIBILITY
 * Pass a request along a chain of handlers. Each one handles it, rejects it or
 * passes it on; the sender only knows the head of the chain.
 *
 * Example domain: the pipeline in front of an orders API (authentication ->
 * rate limit -> validation -> business logic), plus a support-ticket
 * escalation chain (L1 -> L2 -> L3) in functional form.
 * Amounts are integers in minor units (paise).
 */

export interface ApiRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  /** Set by AuthenticationHandler. Later links rely on it, which is why order matters. */
  readonly principal?: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  /** Which link produced the response. Without it the chain is invisible in logs and tests. */
  readonly handledBy: string;
}

/** The handler interface: deal with the request, or hand it to the next link. */
export interface RequestHandler {
  readonly name: string;
  setNext(next: RequestHandler): RequestHandler;
  handle(request: ApiRequest): ApiResponse;
}

/** What the caller gets when every link passed: an explicit 404, never `undefined`. */
export function endOfChain(request: ApiRequest): ApiResponse {
  return {
    status: 404,
    body: { error: `No handler for ${request.method} ${request.path}` },
    handledBy: 'end-of-chain',
  };
}

/**
 * Owns the link to the next handler, so a concrete handler contains only its
 * own decision. `passOn` is the single place that knows what "no next" means.
 */
export abstract class BaseHandler implements RequestHandler {
  abstract readonly name: string;
  private next: RequestHandler | undefined;

  /** Returns `next` so links read left to right: a.setNext(b).setNext(c). */
  setNext(next: RequestHandler): RequestHandler {
    this.next = next;
    return next;
  }

  abstract handle(request: ApiRequest): ApiResponse;

  protected passOn(request: ApiRequest): ApiResponse {
    return this.next ? this.next.handle(request) : endOfChain(request);
  }

  protected respond(status: number, body: unknown): ApiResponse {
    return { status, body, handledBy: this.name };
  }
}

/** Rejects anonymous callers; otherwise passes on a request that carries the principal. */
export class AuthenticationHandler extends BaseHandler {
  override readonly name = 'authentication';

  /** token -> user id. In production this verifies a JWT or looks up a session. */
  constructor(private readonly tokens: ReadonlyMap<string, string>) {
    super();
  }

  override handle(request: ApiRequest): ApiResponse {
    const header = request.headers['authorization'] ?? '';
    const principal = header.startsWith('Bearer ') ? this.tokens.get(header.slice(7)) : undefined;
    if (!principal) return this.respond(401, { error: 'Missing or invalid bearer token' });
    // Pass a new request instead of mutating the caller's object (Express sets req.user in place).
    return this.passOn({ ...request, principal });
  }
}

export type Clock = () => number;

/** Fixed-window limiter per principal. The clock is injected, so tests never sleep. */
export class RateLimitHandler extends BaseHandler {
  override readonly name = 'rate-limit';
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: Clock,
  ) {
    super();
  }

  override handle(request: ApiRequest): ApiResponse {
    // Keyed on the principal that AuthenticationHandler sets: this link must come after it.
    const key = request.principal ?? 'anonymous';
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) {
      const retryAfterMs = window.startedAt + this.windowMs - now;
      return this.respond(429, { error: 'Too many requests', retryAfterMs });
    }
    window.count += 1;
    return this.passOn(request);
  }
}

/** Returns the list of problems with a body; empty means valid. */
export type BodyValidator = (body: unknown) => string[];

export interface NewOrder {
  readonly sku: string;
  readonly quantity: number;
}

/** Validator for POST /orders. The price is not in the body: it comes from the catalogue. */
export const validateNewOrder: BodyValidator = (body) => {
  if (typeof body !== 'object' || body === null) return ['body must be a JSON object'];
  const errors: string[] = [];
  if (!('sku' in body) || typeof body.sku !== 'string' || body.sku === '') {
    errors.push('sku is required');
  }
  if (!('quantity' in body) || !Number.isInteger(body.quantity) || Number(body.quantity) < 1) {
    errors.push('quantity must be a positive integer');
  }
  return errors;
};

/** Rejects malformed bodies on the routes it has a validator for; passes everything else on. */
export class ValidationHandler extends BaseHandler {
  override readonly name = 'validation';

  /** Keyed by "METHOD /path", e.g. "POST /orders". */
  constructor(private readonly validators: ReadonlyMap<string, BodyValidator>) {
    super();
  }

  override handle(request: ApiRequest): ApiResponse {
    const validate = this.validators.get(`${request.method} ${request.path}`);
    const errors = validate ? validate(request.body) : [];
    return errors.length > 0 ? this.respond(400, { errors }) : this.passOn(request);
  }
}

export interface StoredOrder {
  readonly id: string;
  readonly owner: string;
  readonly sku: string;
  readonly quantity: number;
  readonly totalMinor: number;
}

/** The link that does the work. It handles the routes it owns and passes on the rest. */
export class BusinessHandler extends BaseHandler {
  override readonly name = 'business';
  readonly orders: StoredOrder[] = [];

  constructor(
    private readonly pricesMinor: ReadonlyMap<string, number>,
    private readonly nextId: () => string,
  ) {
    super();
  }

  override handle(request: ApiRequest): ApiResponse {
    const owner = request.principal ?? 'anonymous';
    if (request.method === 'GET' && request.path === '/orders') {
      return this.respond(200, this.orders.filter((order) => order.owner === owner));
    }
    if (request.method === 'POST' && request.path === '/orders') {
      // Trusts ValidationHandler, which runs earlier: an ordering dependency worth knowing about.
      const { sku, quantity } = request.body as NewOrder;
      const unitPriceMinor = this.pricesMinor.get(sku);
      if (unitPriceMinor === undefined) return this.respond(422, { error: `Unknown sku ${sku}` });
      const order: StoredOrder = { id: this.nextId(), owner, sku, quantity, totalMinor: unitPriceMinor * quantity };
      this.orders.push(order);
      return this.respond(201, order);
    }
    return this.passOn(request); // not our route: let the end of the chain answer
  }
}

/** Link handlers in the order given and return the head. The order is a decision: keep it in one place. */
export function chain(head: RequestHandler, ...rest: RequestHandler[]): RequestHandler {
  rest.reduce((previous, next) => previous.setNext(next), head);
  return head;
}

/* ------------------------------------------------------------------------ */
/* Functional form: when a handler is a single decision it is a function,    */
/* and the chain is an array. Return a result to handle, undefined to pass.  */
/* ------------------------------------------------------------------------ */

export interface SupportTicket {
  readonly id: string;
  readonly category: 'password-reset' | 'how-to' | 'refund' | 'outage' | 'legal';
  /** For refunds: the amount the customer asks for, in paise. */
  readonly refundMinor?: number;
}

export interface Resolution {
  readonly tier: string;
  readonly action: string;
}

export type TicketHandler = (ticket: SupportTicket) => Resolution | undefined;

/** L1, the help desk: canned answers and small goodwill refunds (up to Rs 500). */
export const level1: TicketHandler = (ticket) => {
  if (ticket.category === 'password-reset' || ticket.category === 'how-to') {
    return { tier: 'L1', action: 'Sent the help-centre article' };
  }
  if (ticket.category === 'refund' && (ticket.refundMinor ?? 0) <= 500 * 100) {
    return { tier: 'L1', action: 'Issued a goodwill refund' };
  }
  return undefined;
};

/** L2, billing: refunds up to Rs 10,000. */
export const level2: TicketHandler = (ticket) =>
  ticket.category === 'refund' && (ticket.refundMinor ?? 0) <= 10_000 * 100
    ? { tier: 'L2', action: 'Billing approved the refund' }
    : undefined;

/** L3, engineering: anything that smells like an outage. */
export const level3: TicketHandler = (ticket) =>
  ticket.category === 'outage' ? { tier: 'L3', action: 'Paged the on-call engineer' } : undefined;

export const supportDesk: readonly TicketHandler[] = [level1, level2, level3];

export interface EscalationOutcome extends Resolution {
  /** How many tiers looked at the ticket. */
  readonly hops: number;
}

/** Walk the array in order; the first handler that returns a resolution wins. */
export function escalate(handlers: readonly TicketHandler[], ticket: SupportTicket): EscalationOutcome {
  for (const [index, handler] of handlers.entries()) {
    const resolution = handler(ticket);
    if (resolution) return { ...resolution, hops: index + 1 };
  }
  // The explicit end of the chain: a person triages it, instead of the ticket vanishing.
  return { tier: 'unassigned', action: 'Queued for a team lead to triage', hops: handlers.length };
}
