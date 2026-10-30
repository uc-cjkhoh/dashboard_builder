// The unpivot dialog (DOM only; rules in unpivot-model.js): pick a table of the selected database, tick the columns to turn
// into rows and the ones to keep, then see the first rows in the raw-row dialog (Field, Value). Read-only; a preview only.
import { api } from "../Core/api.js";
import { LIMITS } from "../Core/validate.js";
import { entities } from "../Core/store.js";
import { unpivotSource, takenNames } from "../Core/source-model.js";
import { makeButton, openDialog, closeDialog, toast } from "../Core/ui.js";
import { unpivotRequest, unpivotPickState } from "./unpivot-model.js";
import { openRowsDialog } from "./rows-dialog.js";

let seq = 0;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export function openUnpivotDialog(db, tables) {
  if (!db || !tables.length) { toast("Pick a database with tables first.", "info"); return null; }
  const n = ++seq;
  const dlg = el("dialog", "dialog unpivot-dialog");
  dlg.setAttribute("aria-labelledby", `unpivot-title-${n}`);
  const title = el("h2", "dialog__title", "Unpivot a table"); title.id = `unpivot-title-${n}`;
  const body = el("div", "dialog__body unpivot-dialog__body");

  const tableField = el("div", "field");
  const tableLabel = el("label", null, "Table"); tableLabel.htmlFor = `unpivot-table-${n}`;
  const select = el("select", "select"); select.id = tableLabel.htmlFor;
  for (const t of tables) { const o = el("option", null, t); o.value = t; select.append(o); }
  tableField.append(tableLabel, select);

  const lists = el("div", "unpivot-dialog__cols");
  const mkList = (heading) => {
    const wrap = el("div"); const head = el("div", "unpivot-dialog__head", heading); head.id = `unpivot-h-${n}-${heading}`;
    const list = el("div", "unpivot-dialog__list"); list.setAttribute("role", "group"); list.setAttribute("aria-labelledby", head.id);
    wrap.append(head, list); return { wrap, list };
  };
  const rowsSide = mkList("Turn into rows"), keepSide = mkList("Keep");
  lists.append(rowsSide.wrap, keepSide.wrap);

  const hint = el("p", "union-dialog__hint"); hint.setAttribute("role", "status");
  body.append(tableField, lists, hint);
  const foot = el("div", "dialog__foot");
  const cancel = makeButton("Cancel", "btn");
  const go = makeButton("Show rows", "btn");
  const add = makeButton("Add to model", "btn btn--primary");
  go.disabled = add.disabled = true;
  foot.append(cancel, go, add);
  dlg.append(title, body, foot);
  document.body.append(dlg);

  let cols = [], boxes = []; // boxes: [{ name, asRow, asKeep }]
  const ticked = (side) => boxes.filter((b) => b[side].checked).map((b) => b.name);
  const refresh = () => {
    const rowsPicked = ticked("asRow"), keepPicked = ticked("asKeep");
    const st = unpivotPickState(cols, rowsPicked, keepPicked);
    go.disabled = add.disabled = !st.ok; hint.textContent = st.hint;
    for (const b of boxes) {
      b.asRow.disabled = b.asKeep.checked || (!b.asRow.checked && rowsPicked.length >= LIMITS.unpivotColumns);
      b.asKeep.disabled = b.asRow.checked || (!b.asKeep.checked && keepPicked.length >= LIMITS.unpivotKeep);
    }
  };
  const load = () => {
    go.disabled = add.disabled = true; hint.textContent = "Loading the columns…";
    rowsSide.list.replaceChildren(); keepSide.list.replaceChildren(); boxes = [];
    api.columns(db, select.value).then((res) => {
      cols = res;
      for (const c of cols) {
        const make = (list) => {
          const label = el("label", "union-dialog__item"); const box = el("input"); box.type = "checkbox"; box.value = c.name;
          label.append(box, el("span", "", c.name), el("span", "unpivot-dialog__type", c.type)); list.append(label);
          box.addEventListener("change", refresh); return box;
        };
        boxes.push({ name: c.name, asRow: make(rowsSide.list), asKeep: make(keepSide.list) });
      }
      refresh();
    }).catch((err) => { hint.textContent = err.message; });
  };
  select.addEventListener("change", load);
  load();
  cancel.addEventListener("click", () => closeDialog(dlg));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDialog(dlg); });
  go.addEventListener("click", () => {
    let request;
    try { request = unpivotRequest(db, select.value, ticked("asRow"), ticked("asKeep")); } catch (err) { toast(err.message, "danger"); return; }
    closeDialog(dlg);
    openRowsDialog({ title: "Unpivot — first rows", subtitle: `${db}.${request.table}`, request, filename: "unpivot", load: api.unpivot });
  });
  add.addEventListener("click", () => { // the unpivot becomes a table on the Data Source (canvas.js adds it) that worksheets can read
    let source;
    try { source = unpivotSource(db, select.value, ticked("asRow"), ticked("asKeep"), takenNames(entities, db, tables)); } catch (err) { toast(err.message, "danger"); return; }
    closeDialog(dlg);
    document.dispatchEvent(new CustomEvent("source:add", { detail: { source } }));
  });
  openDialog(dlg);
  select.focus();
  return dlg;
}
