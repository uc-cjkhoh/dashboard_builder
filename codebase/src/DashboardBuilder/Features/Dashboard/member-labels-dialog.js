// The "Edit member labels…" dialog (T02-29): a field's top members, one label input each. DOM only — the rules (limits, own-key
// maps, blank = no label) are in member-labels.js. Everything typed or fetched is shown with textContent / input values.
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { LIMITS } from "../Core/validate.js";
import { memberRows, aliasesFromInputs } from "./member-labels.js";

let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

/** The members the dialog lists at most (the distinct-values endpoint is asked for one more, to know whether more exist). */
export const SHOWN = LIMITS.memberAliases;

/**
 * `name` the field's display name; `current` its stored memberAliases map; `load()` resolves the field's distinct members
 * (bounded; null entries are skipped); `onSave(mapOrUndefined)` receives the new map. Resolves nothing.
 */
export function openMemberLabelsDialog({ name, current, load, onSave }) {
  const n = ++seq;
  const dlg = el("dialog", "dialog memlab-dialog");
  const title = el("h3", "dialog__title", `Member labels · ${name}`);
  title.id = `memlab-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body memlab-dialog__body");
  const hint = el("p", "memlab-hint", "A label changes how a member is shown on charts, legends, tooltips, tables and filter lists. Filters, grouping and sorting still use the real value. Leave a label empty to show the value itself.");
  const list = el("div", "memlab-list");
  list.setAttribute("role", "group"); list.setAttribute("aria-label", `Labels for the members of ${name}`);
  const note = el("p", "memlab-note", "Loading the field's members…");
  note.setAttribute("aria-live", "polite");
  const msg = el("div", "memlab-error"); msg.setAttribute("role", "alert");
  body.append(hint, note, list, msg);
  const foot = el("div", "dialog__foot");
  const reset = makeButton("Reset all", "btn memlab-reset"), cancel = makeButton("Cancel", "btn"), save = makeButton("Save", "btn btn--primary");
  reset.title = "Clear every label of this field";
  foot.append(reset, cancel, save);
  dlg.append(title, body, foot);

  let rows = []; // [{ raw, input }]
  const finish = () => closeDialog(dlg);
  cancel.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); }); // Esc discards
  reset.addEventListener("click", () => { for (const r of rows) r.input.value = ""; msg.replaceChildren(); rows[0]?.input.focus(); });
  save.addEventListener("click", () => {
    const r = aliasesFromInputs(rows.map(({ raw, input }) => ({ raw, label: input.value })));
    if (!r.ok) { msg.textContent = r.error; return; }
    onSave(r.value);
    finish();
  });

  const fill = (members, more) => {
    rows = memberRows(members.slice(0, SHOWN), current).map(({ raw, label }, i) => {
      const row = el("div", "memlab-row");
      const value = el("label", "memlab-value", raw);
      value.title = raw;
      const input = el("input", "input memlab-input");
      input.id = `memlab-${n}-${i}`; value.htmlFor = input.id;
      input.type = "text"; input.autocomplete = "off"; input.maxLength = LIMITS.memberLabel; input.value = label;
      input.placeholder = raw;
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        (rows[i + 1]?.input ?? save).focus();
      });
      row.append(value, input);
      list.append(row);
      return { raw, input };
    });
    note.textContent = rows.length ? (more ? `Showing the first ${SHOWN} members — more exist.` : "") : "This field has no members to label.";
    if (rows.length) rows[0].input.focus();
  };
  document.body.append(dlg);
  openDialog(dlg);
  Promise.resolve().then(load).then((members) => fill(members ?? [], (members ?? []).length > SHOWN))
    .catch(() => { note.textContent = "Couldn't load this field's members."; save.disabled = true; });
  save.focus();
}
