// The dashboard's data note on screen: the saved text (textContent only, never HTML) under the bar, and an inline editor
// (labelled textarea + count, Save / Cancel, Ctrl+Enter saves, Esc cancels). An over-long note is refused in place, never cut.
import { LIMITS } from "../Core/validate.js";
import { makeButton } from "../Core/ui.js";
import { validateNotes } from "./board-notes.js";

let seq = 0;

/** `host` is the (hidden-toggled) container; `onSave(text)` stores a validated note; `onDone(message)` reports. Returns { paint(notes), open(notes), close(), isOpen() }. */
export function createNotes({ host, onSave, onDone }) {
  let editing = false;

  function paint(notes) {
    if (editing) return;
    host.replaceChildren();
    host.hidden = !notes;
    if (!notes) return;
    const p = document.createElement("p");
    p.className = "board-notes__text";
    p.textContent = notes;
    host.append(p);
  }

  function open(notes) {
    if (editing) { host.querySelector("textarea")?.focus(); return; }
    editing = true;
    host.hidden = false;
    const id = `bn${++seq}`;
    const form = document.createElement("form");
    form.className = "board-notes__form";
    form.noValidate = true;
    const lab = document.createElement("label");
    lab.className = "board-notes__label";
    lab.textContent = "Data notes";
    const input = document.createElement("textarea");
    input.className = "board-notes__input";
    input.id = lab.htmlFor = id;
    input.rows = 4;
    input.value = notes ?? "";
    input.setAttribute("aria-describedby", `${id}-m`);
    const meta = document.createElement("p");
    meta.className = "board-notes__meta";
    meta.id = `${id}-m`;
    const counter = document.createElement("span"), err = document.createElement("span");
    err.className = "board-notes__error";
    err.setAttribute("role", "alert");
    meta.append(counter, err);
    const sync = () => { counter.textContent = `${input.value.trim().length} / ${LIMITS.dashboardNotes}`; };
    input.addEventListener("input", () => { sync(); err.textContent = ""; input.removeAttribute("aria-invalid"); });
    sync();
    const actions = document.createElement("div");
    actions.className = "board-notes__actions";
    const save = makeButton("Save", "btn btn--primary board-bar__btn");
    save.type = "submit";
    save.setAttribute("aria-label", "Save the data notes");
    const cancel = makeButton("Cancel", "btn board-bar__btn");
    cancel.setAttribute("aria-label", "Cancel editing the data notes");
    actions.append(save, cancel);
    form.append(lab, input, meta, actions);
    host.replaceChildren(form);
    const finish = (current, message) => { editing = false; paint(current); if (message) onDone(message); };
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const r = validateNotes(input.value);
      if (!r.ok) { err.textContent = r.error; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
      editing = false;
      onSave(r.value);                  // the store change repaints through sync(); paint here too in case nothing changed
      paint(r.value);
      onDone(r.value ? "Data notes saved." : "Data notes cleared.");
    });
    cancel.addEventListener("click", () => finish(notes));
    form.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(notes); }
      else if (ev.key === "Enter" && ev.ctrlKey) { ev.preventDefault(); form.requestSubmit(); }
    });
    input.focus();
  }

  return { paint, open, close() { editing = false; }, isOpen: () => editing };
}
