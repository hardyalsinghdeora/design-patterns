/**
 * COMMAND
 * Turn a request into an object with execute() and undo(), so it can be
 * recorded, undone, redone, grouped into a macro, queued or sent as data.
 *
 * Example domain: editing a draft order (items, quantities, coupon) with an
 * undo/redo history, and replaying serialised edits like jobs from a queue.
 * Amounts are integers in minor units (paise).
 */

export interface OrderLine {
  readonly sku: string;
  readonly unitPriceMinor: number;
  readonly quantity: number;
}

export interface Coupon {
  readonly code: string;
  readonly percentOff: number;
  /** The coupon only applies once the subtotal reaches this amount. */
  readonly minSubtotalMinor: number;
}

/** A plain, comparable picture of the order, for tests and display. */
export interface OrderView {
  readonly lines: OrderLine[];
  readonly coupon: string | null;
  readonly note: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
}

const isQuantity = (n: number): boolean => Number.isInteger(n) && n >= 1;

/**
 * The receiver. It knows how to change an order and enforces the business
 * rules; it knows nothing about undo, history or queues.
 */
export class Order {
  private readonly lines = new Map<string, OrderLine>();
  private coupon: Coupon | undefined;
  note = '';

  constructor(readonly id: string) {}

  line(sku: string): OrderLine | undefined {
    return this.lines.get(sku);
  }

  get appliedCoupon(): Coupon | undefined {
    return this.coupon;
  }

  addItem(sku: string, unitPriceMinor: number, quantity: number): void {
    if (!isQuantity(quantity)) throw new Error(`Quantity must be a positive integer, got ${quantity}`);
    const existing = this.lines.get(sku);
    this.lines.set(sku, { sku, unitPriceMinor, quantity: (existing?.quantity ?? 0) + quantity });
  }

  removeItem(sku: string): void {
    if (!this.lines.delete(sku)) throw new Error(`No line for ${sku}`);
  }

  changeQuantity(sku: string, quantity: number): void {
    const existing = this.lines.get(sku);
    if (!existing) throw new Error(`No line for ${sku}`);
    if (!isQuantity(quantity)) throw new Error(`Quantity must be a positive integer, got ${quantity}`);
    this.lines.set(sku, { ...existing, quantity });
  }

  applyCoupon(coupon: Coupon): void {
    if (this.subtotalMinor() < coupon.minSubtotalMinor) {
      throw new Error(`${coupon.code} needs a subtotal of at least ${coupon.minSubtotalMinor}`);
    }
    this.coupon = coupon;
  }

  /** Undo support: put a line (or its absence) back exactly as it was. */
  restoreLine(sku: string, line: OrderLine | undefined): void {
    if (line) this.lines.set(sku, line);
    else this.lines.delete(sku);
  }

  restoreCoupon(coupon: Coupon | undefined): void {
    this.coupon = coupon;
  }

  subtotalMinor(): number {
    let subtotal = 0;
    for (const line of this.lines.values()) subtotal += line.unitPriceMinor * line.quantity;
    return subtotal;
  }

  view(): OrderView {
    const subtotalMinor = this.subtotalMinor();
    // The coupon stays attached but stops discounting if the subtotal drops below its minimum.
    const active = this.coupon && subtotalMinor >= this.coupon.minSubtotalMinor ? this.coupon : undefined;
    const discountMinor = active ? Math.round((subtotalMinor * active.percentOff) / 100) : 0;
    return {
      // Sorted, because undo re-inserts lines and Map order would otherwise change.
      lines: [...this.lines.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
      coupon: this.coupon?.code ?? null,
      note: this.note,
      subtotalMinor,
      discountMinor,
      totalMinor: subtotalMinor - discountMinor,
    };
  }
}

/** The command interface the invoker depends on: do it, and undo it. */
export interface Command {
  readonly label: string;
  execute(): void;
  undo(): void;
}

/** The serialised form: what goes into a job queue, an audit log or a WebSocket message. */
export type CommandData =
  | { readonly type: 'add-item'; readonly sku: string; readonly unitPriceMinor: number; readonly quantity: number }
  | { readonly type: 'remove-item'; readonly sku: string }
  | { readonly type: 'change-quantity'; readonly sku: string; readonly quantity: number }
  | { readonly type: 'apply-coupon'; readonly coupon: Coupon }
  | { readonly type: 'macro'; readonly label: string; readonly steps: readonly CommandData[] };

/** Order commands can also travel as data. `toJSON` is the hook JSON.stringify calls. */
export interface OrderCommand extends Command {
  toJSON(): CommandData;
}

export class AddItemCommand implements OrderCommand {
  private before: OrderLine | undefined;

