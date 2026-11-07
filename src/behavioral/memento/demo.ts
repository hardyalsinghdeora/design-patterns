import { InvoiceEditor, InvoiceSession } from './memento';

const rupees = (minor: number) => `Rs ${(minor / 100).toFixed(2)}`;
let t = Date.parse('2026-03-01T09:00:00Z');
const editor = new InvoiceEditor('INV-1001', 'Acme Pvt Ltd', () => new Date((t += 60_000)));
const session = new InvoiceSession(editor, 3); // keep at most 3 save points
const show = (step: string) => {
  const v = editor.view();
  console.log(`  ${step.padEnd(34)} lines=${v.lines.length} discount=${rupees(v.discountMinor)} total=${rupees(v.totalMinor)} notes="${v.notes}"`);
};

console.log('\n1. Build an invoice, checkpointing as we go (history capacity 3)');
session.checkpoint('empty');
editor.addLine({ description: 'Hosting, March', quantity: 1, unitPriceMinor: 4_99_900 });
session.checkpoint('hosting');
editor.addLine({ description: 'Support hours', quantity: 3, unitPriceMinor: 1_50_000 });
session.checkpoint('support');
editor.applyDiscount(1_00_000);
session.checkpoint('discount');
show('after edits');
console.log('  save points kept:', session.history.labels, '("empty" was dropped)');

console.log('\n2. Undo twice');
session.undo();
show('undo -> "discount"');
session.undo();
show('undo -> "support"');

console.log('\n3. Edit a draft, then discard it');
const draft = session.beginDraft();
editor.setNotes('Experimental 50% off').applyDiscount(4_74_950);
show('while drafting');
draft.discard();
show('after discard');

console.log('\n4. Persist a save point (the editor owns the JSON format)');
const json = editor.exportMemento(editor.save('autosave'));
console.log('  ', json.slice(0, 90) + '...');
editor.removeLine(1);
show('after removing a line');
editor.restore(editor.importMemento(json));
show('restored from JSON');

console.log('\n5. Issue it: save points can no longer rewrite the invoice');
const old = editor.save('pre-issue');
editor.issue();
try {
  editor.restore(old);
} catch (error) {
  console.log('  restore refused:', (error as Error).message);
}
console.log('  what the caretaker can see of a memento:', Object.keys(old));
console.log();
