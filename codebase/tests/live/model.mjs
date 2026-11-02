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
  await waitFor(`document.querySelector('dialog[open] .card-choice') !== null`, 'relationship dialog');
  await ev(`[...document.querySelectorAll('dialog[open] .card-choice')].find((x) => x.textContent === ${J(cardinality)}).click()`);
  await waitFor(`document.querySelector('.rel-badge') !== null && document.querySelector('dialog[open] .card-choice') === null`, 'relationship drawn');
}

/** Browser expression: open the sidebar's Calculated fields manager (if it is not open) and press its "New calculated field" button.
 *  Calculated chips live in that dialog, not in the field pane, so checks look for them in `CHIP_SCOPE` below. */
export const NEW_CALC = `(() => { if (!document.querySelector('dialog.calc-manager[open]')) document.querySelector('button[aria-label="Calculated fields"]').click();
  [...document.querySelectorAll('dialog.calc-manager[open] .dialog__foot button')].find((x) => /New calculated field/.test(x.textContent)).click(); return true; })()`;

/** CSS selector for every field chip a check can reach: the field pane plus the open Calculated fields manager. */
export const CHIP_SCOPE = '#ws-fields .ws-field, dialog.calc-manager[open] .ws-field';