  constructor(
    private readonly order: Order,
    private readonly sku: string,
    private readonly unitPriceMinor: number,
    private readonly quantity: number,
  ) {}

  get label(): string {
    return `add ${this.quantity} x ${this.sku}`;
  }

  execute(): void {
    this.before = this.order.line(this.sku); // the state undo needs, captured when it runs
    this.order.addItem(this.sku, this.unitPriceMinor, this.quantity);
  }

  undo(): void {
    this.order.restoreLine(this.sku, this.before);
  }

  toJSON(): CommandData {
    return { type: 'add-item', sku: this.sku, unitPriceMinor: this.unitPriceMinor, quantity: this.quantity };
  }
}

export class RemoveItemCommand implements OrderCommand {
  private before: OrderLine | undefined;

  constructor(private readonly order: Order, private readonly sku: string) {}

  get label(): string {
    return `remove ${this.sku}`;
  }

  execute(): void {
    this.before = this.order.line(this.sku);
    this.order.removeItem(this.sku);
  }

  undo(): void {
    this.order.restoreLine(this.sku, this.before);
  }

  toJSON(): CommandData {
    return { type: 'remove-item', sku: this.sku };
  }
}

export class ChangeQuantityCommand implements OrderCommand {
  private before: OrderLine | undefined;

  constructor(
    private readonly order: Order,
    private readonly sku: string,
    private readonly quantity: number,
  ) {}

  get label(): string {
    return `set ${this.sku} quantity to ${this.quantity}`;
  }

  execute(): void {
    this.before = this.order.line(this.sku);
    this.order.changeQuantity(this.sku, this.quantity);
  }

  undo(): void {
    this.order.restoreLine(this.sku, this.before);
  }

  toJSON(): CommandData {
    return { type: 'change-quantity', sku: this.sku, quantity: this.quantity };
  }
}

export class ApplyCouponCommand implements OrderCommand {
  private before: Coupon | undefined;

  constructor(private readonly order: Order, private readonly coupon: Coupon) {}

  get label(): string {
    return `apply coupon ${this.coupon.code}`;
  }

  execute(): void {
    this.before = this.order.appliedCoupon;
    this.order.applyCoupon(this.coupon);
  }

  undo(): void {
    this.order.restoreCoupon(this.before);
  }

  toJSON(): CommandData {
    return { type: 'apply-coupon', coupon: this.coupon };
  }
}

/** A command made of commands: every step succeeds, or the steps that ran are undone. */
export class MacroCommand implements OrderCommand {
  constructor(readonly label: string, private readonly steps: readonly OrderCommand[]) {}

  execute(): void {
    const done: OrderCommand[] = [];
    try {
      for (const step of this.steps) {
        step.execute();
        done.push(step);
      }
    } catch (error) {
      for (const step of done.reverse()) step.undo(); // roll back newest first, then report
      throw error;
    }
  }

  undo(): void {
    for (const step of [...this.steps].reverse()) step.undo();
  }

  toJSON(): CommandData {
    return { type: 'macro', label: this.label, steps: this.steps.map((step) => step.toJSON()) };
  }
}

/**
 * The invoker. It runs commands and keeps two stacks. It has no idea what an
 * order is, so the same class can drive undo for invoices, carts or documents.
 */
export class CommandHistory {
  private readonly done: Command[] = [];
  private undone: Command[] = [];

