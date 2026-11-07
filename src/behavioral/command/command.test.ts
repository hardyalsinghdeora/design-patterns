import { describe, expect, it } from 'vitest';
import {
  AddItemCommand,
  ApplyCouponCommand,
  ChangeQuantityCommand,
  CommandHistory,
  CommandQueue,
  MacroCommand,
  Order,
  RemoveItemCommand,
  commandFromData,
  parseCommand,
  setNote,
  type Coupon,
} from './command';

const FESTIVE10: Coupon = { code: 'FESTIVE10', percentOff: 10, minSubtotalMinor: 1_000 * 100 };
const BIG20: Coupon = { code: 'BIG20', percentOff: 20, minSubtotalMinor: 5_000 * 100 };

/** 2 x TEA-250G at Rs 349 = Rs 698, below the FESTIVE10 minimum. */
function teaOrder(): Order {
  const order = new Order('ord_1');
  order.addItem('TEA-250G', 34_900, 2);
  return order;
}

const festiveBundle = (order: Order) =>
  new MacroCommand('festive bundle', [
    new AddItemCommand(order, 'MUG', 29_900, 1),
    new ChangeQuantityCommand(order, 'TEA-250G', 3),
    new ApplyCouponCommand(order, FESTIVE10),
  ]);

describe('commands and the undo/redo invoker', () => {
  it('undo restores the exact previous state and redo re-applies it, for every command type', () => {
    const order = teaOrder();
    const history = new CommandHistory();
    const commands = [
      new AddItemCommand(order, 'MUG', 29_900, 1),
      new ChangeQuantityCommand(order, 'TEA-250G', 5),
      new ApplyCouponCommand(order, FESTIVE10),
      new RemoveItemCommand(order, 'MUG'),
    ];
    for (const command of commands) {
      const before = order.view();
      history.run(command);
      const after = order.view();
      expect(after).not.toEqual(before);

      history.undo();
      expect(order.view()).toEqual(before);
      history.redo();
      expect(order.view()).toEqual(after);
    }
    expect(order.view()).toMatchObject({ subtotalMinor: 1_74_500, discountMinor: 17_450, totalMinor: 1_57_050 });
  });

  it('walks all the way back to the start and forward to the end', () => {
    const order = teaOrder();
    const history = new CommandHistory();
    const start = order.view();
    history.run(new AddItemCommand(order, 'TEA-250G', 34_900, 1)); // merges into the existing line
    history.run(new AddItemCommand(order, 'KETTLE', 1_49_900, 1));
    history.run(new ApplyCouponCommand(order, FESTIVE10));
    history.run(setNote(order, 'Leave at the security desk'));
    const end = order.view();

    while (history.canUndo) history.undo();
    expect(order.view()).toEqual(start);
    while (history.canRedo) history.redo();
    expect(order.view()).toEqual(end);
  });

  it('clears the redo stack when a new command runs after an undo', () => {
    const order = teaOrder();
    const history = new CommandHistory();
    history.run(new AddItemCommand(order, 'MUG', 29_900, 1));
    history.undo();
    expect(history.canRedo).toBe(true);

    history.run(new ChangeQuantityCommand(order, 'TEA-250G', 3));
    expect(history.canRedo).toBe(false);
    expect(history.redo()).toBeUndefined();
    expect(history.labels).toEqual(['set TEA-250G quantity to 3']);
    expect(order.line('MUG')).toBeUndefined();
  });

  it('does not record a command that fails', () => {
    const order = teaOrder();
    const history = new CommandHistory();
    const before = order.view();
    expect(() => history.run(new ApplyCouponCommand(order, FESTIVE10))).toThrow(/needs a subtotal/);
    expect(order.view()).toEqual(before);
    expect(history.canUndo).toBe(false);
  });
});

describe('MacroCommand', () => {
  it('is atomic: when a step fails, the steps that already ran are rolled back', () => {
    const order = teaOrder();
    const history = new CommandHistory();
    const before = order.view();
    const greedy = new MacroCommand('upsell', [
      new AddItemCommand(order, 'MUG', 29_900, 2),
      new ChangeQuantityCommand(order, 'TEA-250G', 4),
      new ApplyCouponCommand(order, BIG20), // Rs 1,994 is below the Rs 5,000 minimum
    ]);

    expect(() => history.run(greedy)).toThrow(/BIG20/);
    expect(order.view()).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('is undone and redone as a single step when it succeeds', () => {
    const order = teaOrder();
    const history = new CommandHistory();
    const before = order.view();
    history.run(festiveBundle(order));
    const after = order.view();
    expect(after).toMatchObject({ subtotalMinor: 1_34_600, discountMinor: 13_460, coupon: 'FESTIVE10' });

    history.undo();
    expect(order.view()).toEqual(before);
    expect(history.labels).toEqual([]);
    history.redo();
    expect(order.view()).toEqual(after);
  });
});

describe('commands as data', () => {
  it('survives a JSON round trip and has the same effect on another order', () => {
    const live = teaOrder();
    const original = festiveBundle(live);
    original.execute();

    const json = JSON.stringify(original);
    const replica = teaOrder();
    const rebuilt = commandFromData(parseCommand(json), replica);
    rebuilt.execute();

    expect(rebuilt.toJSON()).toEqual(original.toJSON());
    expect(replica.view()).toEqual(live.view());
    rebuilt.undo();
    expect(replica.view()).toEqual(teaOrder().view());
  });

  it('defers execution: queued commands replay later, and a poison message does not block the rest', () => {
    const order = teaOrder();
    const queue = new CommandQueue();
    queue.enqueue(new AddItemCommand(order, 'MUG', 29_900, 1));
    queue.enqueue(new RemoveItemCommand(order, 'KETTLE')); // fails on replay: there is no kettle
    queue.enqueue(new ChangeQuantityCommand(order, 'TEA-250G', 3));

    expect(order.view()).toEqual(teaOrder().view()); // nothing has run yet
    expect(JSON.parse(queue.pending[0])).toEqual({ type: 'add-item', sku: 'MUG', unitPriceMinor: 29_900, quantity: 1 });

    const history = new CommandHistory();
    const report = queue.drain(order, history);
    expect(report.applied).toBe(2);
    expect(report.deadLetters).toEqual([{ payload: '{"type":"remove-item","sku":"KETTLE"}', error: 'No line for KETTLE' }]);
    expect(history.labels).toEqual(['add 1 x MUG', 'set TEA-250G quantity to 3']);
    expect(queue.pending).toHaveLength(0);
  });

  it('accepts closures as lightweight commands, which undo fine but cannot be serialised', () => {
    const order = teaOrder();
    const history = new CommandHistory();
    history.run(setNote(order, 'Leave at the security desk'));
    history.run(setNote(order, 'Call before delivery'));
    expect(order.note).toBe('Call before delivery');

    history.undo();
    expect(order.note).toBe('Leave at the security desk');
    history.undo();
    expect(order.note).toBe('');
    history.redo();
    expect(order.note).toBe('Leave at the security desk');
    expect('toJSON' in setNote(order, 'x')).toBe(false); // CommandQueue.enqueue would not compile
  });
});
