import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  Subscription,
  type SubscriptionAction,
  type SubscriptionMachine,
  type SubscriptionOptions,
  TableDrivenSubscription,
  allowedActions,
} from './state';

const options = (): SubscriptionOptions => {
  let tick = Date.parse('2026-01-01T00:00:00Z');
  return { planPriceMinor: 99_900, maxFailedAttempts: 3, now: () => new Date((tick += 86_400_000)) };
};

const implementations: Array<[string, (opts: SubscriptionOptions) => SubscriptionMachine]> = [
  ['State classes', (o) => new Subscription('sub_1', o)],
  ['Transition table', (o) => new TableDrivenSubscription('sub_1', o)],
];

function run(machine: SubscriptionMachine, actions: SubscriptionAction[]): void {
  for (const action of actions) machine[action]();
}

describe.each(implementations)('%s', (_name, create) => {
  it('walks the full lifecycle', () => {
    const sub = create(options());
    run(sub, ['pay', 'pay', 'pause', 'resume', 'fail', 'pay', 'cancel']);
    expect(sub.history.map((t) => `${t.from}-${t.action}->${t.to}`)).toEqual([
      'TRIALING-pay->ACTIVE',
      'ACTIVE-pause->PAUSED',
      'PAUSED-resume->ACTIVE',
      'ACTIVE-fail->PAST_DUE',
      'PAST_DUE-pay->ACTIVE',
      'ACTIVE-cancel->CANCELLED',
    ]);
    expect(sub.snapshot()).toEqual({ status: 'CANCELLED', failedAttempts: 0, periodsPaid: 3, totalPaidMinor: 2_99_700 });
    expect(sub.history[0]?.at.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('cancels after the dunning limit, and a payment in between resets the count', () => {
    const sub = create(options());
    run(sub, ['pay', 'fail', 'fail', 'pay', 'fail', 'fail']);
    expect(sub.snapshot()).toMatchObject({ status: 'PAST_DUE', failedAttempts: 2 });
    sub.fail();
    expect(sub.status).toBe('CANCELLED');
  });

  it('rejects invalid actions with InvalidTransitionError and changes nothing', () => {
    const cases: Array<[SubscriptionAction[], SubscriptionAction]> = [
      [[], 'pause'],
      [[], 'resume'],
      [['pay'], 'resume'],
      [['pay', 'pause'], 'pay'],
      [['pay', 'pause'], 'fail'],
      [['pay', 'fail'], 'pause'],
      [['cancel'], 'pay'],
      [['cancel'], 'cancel'],
    ];
    for (const [setup, action] of cases) {
      const sub = create(options());
      run(sub, setup);
      const before = sub.snapshot();
      expect(() => sub[action](), `${setup.join(',')} then ${action}`).toThrow(InvalidTransitionError);
      expect(sub.snapshot()).toEqual(before);
    }
  });
});

describe('both implementations agree', () => {
  it('on a scripted sequence that includes invalid actions', () => {
    const script: SubscriptionAction[] = ['resume', 'fail', 'pay', 'pay', 'pause', 'pay', 'resume', 'fail', 'fail', 'pause', 'pay', 'fail', 'fail', 'fail', 'resume', 'cancel'];
    const outcome = (machine: SubscriptionMachine) =>
      script.map((action) => {
        try {
          machine[action]();
          return `${action}:${machine.status}`;
        } catch (error) {
          return `${action}:rejected(${(error as InvalidTransitionError).status})`;
        }
      });
    const classic = new Subscription('a', options());
    const table = new TableDrivenSubscription('b', options());
    expect(outcome(classic)).toEqual(outcome(table));
    expect(classic.snapshot()).toEqual(table.snapshot());
    expect(classic.history).toEqual(table.history);
    expect(classic.status).toBe('CANCELLED');
  });
});

describe('transition table', () => {
  it('answers which actions are allowed in each state', () => {
    expect(allowedActions('PAUSED')).toEqual(['resume', 'cancel']);
    expect(allowedActions('CANCELLED')).toEqual([]);
  });

  it('state objects are shared but subscriptions stay independent', () => {
    const a = new Subscription('a', options());
    const b = new Subscription('b', options());
    a.pay();
    a.pause();
    expect(b.status).toBe('TRIALING');
    expect(a.status).toBe('PAUSED');
  });
});
