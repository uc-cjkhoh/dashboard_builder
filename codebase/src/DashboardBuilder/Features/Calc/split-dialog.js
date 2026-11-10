// The "Split…" dialog: cut a text field at a separator into 2-10 calculated fields (SPLIT(field, sep, k)). DOM only;
// the plan is split-model.js. The new fields are ordinary calculations, so pills, queries and workbooks already know them.
import { calculations, addCalculation } from "../Core/store.js";
import { makeButton, openDialog, closeDialog, toast } from "../Core/ui.js";
import { splitPlan, SPLIT_MAX_PIECES, SPLIT_MAX_SEP } from "./split-model.js";

let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

/** `field` = { db, table, column }; `fieldName` its display name. Returns the dialog. */
export function openSplitDialog({ field, fieldName }) {
  const n = ++seq;
  const dlg = el("dialog", "dialog split-dialog");
  const title = el("h3", "dialog__title", `Split · ${fieldName}`); title.id = `split-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body split-dialog__body");
  const mk = (label, input) => { const f = el("div", "field"); const l = el("label", null, label); input.id = `split-${n}-${label}`; l.htmlFor = input.id; f.append(l, input); return f; };
  const sep = el("input", "input"); sep.type = "text"; sep.autocomplete = "off"; sep.maxLength = SPLIT_MAX_SEP; sep.value = ",";
  const pieces = el("input", "input"); pieces.type = "number"; pieces.min = "2"; pieces.max = String(SPLIT_MAX_PIECES); pieces.step = "1"; pieces.value = "2";
  const given = el("input", "input"); given.type = "text"; given.autocomplete = "off"; given.placeholder = "Optional, comma-separated";
  const names = el("ol", "split-dialog__names");
  const msg = el("div", "grp-error"); msg.setAttribute("role", "alert");
  body.append(mk("Separator", sep), mk("Pieces", pieces), mk("Names", given), names, msg);
  const foot = el("div", "dialog__foot");
  const cancel = makeButton("Cancel", "btn"), create = makeButton("Create fields", "btn btn--primary");
  foot.append(cancel, create);
  dlg.append(title, body, foot);
  document.body.append(dlg);

  const plan = () => splitPlan({ field, sep: sep.value, pieces: pieces.value === "" ? NaN : Number(pieces.value), calcs: calculations, names: given.value });
  const refresh = () => {
    const p = plan();
    create.disabled = !p.ok; msg.textContent = p.ok ? "" : p.error;
    names.replaceChildren(...(p.ok ? p.calcs.map((c) => el("li", null, c.name)) : []));
  };
  sep.addEventListener("input", refresh); pieces.addEventListener("input", refresh); given.addEventListener("input", refresh);
  refresh();
  cancel.addEventListener("click", () => closeDialog(dlg));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDialog(dlg); });
  create.addEventListener("click", () => {
    const p = plan();
    if (!p.ok) { msg.textContent = p.error; return; }
    for (const c of p.calcs) addCalculation(c);
    closeDialog(dlg);
    toast(`Added ${p.calcs.length} calculated fields: ${p.calcs[0].name} … ${p.calcs.at(-1).name}.`, "ok");
  });
  openDialog(dlg);
  sep.focus(); sep.select();
  return dlg;
}
