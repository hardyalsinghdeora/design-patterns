import {
  AddItemCommand,
  ApplyCouponCommand,
  ChangeQuantityCommand,
  CommandHistory,
  CommandQueue,
  MacroCommand,
  Order,
  RemoveItemCommand,
  setNote,
  type Coupon,
} from './command';

const FESTIVE10: Coupon = { code: 'FESTIVE10', percentOff: 10, minSubtotalMinor: 1_000 * 100 };
const BIG20: Coupon = { code: 'BIG20', percentOff: 20, minSubtotalMinor: 5_000 * 100 };
const rs = (minor: number) => `Rs ${(minor / 100).toFixed(2)}`;
const show = (order: Order) => {
  const v = order.view();
  const lines = v.lines.map((l) => `${l.quantity}x${l.sku}`).join(', ') || '(empty)';
  return `${lines} | coupon ${v.coupon ?? '-'} | total ${rs(v.totalMinor)}`;
};

const order = new Order('ord_42');
const history = new CommandHistory();

console.log('\nEditing a draft order through the invoker:');
history.run(new AddItemCommand(order, 'TEA-250G', 34_900, 2));
history.run(new AddItemCommand(order, 'KETTLE', 1_49_900, 1));
history.run(new ApplyCouponCommand(order, FESTIVE10));
history.run(setNote(order, 'Leave at the security desk')); // a closure command
console.log('  history:', history.labels);
console.log('  now    :', show(order));

console.log('\nUndo twice, redo once:');
history.undo();
history.undo();
console.log('  after 2 undos:', show(order));
history.redo();
console.log('  after redo   :', show(order));

console.log('\nA new edit clears the redo branch:');
history.run(new ChangeQuantityCommand(order, 'TEA-250G', 3));
console.log('  canRedo =', history.canRedo, '|', show(order));

console.log('\nA macro that fails half way rolls itself back:');
const upsell = new MacroCommand('upsell', [
  new AddItemCommand(order, 'MUG', 29_900, 2),
  new RemoveItemCommand(order, 'KETTLE'),
  new ApplyCouponCommand(order, BIG20),
]);
try {
  history.run(upsell);
} catch (error) {
  console.log('  rejected:', (error as Error).message);
}
console.log('  unchanged:', show(order));

console.log('\nCommands as data: enqueue now, replay on another worker later:');
const queue = new CommandQueue();
const replica = new Order('ord_42');
queue.enqueue(new AddItemCommand(replica, 'TEA-250G', 34_900, 2));
queue.enqueue(new RemoveItemCommand(replica, 'MUG')); // poison: no such line
queue.enqueue(new AddItemCommand(replica, 'KETTLE', 1_49_900, 1));
console.log('  payload[0]:', queue.pending[0]);
const report = queue.drain(replica, new CommandHistory());
console.log(`  applied ${report.applied}, dead letters:`, report.deadLetters.map((d) => d.error));
console.log('  replica  :', show(replica));
console.log();
