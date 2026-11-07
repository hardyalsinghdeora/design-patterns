import { describe, expect, it } from 'vitest';
import {
  Account,
  AccountBalancesProjection,
  AccountRepository,
  ConcurrencyError,
  DomainError,
  EventStore,
  SnapshotStore,
  parseRupees,
  replay,
  steppingClock,
  upcast,
  type PersistedAccountEvent,
} from './event-sourcing';

function setup(snapshotEvery = 50) {
  const clock = steppingClock();
  const store = new EventStore<PersistedAccountEvent>();
  const snapshots = new SnapshotStore();
  const repo = new AccountRepository(store, snapshots, clock, { snapshotEvery });
  const open = (id = 'acc-1') => {
    const account = Account.open(id, 'owner-1', clock);
    repo.save(account);
    return account;
  };
  return { clock, store, snapshots, repo, open };
}

describe('Account aggregate', () => {
  it('rebuilding from the stream yields exactly the live state', () => {
    const { repo, open } = setup();
    const live = open();
    live.deposit(1_000_00, 'd1');
    live.withdraw(300_00, 'w1');
    live.deposit(55_50, 'd2');
    repo.save(live);
    const rebuilt = repo.load('acc-1', { useSnapshots: false });
    expect(rebuilt.state).toEqual(live.state);
    expect(rebuilt.state.balanceMinor).toBe(755_50);
    expect(rebuilt.version).toBe(4);
  });

  it('enforces invariants when deciding, and records nothing on refusal', () => {
    const { repo, store, open } = setup();
    const account = open();
    expect(() => account.withdraw(1, 'w')).toThrow(/insufficient funds/);
    expect(() => account.deposit(10.5, 'd')).toThrow(DomainError);
    account.freeze('kyc review');
    expect(() => account.deposit(100, 'd')).toThrow(/frozen/);
    repo.save(account);
    expect(store.readStream('acc-1').map((r) => r.event.type)).toEqual(['AccountOpened', 'Frozen']);
  });
});

describe('EventStore', () => {
  it('rejects an append whose expectedVersion is stale, and the retry after reload succeeds', () => {
    const { repo, store, open } = setup();
    const a = open();
    a.deposit(1_000_00, 'd1');
    repo.save(a);
    const tab1 = repo.load('acc-1');
    const tab2 = repo.load('acc-1');
    tab1.withdraw(800_00, 'w1');
    repo.save(tab1);
    tab2.withdraw(800_00, 'w2');
    expect(() => repo.save(tab2)).toThrow(ConcurrencyError);
    expect(() => store.append('acc-1', 2, [])).toThrow(/expected version 2, actual 3/);

    const fresh = repo.load('acc-1');
    expect(() => fresh.withdraw(800_00, 'w2')).toThrow(/insufficient funds/); // the conflict prevented an overdraft
    fresh.withdraw(200_00, 'w2');
    expect(repo.save(fresh)).toBe(4);
    expect(store.readStream('acc-1').map((r) => r.version)).toEqual([1, 2, 3, 4]);
  });
});

describe('snapshots, upcasting and temporal queries', () => {
  it('snapshot plus tail equals a full replay, and replays fewer events', () => {
    const { repo, snapshots, open } = setup(3);
    const account = open();
    for (let i = 1; i <= 7; i++) {
      account.deposit(i * 100, `d${i}`);
      repo.save(account);
    }
    expect(snapshots.latest('acc-1')?.version).toBe(6);
    const fast = repo.load('acc-1');
    const full = repo.load('acc-1', { useSnapshots: false });
    expect(fast.state).toEqual(full.state);
    expect(fast.version).toBe(full.version);
    expect([fast.replayedEvents, full.replayedEvents]).toEqual([2, 8]);
  });

  it('upcasts a legacy event on read and never rewrites the stored one', () => {
    const { repo, store, clock, open } = setup();
    open();
    store.append('acc-1', 1, [{ type: 'Deposited', schemaVersion: 1, amount: '125.5', at: clock() }]);
    expect(repo.load('acc-1').state.balanceMinor).toBe(125_50);
    expect(store.readStream('acc-1')[1]?.event).toMatchObject({ schemaVersion: 1, amount: '125.5' });
    expect(upcast({ type: 'Deposited', schemaVersion: 1, amount: '7', at: 't' })).toMatchObject({ schemaVersion: 2, amountMinor: 700, reference: 'legacy-v1' });
    expect([parseRupees('0.05'), parseRupees('10.10')]).toEqual([5, 1010]);
    expect(() => upcast({ type: 'Deposited', schemaVersion: 1, amount: '1', at: 't' }, [])).toThrow(/no upcaster/);
  });

  it('answers temporal queries: balance as of version N, with or without a snapshot', () => {
    const { repo, open } = setup(2);
    const account = open();
    account.deposit(500_00, 'd1');
    account.withdraw(200_00, 'w1');
    account.deposit(1_000_00, 'd2');
    repo.save(account);
    account.withdraw(100_00, 'w2');
    repo.save(account);
    const balances = [1, 2, 3, 4, 5].map((v) => repo.stateAsOf('acc-1', v).balanceMinor);
    expect(balances).toEqual([0, 500_00, 300_00, 1_300_00, 1_200_00]);
    expect(repo.stateAsOf('acc-1', 5)).toEqual(repo.load('acc-1').state);
  });

  it('projects all streams into a read model that agrees with replay', () => {
    const { repo, store, clock, open } = setup();
    const a = open('acc-a');
    a.deposit(400_00, 'd');
    a.freeze('chargeback');
    repo.save(a);
    const b = open('acc-b');
    b.deposit(250_00, 'd');
    b.withdraw(50_00, 'w');
    repo.save(b);
    store.append('acc-b', 3, [{ type: 'Deposited', schemaVersion: 1, amount: '1.25', at: clock() }]);

    const projection = new AccountBalancesProjection(store);
    expect(projection.catchUp()).toBe(7);
    expect(projection.totalHeldMinor()).toBe(400_00 + 200_00 + 1_25);
    expect(projection.frozenAccounts()).toEqual(['acc-a']);
    const replayed = replay(store.readStream('acc-b').map((r) => upcast(r.event)));
    expect(projection.row('acc-b')?.balanceMinor).toBe(replayed.balanceMinor);
    expect(projection.catchUp()).toBe(0);
  });
});
