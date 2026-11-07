/**
 * MEMENTO
 * Capture an object's state in an opaque token so it can be restored later,
 * without the code that keeps the token (the caretaker) seeing the internals.
 *
 * Example domain: an invoice editor with save points, undo and draft-then-discard.
 * Amounts are integers in minor units (paise).
 */

export interface InvoiceLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
}

export type InvoiceStatus = 'DRAFT' | 'ISSUED';

/** The originator's internal state. Not exported: only the editor reads or writes it. */
interface InvoiceState {
  invoiceId: string;
  customer: string;
  lines: InvoiceLine[];
  discountMinor: number;
  notes: string;
  status: InvoiceStatus;
}

/** A read-only view for callers; a copy, so editing it cannot reach the editor. */
export type InvoiceView = Readonly<Omit<InvoiceState, 'lines'>> & { readonly lines: readonly InvoiceLine[]; readonly totalMinor: number };

/* ------------------------------------------------------------------------ */
/* The memento: a narrow interface outside, a wide one inside this module    */
/* ------------------------------------------------------------------------ */

/**
 * The caretaker sees a label and a timestamp, nothing else. The state lives in
 * a module-private WeakMap, so it is not reachable through the object at all
 * (not via `Object.keys`, not via a cast): this is TypeScript's version of the
 * C++ "friend" that GoF uses to give only the originator the wide interface.
 */
export class InvoiceMemento {
  private constructor(
    readonly label: string,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** @internal Only InvoiceEditor calls this. */
  static capture(label: string, createdAt: Date, state: InvoiceState): InvoiceMemento {
    const memento = new InvoiceMemento(label, new Date(createdAt.getTime()));
    snapshots.set(memento, deepFreeze(structuredClone(state)));
    return memento;
  }
}

const snapshots = new WeakMap<InvoiceMemento, Readonly<InvoiceState>>();

function readSnapshot(memento: InvoiceMemento): Readonly<InvoiceState> {
  const state = snapshots.get(memento);
  if (!state) throw new Error('Not a memento created by InvoiceEditor');
  return state;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/* ------------------------------------------------------------------------ */
/* The originator                                                            */
/* ------------------------------------------------------------------------ */

/** Serialised save points carry a version: the originator owns the format and its migrations. */
const FORMAT_VERSION = 1;

export class InvoiceEditor {
  private state: InvoiceState;

  constructor(
    invoiceId: string,
    customer: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = { invoiceId, customer, lines: [], discountMinor: 0, notes: '', status: 'DRAFT' };
  }

  addLine(line: InvoiceLine): this {
    this.assertEditable();
    if (!Number.isInteger(line.unitPriceMinor) || !Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error('Quantity and price must be positive integers (minor units)');
    }
    this.state.lines.push({ ...line });
    return this;
  }

  removeLine(index: number): this {
    this.assertEditable();
    this.state.lines.splice(index, 1);
    return this;
  }

  setCustomer(customer: string): this {
    this.assertEditable();
    this.state.customer = customer;
    return this;
  }

  setNotes(notes: string): this {
    this.assertEditable();
    this.state.notes = notes;
    return this;
  }

  applyDiscount(discountMinor: number): this {
    this.assertEditable();
    if (discountMinor < 0 || discountMinor > this.subtotalMinor()) throw new Error('Discount must be between 0 and the subtotal');
    this.state.discountMinor = discountMinor;
    return this;
  }

  issue(): this {
    this.assertEditable();
    if (this.state.lines.length === 0) throw new Error('Cannot issue an empty invoice');
    this.state.status = 'ISSUED';
    return this;
  }

  view(): InvoiceView {
    return { ...structuredClone(this.state), totalMinor: this.subtotalMinor() - this.state.discountMinor };
  }

  /** Create a memento. The snapshot is a deep, frozen copy: later edits cannot leak into it. */
  save(label: string): InvoiceMemento {
    return InvoiceMemento.capture(label, this.now(), this.state);
  }

  restore(memento: InvoiceMemento): this {
    const snapshot = readSnapshot(memento);
    if (snapshot.invoiceId !== this.state.invoiceId) throw new Error(`Save point belongs to invoice ${snapshot.invoiceId}`);
    // An issued invoice is a legal document: no save point may rewrite it.
    if (this.state.status === 'ISSUED') throw new Error('Cannot restore an issued invoice');
    this.state = structuredClone(snapshot) as InvoiceState; // thaw a private copy; the memento stays frozen
    return this;
  }

  /**
   * Serialisation is the originator's job, not the caretaker's: it knows the
   * fields, and it versions the format so an old autosave still loads after
   * InvoiceState gains a field.
   */
  exportMemento(memento: InvoiceMemento): string {
    return JSON.stringify({ v: FORMAT_VERSION, label: memento.label, createdAt: memento.createdAt.toISOString(), state: readSnapshot(memento) });
  }

  importMemento(json: string): InvoiceMemento {
    const parsed = JSON.parse(json) as { v?: unknown; label?: unknown; createdAt?: unknown; state?: unknown };
    if (parsed.v !== FORMAT_VERSION) throw new Error(`Unsupported save point version ${String(parsed.v)}`);
    if (typeof parsed.label !== 'string' || typeof parsed.createdAt !== 'string' || !isInvoiceState(parsed.state)) {
      throw new Error('Malformed save point');
    }
    return InvoiceMemento.capture(parsed.label, new Date(parsed.createdAt), parsed.state);
  }

  /** Idiomatic closure form: the memento is a function that puts the state back. */
  checkpoint(): () => void {
    const memento = this.save('checkpoint');
    return () => void this.restore(memento);
  }

  private subtotalMinor(): number {
    return this.state.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
  }

  private assertEditable(): void {
    if (this.state.status !== 'DRAFT') throw new Error('Invoice is issued and can no longer be edited');
  }
}

function isInvoiceState(value: unknown): value is InvoiceState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.invoiceId === 'string' &&
    typeof s.customer === 'string' &&
    typeof s.notes === 'string' &&
    Number.isInteger(s.discountMinor) &&
    (s.status === 'DRAFT' || s.status === 'ISSUED') &&
    Array.isArray(s.lines) &&
    s.lines.every(
      (l: unknown) =>
        !!l &&
        typeof l === 'object' &&
        typeof (l as InvoiceLine).description === 'string' &&
        Number.isInteger((l as InvoiceLine).quantity) &&
        Number.isInteger((l as InvoiceLine).unitPriceMinor),
    )
  );
}

