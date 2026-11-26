// Shared setup for the browser checks: a worksheet only reads tables that are in a relationship once the model holds two or more
// table cards (relationships.md#rendering), so a check that adds two tables relates them first, the way a user does: drag one key
// row onto the other, pick a cardinality in the dialog, wait for the link badge.
const J = JSON.stringify;

/** Relate fromTable.fromColumn to toTable.toColumn on the Data Source canvas (both cards must already be drawn). */
export async function relateTables(ev, waitFor, [fromTable, fromColumn, toTable, toColumn], cardinality = 'N:1') {
  await ev(`(() => { const row = (t, c) => [...document.querySelectorAll('.entity')].find((x) => x.textContent.includes(t)).querySelector('.col-row[data-column=' + JSON.stringify(c) + ']');
    const a = row(${J(fromTable)}, ${J(fromColumn)}), z = row(${J(toTable)}, ${J(toColumn)}); const dt = new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt })); z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt })); return true; })()`);
  await waitFor(`document.querySelector('dialog[open] input[name=cardinality]') !== null`, 'relationship dialog');
  await ev(`[...document.querySelectorAll('dialog[open] input[name=cardinality]')].find((x) => x.value === ${J(cardinality)}).click(); document.querySelector('dialog[open]').querySelector('.rel-dialog__foot .btn--primary').click()`);
  await waitFor(`document.querySelector('.rel-badge') !== null && document.querySelector('dialog[open] input[name=cardinality]') === null`, 'relationship drawn');
}

/** Calculated chips live in the sidebar's Calculated fields manager dialog, not in the field pane. A modal dialog left open would block
 *  real mouse and key input (and Esc would close it), so the checks open it only while they need it:
 *  NEW_CALC opens it and presses "New calculated field"; the manager closes again once the calculation dialog on top of it closes.
 *  PAGE_CHIP (the page-side `__t.chip`) finds a chip in the pane, or opens the manager to find a calculated one and closes it
 *  right after the calling script step. */
export const NEW_CALC = `(() => { const man = () => document.querySelector('dialog.calc-manager[open]');
  if (!man()) document.querySelector('button[aria-label="Calculated fields"]').click();
  // a closed dialog is removed from the page and its close event never reaches the document, so watch for the removal
  const mo = new MutationObserver((recs) => { if (!recs.some((r) => [...r.removedNodes].some((n) => n.matches?.('dialog') && !n.classList.contains('calc-manager')))) return;
    mo.disconnect(); [...(man()?.querySelectorAll('.dialog__foot button') ?? [])].find((x) => x.textContent === 'Done')?.click(); });
  [...man().querySelectorAll('.dialog__foot button')].find((x) => /New calculated field/.test(x.textContent)).click(); mo.observe(document.body, { childList: true }); return true; })()`;

export const PAGE_CHIP = `(name) => {
  const find = () => [...document.querySelectorAll('#ws-fields .ws-field, dialog.calc-manager[open] .ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === name && !c.closest('[hidden]')); // the pane's Calculated group is hidden unless searching
  const hit = find(); if (hit) return hit;
  if (document.querySelector('dialog.calc-manager[open]') || !document.querySelector('button[aria-label="Calculated fields"]')) return undefined;
  document.querySelector('button[aria-label="Calculated fields"]').click();
  const c = find();
  queueMicrotask(() => [...(document.querySelector('dialog.calc-manager[open]')?.querySelectorAll('.dialog__foot button') ?? [])].find((x) => x.textContent === 'Done')?.click());
  return c;
}`;

/** Browser expression: right-click the calculated chip `name` in the Calculated fields manager and choose `item` from its menu (Edit…, Duplicate, Delete…, Copy …).
 *  A popup opened from a chip inside the manager lives in that dialog, so the manager must stay open until the item has run: this opens it, picks the item in the same
 *  step, then closes it again (Done) once the dialog the item opens on top (Edit…, the Delete… confirm) is gone, or at once when the item opens none. */
export const calcMenuExpr = (name, item) => `(() => { const man = () => document.querySelector('dialog.calc-manager[open]'); const opened = !man();
  if (opened) document.querySelector('button[aria-label="Calculated fields"]').click();
  const chip = [...man().querySelectorAll('.ws-field')].find((c) => c.querySelector('.ws-field__name')?.textContent === ${JSON.stringify(name)});
  chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  [...document.querySelectorAll('.ctx-menu .menu__item')].find((x) => x.textContent.trim() === ${JSON.stringify(item)}).click();
  const done = () => [...(man()?.querySelectorAll('.dialog__foot button') ?? [])].find((x) => x.textContent === 'Done')?.click();
  const other = () => [...document.querySelectorAll('dialog[open]')].some((d) => !d.classList.contains('calc-manager'));
  if (opened) {
    if (!other()) done(); // the item opened nothing: Duplicate, Copy, a refused Delete…
    else { const mo = new MutationObserver(() => { if (!other()) { mo.disconnect(); done(); } }); mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] }); }
  }
  return true; })()`;

/** Browser expression: the text of the Calculated fields manager (every calculation's row), opened and closed again if it was shut. */
export const CALC_LIST_TEXT = `(() => { let d = document.querySelector('dialog.calc-manager[open]'); const opened = !d;
  if (opened) { document.querySelector('button[aria-label="Calculated fields"]').click(); d = document.querySelector('dialog.calc-manager[open]'); }
  const t = d.textContent; if (opened) [...d.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Done').click(); return t; })()`;

/** Browser expression: the names of every calculated field, read from the Calculated fields manager (opened and closed again if it was shut). */
export const CALC_NAMES = `(() => { let d = document.querySelector('dialog.calc-manager[open]'); const opened = !d;
  if (opened) { document.querySelector('button[aria-label="Calculated fields"]').click(); d = document.querySelector('dialog.calc-manager[open]'); }
  const n = [...d.querySelectorAll('.calc-manager__row .ws-field__name')].map((x) => x.textContent); if (opened) [...d.querySelectorAll('.dialog__foot button')].find((x) => x.textContent === 'Done').click(); return n; })()`;
