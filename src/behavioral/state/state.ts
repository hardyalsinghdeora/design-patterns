/**
 * STATE
 * An object delegates its behaviour to a state object and swaps that object when
 * its state changes, so each state's rules live in one class instead of a switch per method.
 *
 * Example domain: a SaaS subscription lifecycle with dunning.
 * Amounts are integers in minor units (paise).
 */

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELLED';
export type SubscriptionAction = 'pay' | 'fail' | 'pause' | 'resume' | 'cancel';

export class InvalidTransitionError extends Error {
  constructor(
    readonly status: SubscriptionStatus,
    readonly action: SubscriptionAction,
  ) {
    super(`Cannot ${action} a subscription that is ${status}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface Transition {
  readonly from: SubscriptionStatus;
  readonly to: SubscriptionStatus;
  readonly action: SubscriptionAction;
  readonly at: Date;
}

export interface SubscriptionSnapshot {
  readonly status: SubscriptionStatus;
  readonly failedAttempts: number;
  readonly periodsPaid: number;
  readonly totalPaidMinor: number;
}

/** What both implementations offer, so tests can run one script against each. */
export interface SubscriptionMachine {
  readonly status: SubscriptionStatus;
  readonly history: readonly Transition[];
  pay(): void;
  fail(): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  snapshot(): SubscriptionSnapshot;
}

export interface SubscriptionOptions {
  planPriceMinor: number;
  /** Failed charges allowed in PAST_DUE before the subscription is cancelled. */
  maxFailedAttempts?: number;
  now?: () => Date;
}

/* ------------------------------------------------------------------------ */
/* Classic form: one class per state                                         */
/* ------------------------------------------------------------------------ */

/**
 * What a state may do to its subscription. States get this narrow handle, not
 * the Subscription itself, so clients cannot call `transitionTo` directly.
 */
export interface SubscriptionContext {
  failedAttempts(): number;
  readonly maxFailedAttempts: number;
  recordPayment(): void;
  recordFailure(): void;
  transitionTo(next: SubscriptionState, action: SubscriptionAction): void;
}

/** The base class rejects everything: a state lists only what it allows. */
export abstract class SubscriptionState {
  abstract readonly status: SubscriptionStatus;

  pay(_ctx: SubscriptionContext): void {
    this.reject('pay');
  }
  fail(_ctx: SubscriptionContext): void {
    this.reject('fail');
  }
  pause(_ctx: SubscriptionContext): void {
    this.reject('pause');
  }
  resume(_ctx: SubscriptionContext): void {
    this.reject('resume');
  }
  cancel(ctx: SubscriptionContext): void {
    // Every non-terminal state can be cancelled; CancelledState overrides this.
    ctx.transitionTo(STATES.CANCELLED, 'cancel');
  }

  protected reject(action: SubscriptionAction): never {
    throw new InvalidTransitionError(this.status, action);
  }
}

export class TrialingState extends SubscriptionState {
  readonly status = 'TRIALING';
  override pay(ctx: SubscriptionContext): void {
    ctx.recordPayment();
    ctx.transitionTo(STATES.ACTIVE, 'pay');
  }
  override fail(ctx: SubscriptionContext): void {
    ctx.recordFailure(); // the card on file failed at trial conversion
    ctx.transitionTo(STATES.PAST_DUE, 'fail');
  }
}

export class ActiveState extends SubscriptionState {
  readonly status = 'ACTIVE';
  override pay(ctx: SubscriptionContext): void {
    ctx.recordPayment(); // renewal: the state does not change
  }
  override fail(ctx: SubscriptionContext): void {
    ctx.recordFailure();
    ctx.transitionTo(STATES.PAST_DUE, 'fail');
  }
  override pause(ctx: SubscriptionContext): void {
    ctx.transitionTo(STATES.PAUSED, 'pause');
  }
}

export class PastDueState extends SubscriptionState {
  readonly status = 'PAST_DUE';
  override pay(ctx: SubscriptionContext): void {
    ctx.recordPayment();
    ctx.transitionTo(STATES.ACTIVE, 'pay');
  }
  override fail(ctx: SubscriptionContext): void {
    ctx.recordFailure();
    // Dunning: retry until the limit, then give up.
    if (ctx.failedAttempts() >= ctx.maxFailedAttempts) ctx.transitionTo(STATES.CANCELLED, 'fail');
  }
}

export class PausedState extends SubscriptionState {
  readonly status = 'PAUSED';
  override resume(ctx: SubscriptionContext): void {
    ctx.transitionTo(STATES.ACTIVE, 'resume');
  }
}

export class CancelledState extends SubscriptionState {
  readonly status = 'CANCELLED';
  override cancel(): void {
    this.reject('cancel'); // terminal: even a second cancel is a client bug worth surfacing
  }
}

/** States hold no data, so one instance of each is shared by every subscription. */
const STATES = {
  TRIALING: new TrialingState(),
  ACTIVE: new ActiveState(),
  PAST_DUE: new PastDueState(),
  PAUSED: new PausedState(),
  CANCELLED: new CancelledState(),
} as const;

/** The context. Its methods are one line each: no `switch (this.status)` anywhere. */
export class Subscription implements SubscriptionMachine {
  private state: SubscriptionState = STATES.TRIALING;
  private failed = 0;
  private periods = 0;
  private paidMinor = 0;
  private readonly transitions: Transition[] = [];
  private readonly ctx: SubscriptionContext;
  private readonly now: () => Date;

  constructor(
    readonly id: string,
    private readonly options: SubscriptionOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.ctx = {
      failedAttempts: () => this.failed,
      maxFailedAttempts: options.maxFailedAttempts ?? 3,
      recordPayment: () => {
        this.periods += 1;
        this.paidMinor += this.options.planPriceMinor;
        this.failed = 0;
      },
      recordFailure: () => {
        this.failed += 1;
      },
      transitionTo: (next, action) => {
        this.transitions.push({ from: this.state.status, to: next.status, action, at: this.now() });
        this.state = next;
      },
    };
  }

  get status(): SubscriptionStatus {
    return this.state.status;
  }

  get history(): readonly Transition[] {
    return [...this.transitions];
  }

  pay(): void {
    this.state.pay(this.ctx);
  }
  fail(): void {
    this.state.fail(this.ctx);
  }
  pause(): void {
    this.state.pause(this.ctx);
  }
  resume(): void {
    this.state.resume(this.ctx);
  }
  cancel(): void {
    this.state.cancel(this.ctx);
  }

  snapshot(): SubscriptionSnapshot {
    return { status: this.status, failedAttempts: this.failed, periodsPaid: this.periods, totalPaidMinor: this.paidMinor };
  }
}

/* ------------------------------------------------------------------------ */
/* Table-driven alternative: the whole machine is data                       */
/* ------------------------------------------------------------------------ */

interface Counters {
  readonly failedAttempts: number;
  readonly maxFailedAttempts: number;
}

interface Rule {
  readonly effect?: 'recordPayment' | 'recordFailure';
  /** A fixed target, or a guard evaluated after the effect. */
  readonly to: SubscriptionStatus | ((counters: Counters) => SubscriptionStatus);
}

const cancelRule: Rule = { to: 'CANCELLED' };

/** Status -> action -> rule. A missing entry is an invalid transition. */
export const TRANSITIONS: Readonly<Record<SubscriptionStatus, Readonly<Partial<Record<SubscriptionAction, Rule>>>>> = {
  TRIALING: { pay: { effect: 'recordPayment', to: 'ACTIVE' }, fail: { effect: 'recordFailure', to: 'PAST_DUE' }, cancel: cancelRule },
  ACTIVE: {
    pay: { effect: 'recordPayment', to: 'ACTIVE' },
    fail: { effect: 'recordFailure', to: 'PAST_DUE' },
    pause: { to: 'PAUSED' },
    cancel: cancelRule,
  },
  PAST_DUE: {
    pay: { effect: 'recordPayment', to: 'ACTIVE' },
    fail: { effect: 'recordFailure', to: (c) => (c.failedAttempts >= c.maxFailedAttempts ? 'CANCELLED' : 'PAST_DUE') },
    cancel: cancelRule,
  },
  PAUSED: { resume: { to: 'ACTIVE' }, cancel: cancelRule },
  CANCELLED: {},
};

/** The table makes questions like "which buttons should the UI show?" a lookup. */
export function allowedActions(status: SubscriptionStatus): SubscriptionAction[] {
  return Object.keys(TRANSITIONS[status]) as SubscriptionAction[];
}

export class TableDrivenSubscription implements SubscriptionMachine {
  private current: SubscriptionStatus = 'TRIALING';
  private failed = 0;
  private periods = 0;
  private paidMinor = 0;
  private readonly transitions: Transition[] = [];
  private readonly now: () => Date;
  private readonly maxFailedAttempts: number;

  constructor(
    readonly id: string,
    private readonly options: SubscriptionOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxFailedAttempts = options.maxFailedAttempts ?? 3;
  }

  get status(): SubscriptionStatus {
    return this.current;
  }

  get history(): readonly Transition[] {
    return [...this.transitions];
  }

  pay(): void {
    this.apply('pay');
  }
  fail(): void {
    this.apply('fail');
  }
  pause(): void {
    this.apply('pause');
  }
  resume(): void {
    this.apply('resume');
  }
  cancel(): void {
    this.apply('cancel');
  }

  snapshot(): SubscriptionSnapshot {
    return { status: this.current, failedAttempts: this.failed, periodsPaid: this.periods, totalPaidMinor: this.paidMinor };
  }

  private apply(action: SubscriptionAction): void {
    const rule = TRANSITIONS[this.current][action];
    if (!rule) throw new InvalidTransitionError(this.current, action);
    if (rule.effect === 'recordPayment') {
      this.periods += 1;
      this.paidMinor += this.options.planPriceMinor;
      this.failed = 0;
    } else if (rule.effect === 'recordFailure') {
      this.failed += 1;
    }
    const to = typeof rule.to === 'function' ? rule.to({ failedAttempts: this.failed, maxFailedAttempts: this.maxFailedAttempts }) : rule.to;
    // Self-loops (renewal, a retry that failed again) are not transitions, as in the class form.
    if (to !== this.current) {
      this.transitions.push({ from: this.current, to, action, at: this.now() });
      this.current = to;
    }
  }
}
