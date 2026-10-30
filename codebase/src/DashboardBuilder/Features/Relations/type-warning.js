import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { kindLabel } from "./relation-rules.js";

// The refusal shown when two columns can't be related because their data types don't match. A modal, not a toast:
// it names both columns with their exact types and kinds, says why, and points at columns that would work.
// Ends are { table, column, type, category }; `suggestions` is { table, kind, names } for the other table.

function side(end) {
  const row = document.createElement("div");
  row.className = "type-warning__col";
  const name = document.createElement("span");
  name.className = "type-warning__name";
  const table = document.createElement("span");
  table.className = "type-warning__table";
  table.textContent = `${end.table}.`;
  name.append(table, end.column);
  const type = document.createElement("span");
  type.className = "type-warning__type";
  type.textContent = `${end.type} · ${kindLabel(end.category)}`;
  row.append(name, type);
  return row;
}

export function openTypeWarning({ from, to, suggestions = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dialog dialog--warn";
    dlg.setAttribute("aria-labelledby", "type-warning-title");

    const title = document.createElement("h2");
    title.className = "dialog__title type-warning__title";
    title.id = "type-warning-title";
    const glyph = icon("warning", { size: 20 });
    glyph.classList.add("type-warning__glyph");
    title.append(glyph, "Data types don't match");

    const body = document.createElement("div");
    body.className = "dialog__body type-warning__body";
    const pair = document.createElement("div");
    pair.className = "type-warning__pair";
    pair.append(side(from), side(to));
    const why = document.createElement("p");
    why.className = "type-warning__why";
    why.textContent = "A join compares values, so both columns must hold the same kind: number, text, date or boolean.";
    body.append(pair, why);
    if (suggestions) {
      const hint = document.createElement("p");
      hint.className = "type-warning__hint";
      hint.textContent = suggestions.names.length
        ? `${suggestions.table} columns that hold ${suggestions.kind}s and are free to join: ${suggestions.names.join(", ")}.`
        : `${suggestions.table} has no free ${suggestions.kind} column to join to.`;
      body.append(hint);
    }

    const foot = document.createElement("div");
    foot.className = "dialog__foot";
    const ok = makeButton("Got it", "btn btn--primary");
    foot.append(ok);

    dlg.append(title, body, foot);
    document.body.append(dlg);
    const finish = () => { closeDialog(dlg); resolve(); };
    ok.addEventListener("click", finish);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
    openDialog(dlg);
    ok.focus();
  });
}
