/**
 * EVENT SOURCING
 * Store every change to an aggregate as an immutable event in an append-only stream, and derive
 * current state (or state at any past version) by replaying those events.
 *
 * Example domain: a wallet account (AccountOpened, Deposited, Withdrawn, Frozen) with optimistic
 * concurrency, snapshots, an upcaster for a legacy event shape, a projection and temporal queries.
 * Amounts are integers in minor units (paise).
 */

export type Clock = () => string;

/* ------------------------------------------------------------------------ */
/* Events: the source of truth. Past tense, immutable, carry all their data. */
/* ------------------------------------------------------------------------ */

export type AccountEvent =
  | { type: 'AccountOpened'; accountId: string; ownerId: string; at: string }
  | { type: 'Deposited'; schemaVersion: 2; amountMinor: number; reference: string; at: string }
  | { type: 'Withdrawn'; amountMinor: number; reference: string; at: string }
  | { type: 'Frozen'; reason: string; at: string };

/** The 2023 shape still sitting in old streams: a decimal rupee string and no reference. */
export interface DepositedV1 {
  type: 'Deposited';
  schemaVersion: 1;
  amount: string;
  at: string;
}

/** What the store may contain. Old events are never rewritten; they are upcast on read. */
export type PersistedAccountEvent = AccountEvent | DepositedV1;

/* ------------------------------------------------------------------------ */
/* The event store: append-only streams with optimistic concurrency.         */
/* ------------------------------------------------------------------------ */

export interface RecordedEvent<E> {
  readonly streamId: string;
  readonly version: number; // 1-based position within the stream
  readonly globalPosition: number; // position across all streams, for projections
  readonly event: E;
}

export class ConcurrencyError extends Error {
  constructor(readonly streamId: string, readonly expectedVersion: number, readonly actualVersion: number) {
    super(`stream ${streamId}: expected version ${expectedVersion}, actual ${actualVersion}`);
  }
}

export class EventStore<E> {
  private readonly streams = new Map<string, RecordedEvent<E>[]>();
  private readonly all: RecordedEvent<E>[] = [];

  version(streamId: string): number {
    return this.streams.get(streamId)?.length ?? 0;
  }

  /**
   * Append only if nobody else wrote since the caller read the stream. A real store does this
   * check and the insert atomically (a unique index on stream id + version).
   */
  append(streamId: string, expectedVersion: number, events: readonly E[]): number {
    const actual = this.version(streamId);
    if (actual !== expectedVersion) throw new ConcurrencyError(streamId, expectedVersion, actual);
    const stream = this.streams.get(streamId) ?? [];
    for (const event of events) {
      const record = Object.freeze({ streamId, version: stream.length + 1, globalPosition: this.all.length + 1, event });
      stream.push(record);
      this.all.push(record);
    }
    this.streams.set(streamId, stream);
    return stream.length;
  }

  readStream(streamId: string, fromVersion = 1, toVersion = Number.POSITIVE_INFINITY): RecordedEvent<E>[] {
    return (this.streams.get(streamId) ?? []).filter((r) => r.version >= fromVersion && r.version <= toVersion);
  }

  readAll(afterPosition = 0): RecordedEvent<E>[] {
    return this.all.slice(afterPosition);
  }
}

/* ------------------------------------------------------------------------ */
/* Upcasting: migrate old event versions on the way out of the store.        */
/* ------------------------------------------------------------------------ */

export type Upcaster = (event: PersistedAccountEvent) => PersistedAccountEvent;

const isLegacy = (e: PersistedAccountEvent): e is DepositedV1 => e.type === 'Deposited' && e.schemaVersion === 1;

/** "125.5" -> 12550 without ever touching a float. */
export function parseRupees(amount: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) throw new Error(`unparseable legacy amount "${amount}"`);
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export const depositedV1ToV2: Upcaster = (e) =>
  isLegacy(e) ? { type: 'Deposited', schemaVersion: 2, amountMinor: parseRupees(e.amount), reference: 'legacy-v1', at: e.at } : e;

export const defaultUpcasters: readonly Upcaster[] = [depositedV1ToV2];

export function upcast(event: PersistedAccountEvent, upcasters: readonly Upcaster[] = defaultUpcasters): AccountEvent {
  const result = upcasters.reduce((e, u) => u(e), event);
  if (isLegacy(result)) throw new Error('no upcaster for Deposited v1');
  return result;
}

