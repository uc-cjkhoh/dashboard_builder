// The union dialog (DOM only; rules in union-model.js): tick 2-5 tables of the selected database, then see the first
// rows of them stacked (UNION ALL over their shared columns) in the raw-row dialog. Read-only.
import { api } from "../Core/api.js";
import { LIMITS } from "../Core/validate.js";
import { entities } from "../Core/store.js";
import { unionSource, takenNames } from "../Core/source-model.js";
import { makeButton, openDialog, closeDialog, toast } from "../Core/ui.js";
import { unionRequest, unionPickState, sharedUnionColumns, UNION_NONE } from "./union-model.js";
import { openRowsDialog } from "./rows-dialog.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export function openUnionDialog(db, tables) {
  if (!db || !tables.length) { toast("Pick a database with tables first.", "info"); return null; }
  const dlg = el("dialog", "dialog union-dialog");
  dlg.setAttribute("aria-labelledby", "union-title");
  const title = el("h2", "dialog__title", "Union tables"); title.id = "union-title";
  const body = el("div", "dialog__body union-dialog__body");
  const list = el("div", "union-dialog__list"); list.setAttribute("role", "group"); list.setAttribute("aria-labelledby", "union-title");
  const boxes = tables.map((t) => {
    const label = el("label", "union-dialog__item");
    const box = el("input"); box.type = "checkbox"; box.value = t;
    label.append(box, el("span", "", t)); list.append(label);
    return box;
  });
  const hint = el("p", "union-dialog__hint"); hint.setAttribute("role", "status");
  body.append(list, hint);
  const foot = el("div", "dialog__foot");
  const cancel = makeButton("Cancel", "btn");
  const go = makeButton("Show rows", "btn");
  const add = makeButton("Add to model", "btn btn--primary");
  foot.append(cancel, go, add);
  dlg.append(title, body, foot);
  document.body.append(dlg);

  const picked = () => boxes.filter((b) => b.checked).map((b) => b.value);
  const colCache = new Map(); // table -> its columns, read once per dialog
  const columnsOf = (t) => { if (!colCache.has(t)) colCache.set(t, api.columns(db, t).catch((e) => { colCache.delete(t); throw e; })); return colCache.get(t); };
  /** Do the picked tables share a column? Resolves null when they do (or the columns can't be read: the server then decides), else the reason. */
  const shareProblem = async (tbls) => {
    try { return sharedUnionColumns(await Promise.all(tbls.map(columnsOf))).length ? null : UNION_NONE; } catch { return null; }
  };
  let seq = 0;
  const refresh = () => {
    const st = unionPickState(picked());
    go.disabled = add.disabled = !st.ok; hint.textContent = st.hint;
    for (const b of boxes) b.disabled = !b.checked && picked().length >= LIMITS.unionTables;
    const mine = ++seq;
    if (st.ok) shareProblem(picked()).then((why) => { if (mine === seq && why) { hint.textContent = why; add.disabled = true; } });
  };
  for (const b of boxes) b.addEventListener("change", refresh);
  refresh();
  cancel.addEventListener("click", () => closeDialog(dlg));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDialog(dlg); });
  go.addEventListener("click", () => {
    let request;
    try { request = unionRequest(db, picked()); } catch (err) { toast(err.message, "danger"); return; }
    openRowsDialog({ title: "Union — first rows", subtitle: `${db}: ${request.tables.join(" + ")}`, request, filename: "union", load: api.union });
  });
  add.addEventListener("click", async () => { // the union becomes a table on the Data Source (canvas.js adds it) that worksheets can read
    const why = await shareProblem(picked());
    if (why) { hint.textContent = why; add.disabled = true; return; } // refused in place: nothing is added
    let source;
    try { source = unionSource(db, picked(), takenNames(entities, db, tables)); } catch (err) { toast(err.message, "danger"); return; }
    closeDialog(dlg);
    document.dispatchEvent(new CustomEvent("source:add", { detail: { source } }));
  });
  openDialog(dlg);
  boxes[0].focus();
  return dlg;
}
