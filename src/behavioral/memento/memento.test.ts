import { describe, expect, it } from 'vitest';
import { InvoiceEditor, InvoiceMemento, InvoiceSession, SaveHistory } from './memento';

const clock = () => {
  let t = Date.parse('2026-03-01T09:00:00Z');
  return () => new Date((t += 60_000));
};

const hosting = { description: 'Hosting, March', quantity: 1, unitPriceMinor: 4_99_900 };
const support = { description: 'Support hours', quantity: 3, unitPriceMinor: 1_50_000 };

const editor = () => new InvoiceEditor('INV-1001', 'Acme Pvt Ltd', clock());

describe('InvoiceEditor (originator) and InvoiceMemento', () => {
  it('restore returns the exact prior state', () => {
    const e = editor().addLine(hosting).setNotes('Net 30');
    const before = e.view();
    const saved = e.save('v1');
    e.addLine(support).applyDiscount(50_000).setCustomer('Acme Holdings').setNotes('');
    expect(e.view()).not.toEqual(before);
    e.restore(saved);
    expect(e.view()).toEqual(before);
    expect(e.view().totalMinor).toBe(4_99_900);
  });

  it('snapshots are immutable and expose no internals', () => {
    const e = editor().addLine(hosting);
    const saved = e.save('v1');
    e.addLine(support); // later edits must not leak into the snapshot
    expect(Object.keys(saved).sort()).toEqual(['createdAt', 'label']);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(() => {
      (saved as { label: string }).label = 'tampered';
    }).toThrow(TypeError);
    e.restore(saved);
    expect(e.view().lines).toEqual([hosting]);
  });

  it('a restored state can be edited without corrupting the save point', () => {
    const e = editor().addLine(hosting);
    const saved = e.save('v1');
    e.restore(saved).addLine(support);
    e.restore(saved);
    expect(e.view().lines).toHaveLength(1);
  });

  it('refuses foreign save points and refuses to rewrite an issued invoice', () => {
    const other = new InvoiceEditor('INV-2002', 'Globex', clock()).save('x');
    const e = editor().addLine(hosting);
    expect(() => e.restore(other)).toThrow(/belongs to invoice INV-2002/);
    const draft = e.save('draft');
    e.issue();
    expect(() => e.restore(draft)).toThrow(/issued/);
  });

  it('serialises save points through the originator, with a version check', () => {
    const e = editor().addLine(hosting).applyDiscount(9_900);
    const json = e.exportMemento(e.save('autosave'));
    e.removeLine(0);
    const loaded = e.importMemento(json);
    expect(loaded.label).toBe('autosave');
    e.restore(loaded);
    expect(e.view().totalMinor).toBe(4_90_000);
    expect(() => e.importMemento(json.replace('"v":1', '"v":99'))).toThrow(/Unsupported save point version 99/);
    expect(() => e.importMemento('{"v":1,"label":"x","createdAt":"2026-01-01T00:00:00Z","state":{}}')).toThrow(/Malformed/);
  });
});

describe('SaveHistory and InvoiceSession (caretaker)', () => {
  it('bounded history drops the oldest save point', () => {
    const history = new SaveHistory<{ label: string }>(3);
    for (const label of ['a', 'b', 'c', 'd', 'e']) history.push({ label });
    expect(history.labels).toEqual(['c', 'd', 'e']);
    expect(history.pop()?.label).toBe('e');
    expect(history.size).toBe(2);
  });

  it('state is correct after several undos and a named restore', () => {
    const session = new InvoiceSession(editor(), 5);
    const e = session.editor;
    session.checkpoint('empty');
    e.addLine(hosting);
    session.checkpoint('hosting');
    e.addLine(support);
    session.checkpoint('support');
    e.applyDiscount(1_00_000);

    expect(session.undo()).toBe(true);
    expect(e.view()).toMatchObject({ discountMinor: 0, totalMinor: 9_49_900 });
    expect(session.undo()).toBe(true);
    expect(e.view().totalMinor).toBe(4_99_900);
    session.restoreTo('empty');
    expect(e.view().lines).toEqual([]);
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(false);
  });

  it('edit a draft then discard (or commit)', () => {
    const session = new InvoiceSession(editor().addLine(hosting));
    const draft = session.beginDraft();
    session.editor.addLine(support).setCustomer('Someone else');
    draft.discard();
    expect(session.editor.view()).toMatchObject({ customer: 'Acme Pvt Ltd', totalMinor: 4_99_900 });
    expect(() => draft.commit()).toThrow(/already closed/);

    const kept = session.beginDraft();
    session.editor.setNotes('PO 7781');
    kept.commit();
    expect(session.editor.view().notes).toBe('PO 7781');
  });

  it('closure form: a checkpoint is a function that restores', () => {
    const e = editor().addLine(hosting);
    const rollback = e.checkpoint();
    e.addLine(support);
    rollback();
    expect(e.view().lines).toEqual([hosting]);
    expect(e.save('after-rollback')).toBeInstanceOf(InvoiceMemento);
  });
});