/* ------------------------------------------------------------------------ */
/* The caretaker: keeps mementos, never looks inside them                    */
/* ------------------------------------------------------------------------ */

export interface Labelled {
  readonly label: string;
}

/**
 * Bounded history. Generic over the memento type, which proves it cannot
 * depend on what is inside: it would work unchanged for a pricing-rule editor.
 */
export class SaveHistory<M extends Labelled> {
  private readonly entries: M[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Capacity must be a positive integer');
  }

  push(memento: M): void {
    this.entries.push(memento);
    // Memory is bounded: the oldest save point is the one to lose.
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /** Remove and return the newest save point (undo). */
  pop(): M | undefined {
    return this.entries.pop();
  }

  peek(): M | undefined {
    return this.entries.at(-1);
  }

  /** Find a named save point, newest first. */
  find(label: string): M | undefined {
    return [...this.entries].reverse().find((m) => m.label === label);
  }

  get labels(): string[] {
    return this.entries.map((m) => m.label);
  }

  get size(): number {
    return this.entries.length;
  }
}

/** Ties an editor to its history: checkpoint before risky edits, undo to go back. */
export class InvoiceSession {
  readonly history: SaveHistory<InvoiceMemento>;

  constructor(
    readonly editor: InvoiceEditor,
    capacity = 20,
  ) {
    this.history = new SaveHistory<InvoiceMemento>(capacity);
  }

  checkpoint(label: string): void {
    this.history.push(this.editor.save(label));
  }

  /** Go back to the newest save point and drop it. Returns false when there is nothing to undo. */
  undo(): boolean {
    const memento = this.history.pop();
    if (!memento) return false;
    this.editor.restore(memento);
    return true;
  }

  restoreTo(label: string): void {
    const memento = this.history.find(label);
    if (!memento) throw new Error(`No save point "${label}"`);
    this.editor.restore(memento);
  }

  /**
   * Edit a draft, then keep or throw it away. Nothing is copied twice and
   * the caller never handles the memento.
   */
  beginDraft(): { commit(): void; discard(): void } {
    const before = this.editor.save('draft-start');
    let open = true;
    const close = () => {
      if (!open) throw new Error('Draft already closed');
      open = false;
    };
    return {
      commit: () => close(),
      discard: () => {
        close();
        this.editor.restore(before);
      },
    };
  }
}