  run(command: Command): void {
    command.execute(); // if this throws, nothing is recorded
    this.done.push(command);
    this.undone = []; // a new edit makes the old redo branch meaningless
  }

  undo(): Command | undefined {
    const command = this.done.pop();
    if (!command) return undefined;
    command.undo();
    this.undone.push(command);
    return command;
  }

  redo(): Command | undefined {
    const command = this.undone.pop();
    if (!command) return undefined;
    command.execute();
    this.done.push(command);
    return command;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get labels(): string[] {
    return this.done.map((command) => command.label);
  }
}

/* ------------------------------------------------------------------------ */
/* Deferred execution: commands as data. A queue (SQS, BullMQ, an outbox     */
/* table) stores plain JSON; a worker rebuilds the commands and replays them. */
/* ------------------------------------------------------------------------ */

/** Rebuild a command from its data and bind it to a receiver. The only switch on `type` lives here. */
export function commandFromData(data: CommandData, order: Order): OrderCommand {
  switch (data.type) {
    case 'add-item':
      return new AddItemCommand(order, data.sku, data.unitPriceMinor, data.quantity);
    case 'remove-item':
      return new RemoveItemCommand(order, data.sku);
    case 'change-quantity':
      return new ChangeQuantityCommand(order, data.sku, data.quantity);
    case 'apply-coupon':
      return new ApplyCouponCommand(order, data.coupon);
    case 'macro':
      return new MacroCommand(data.label, data.steps.map((step) => commandFromData(step, order)));
    default: {
      const unknown: never = data; // compile error here if a command type is added but not handled
      throw new Error(`Unknown command ${JSON.stringify(unknown)}`);
    }
  }
}

/** Queue payloads are untrusted input. Real code validates every field with a schema; this checks the shape. */
export function parseCommand(json: string): CommandData {
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'object' || value === null || !('type' in value) || typeof value.type !== 'string') {
    throw new Error(`Not a command payload: ${json}`);
  }
  return value as CommandData;
}

export interface DrainReport {
  readonly applied: number;
  /** Poison messages, parked with the reason instead of blocking the rest of the queue. */
  readonly deadLetters: ReadonlyArray<{ readonly payload: string; readonly error: string }>;
}

/** Enqueue now, execute later: in another process, after a retry, or when a device comes back online. */
export class CommandQueue {
  private readonly payloads: string[] = [];

  enqueue(command: OrderCommand): void {
    this.payloads.push(JSON.stringify(command)); // calls command.toJSON()
  }

  get pending(): readonly string[] {
    return this.payloads;
  }

  /** Replay every queued command, in order, against a receiver and through a history. */
  drain(order: Order, history: CommandHistory): DrainReport {
    let applied = 0;
    const deadLetters: Array<{ payload: string; error: string }> = [];
    for (const payload of this.payloads.splice(0)) {
      try {
        history.run(commandFromData(parseCommand(payload), order));
        applied += 1;
      } catch (error) {
        deadLetters.push({ payload, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { applied, deadLetters };
  }
}

/* ------------------------------------------------------------------------ */
/* Functional form: a command is a function plus its inverse, held in a      */
/* closure. Cheap, but not serialisable: in-process undo, never a queue.     */
/* ------------------------------------------------------------------------ */

/** "Do returns undo": the action makes the change and hands back a closure that reverts it. */
export function reversible(label: string, action: () => () => void): Command {
  let revert: (() => void) | undefined;
  return {
    label,
    execute: () => {
      revert = action();
    },
    undo: () => {
      revert?.();
      revert = undefined;
    },
  };
}

export const setNote = (order: Order, note: string): Command =>
  reversible(`note "${note}"`, () => {
    const previous = order.note;
    order.note = note;
    return () => {
      order.note = previous;
    };
  });