/* ------------------------------------------------------------------------ */
/* State is a left fold over events. evolve is a pure reducer: the idiomatic  */
/* TypeScript core that the Account class below wraps.                       */
/* ------------------------------------------------------------------------ */

export type AccountStatus = 'NEW' | 'OPEN' | 'FROZEN';

export interface AccountState {
  accountId: string;
  ownerId: string;
  status: AccountStatus;
  balanceMinor: number;
}

export const initialState: AccountState = { accountId: '', ownerId: '', status: 'NEW', balanceMinor: 0 };

/** No validation here: events are facts that already happened, so applying one never fails. */
export function evolve(state: AccountState, event: AccountEvent): AccountState {
  switch (event.type) {
    case 'AccountOpened':
      return { ...state, accountId: event.accountId, ownerId: event.ownerId, status: 'OPEN' };
    case 'Deposited':
      return { ...state, balanceMinor: state.balanceMinor + event.amountMinor };
    case 'Withdrawn':
      return { ...state, balanceMinor: state.balanceMinor - event.amountMinor };
    case 'Frozen':
      return { ...state, status: 'FROZEN' };
  }
}

export const replay = (events: readonly AccountEvent[], from: AccountState = initialState): AccountState =>
  events.reduce(evolve, from);

export class DomainError extends Error {}

/** The aggregate: decides (validates commands) and records the resulting events. */
export class Account {
  private pending: AccountEvent[] = [];

  private constructor(
    private current: AccountState,
    private persistedVersion: number,
    /** How many events were replayed to build this instance: shows what a snapshot saves. */
    readonly replayedEvents: number,
    private readonly clock: Clock,
  ) {}

  static open(accountId: string, ownerId: string, clock: Clock): Account {
    const account = new Account(initialState, 0, 0, clock);
    account.raise({ type: 'AccountOpened', accountId, ownerId, at: clock() });
    return account;
  }

  static rehydrate(history: readonly AccountEvent[], clock: Clock, snapshot?: Snapshot): Account {
    const base = snapshot?.state ?? initialState;
    return new Account(replay(history, base), (snapshot?.version ?? 0) + history.length, history.length, clock);
  }

  get id(): string {
    return this.current.accountId;
  }
  get state(): AccountState {
    return { ...this.current };
  }
  /** The stream version this instance was loaded at: the expectedVersion for the next append. */
  get version(): number {
    return this.persistedVersion;
  }
  get uncommitted(): readonly AccountEvent[] {
    return this.pending;
  }

  deposit(amountMinor: number, reference: string): void {
    this.assertActive();
    assertAmount(amountMinor);
    this.raise({ type: 'Deposited', schemaVersion: 2, amountMinor, reference, at: this.clock() });
  }

  withdraw(amountMinor: number, reference: string): void {
    this.assertActive();
    assertAmount(amountMinor);
    if (amountMinor > this.current.balanceMinor) {
      throw new DomainError(`insufficient funds: balance ${this.current.balanceMinor}, requested ${amountMinor}`);
    }
    this.raise({ type: 'Withdrawn', amountMinor, reference, at: this.clock() });
  }

  freeze(reason: string): void {
    this.assertActive();
    this.raise({ type: 'Frozen', reason, at: this.clock() });
  }

  markCommitted(newVersion: number): void {
    this.pending = [];
    this.persistedVersion = newVersion;
  }

  private assertActive(): void {
    if (this.current.status === 'NEW') throw new DomainError('account is not open');
    if (this.current.status === 'FROZEN') throw new DomainError(`account ${this.id} is frozen`);
  }

  private raise(event: AccountEvent): void {
    this.current = evolve(this.current, event); // the same reducer used for replay: one code path
    this.pending.push(event);
  }
}

function assertAmount(amountMinor: number): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new DomainError('amount must be a positive integer in minor units');
}

/* ------------------------------------------------------------------------ */
/* Snapshots and the repository.                                             */
/* ------------------------------------------------------------------------ */

export interface Snapshot {
  streamId: string;
  version: number;
  state: AccountState;
}

/** Snapshots are a cache: deleting them all must change nothing except load time. */
export class SnapshotStore {
  private readonly latestByStream = new Map<string, Snapshot>();

