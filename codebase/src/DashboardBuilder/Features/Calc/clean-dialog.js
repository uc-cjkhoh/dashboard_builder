// The "Clean…" dialog: pick an operation (trim, replace empty values, recode values, read text as a date) and add ONE calculated
// field that does it in the query. DOM only; the plan is clean-model.js. The source data is never changed.
import { calculations, addCalculation } from "../Core/store.js";
import { makeButton, openDialog, closeDialog, toast } from "../Core/ui.js";
import { cleanPlan, cleanOps, parseRecode, CLEAN_MAX_RECODE } from "./clean-model.js";

const LABEL = { trim: "Trim spaces", nullTo: "Replace empty values", recode: "Recode values", date: "Read as a date" };
let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

/** `field` = { db, table, column }; `fieldName` its display name; `category` the column's category. Returns the dialog. */
export function openCleanDialog({ field, fieldName, category }) {
  const n = ++seq;
  const dlg = el("dialog", "dialog split-dialog clean-dialog");
  const title = el("h3", "dialog__title", `Clean · ${fieldName}`); title.id = `clean-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body split-dialog__body");
  const mk = (label, input) => { const f = el("div", "field"); const l = el("label", null, label); input.id = `clean-${n}-${label}`; l.htmlFor = input.id; f.append(l, input); return f; };
  const op = el("select", "select");
  for (const o of cleanOps(category)) { const opt = el("option", null, LABEL[o]); opt.value = o; op.append(opt); }
  const value = el("input", "input"); value.type = "text"; value.autocomplete = "off"; value.maxLength = 100;
  value.placeholder = category === "numeric" ? "0" : "Unknown";
  const pairs = el("textarea", "input clean-dialog__pairs"); pairs.rows = 5; pairs.spellcheck = false; pairs.placeholder = "NY = New York\nCA = California";
  const keep = el("input"); keep.type = "checkbox"; keep.checked = true;
  const keepRow = el("label", "clean-dialog__keep"); keepRow.append(keep, el("span", null, "Keep values not listed"));
  const fValue = mk("Use this value", value), fPairs = mk(`Old = new, one per line (up to ${CLEAN_MAX_RECODE})`, pairs);
  const preview = el("code", "clean-dialog__formula");
  const msg = el("div", "grp-error"); msg.setAttribute("role", "alert");
  body.append(mk("Operation", op), fValue, fPairs, keepRow, preview, msg);
  const foot = el("div", "dialog__foot");
  const cancel = makeButton("Cancel", "btn"), create = makeButton("Create field", "btn btn--primary");
  foot.append(cancel, create);
  dlg.append(title, body, foot);
  document.body.append(dlg);

  const plan = () => {
    if (op.value === "recode") {
      const r = parseRecode(pairs.value);
      if (r.error) return { ok: false, error: r.error };
      return cleanPlan({ field, category, op: "recode", pairs: r.pairs, keep: keep.checked, calcs: calculations, name: fieldName });
    }
    return cleanPlan({ field, category, op: op.value, value: value.value, calcs: calculations, name: fieldName });
  };
  const refresh = () => {
    fValue.hidden = op.value !== "nullTo"; fPairs.hidden = keepRow.hidden = op.value !== "recode";
    const p = plan();
    create.disabled = !p.ok;
    msg.textContent = p.ok || (op.value === "recode" && !pairs.value.trim()) ? "" : p.error;
    preview.textContent = p.ok ? `${p.calcs[0].name} = ${p.calcs[0].formula}` : "";
  };
  for (const c of [op, value, pairs, keep]) c.addEventListener(c === op || c === keep ? "change" : "input", refresh);
  refresh();
  cancel.addEventListener("click", () => closeDialog(dlg));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDialog(dlg); });
  create.addEventListener("click", () => {
    const p = plan();
    if (!p.ok) { msg.textContent = p.error; return; }
    for (const c of p.calcs) addCalculation(c);
    closeDialog(dlg);
    toast(`Added calculated field: ${p.calcs[0].name}.`, "ok");
  });
  openDialog(dlg);
  op.focus();
  return dlg;
}