  save(snapshot: Snapshot): void {
    this.latestByStream.set(snapshot.streamId, structuredClone(snapshot));
  }

  latest(streamId: string): Snapshot | undefined {
    const s = this.latestByStream.get(streamId);
    return s ? structuredClone(s) : undefined;
  }
}

export interface RepositoryOptions {
  snapshotEvery?: number;
  upcasters?: readonly Upcaster[];
}

export class AccountRepository {
  private readonly snapshotEvery: number;
  private readonly upcasters: readonly Upcaster[];

  constructor(
    private readonly store: EventStore<PersistedAccountEvent>,
    private readonly snapshots: SnapshotStore,
    private readonly clock: Clock,
    options: RepositoryOptions = {},
  ) {
    this.snapshotEvery = options.snapshotEvery ?? 50;
    this.upcasters = options.upcasters ?? defaultUpcasters;
  }

  save(account: Account): number {
    const from = account.version;
    if (account.uncommitted.length === 0) return from;
    const to = this.store.append(account.id, from, account.uncommitted); // throws ConcurrencyError
    account.markCommitted(to);
    if (Math.floor(to / this.snapshotEvery) > Math.floor(from / this.snapshotEvery)) {
      this.snapshots.save({ streamId: account.id, version: to, state: account.state });
    }
    return to;
  }

  load(accountId: string, { useSnapshots = true } = {}): Account {
    const snapshot = useSnapshots ? this.snapshots.latest(accountId) : undefined;
    const tail = this.read(accountId, (snapshot?.version ?? 0) + 1);
    if (!snapshot && tail.length === 0) throw new DomainError(`account ${accountId} not found`);
    return Account.rehydrate(tail, this.clock, snapshot);
  }

  /** Temporal query: what did the account look like right after event N? */
  stateAsOf(accountId: string, version: number): AccountState {
    const snapshot = this.snapshots.latest(accountId);
    const base = snapshot && snapshot.version <= version ? snapshot : undefined;
    return replay(this.read(accountId, (base?.version ?? 0) + 1, version), base?.state ?? initialState);
  }

  private read(accountId: string, fromVersion: number, toVersion?: number): AccountEvent[] {
    return this.store.readStream(accountId, fromVersion, toVersion).map((r) => upcast(r.event, this.upcasters));
  }
}

/* ------------------------------------------------------------------------ */
/* A projection: a read model built from the global event feed.              */
/* ------------------------------------------------------------------------ */

export interface BalanceRow {
  accountId: string;
  ownerId: string;
  balanceMinor: number;
  frozen: boolean;
}

export class AccountBalancesProjection {
  private checkpoint = 0;
  private readonly rows = new Map<string, BalanceRow>();

  constructor(
    private readonly store: EventStore<PersistedAccountEvent>,
    private readonly upcasters: readonly Upcaster[] = defaultUpcasters,
  ) {}

  catchUp(): number {
    const batch = this.store.readAll(this.checkpoint);
    for (const record of batch) {
      this.apply(record.streamId, upcast(record.event, this.upcasters));
      this.checkpoint = record.globalPosition;
    }
    return batch.length;
  }

  private apply(accountId: string, event: AccountEvent): void {
    if (event.type === 'AccountOpened') {
      this.rows.set(accountId, { accountId, ownerId: event.ownerId, balanceMinor: 0, frozen: false });
      return;
    }
    const row = this.rows.get(accountId);
    if (!row) return;
    if (event.type === 'Deposited') row.balanceMinor += event.amountMinor;
    else if (event.type === 'Withdrawn') row.balanceMinor -= event.amountMinor;
    else row.frozen = true;
  }

  row(accountId: string): BalanceRow | undefined {
    const r = this.rows.get(accountId);
    return r ? { ...r } : undefined;
  }

  totalHeldMinor(): number {
    let total = 0;
    for (const r of this.rows.values()) total += r.balanceMinor;
    return total;
  }

  frozenAccounts(): string[] {
    return [...this.rows.values()].filter((r) => r.frozen).map((r) => r.accountId).sort();
  }
}

/** A fixed, ticking clock for demos and tests. */
export function steppingClock(startIso = '2026-03-01T09:00:00.000Z', stepMs = 60_000): Clock {
  let t = Date.parse(startIso) - stepMs;
  return () => new Date((t += stepMs)).toISOString();
}
