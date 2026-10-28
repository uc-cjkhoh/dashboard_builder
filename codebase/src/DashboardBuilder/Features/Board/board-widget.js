import { worksheetById, switchTab } from "../Core/store.js";
import { icon } from "../Core/icons.js";
import { toggle } from "../Core/ui.js";
import { sizeChart } from "../Dashboard/chart.js";
import { createWorksheetView } from "../Dashboard/worksheet-view.js";
import { planCtx, categoryOf, castOf } from "../Dashboard/dashboards.js";
import { hint } from "../Dashboard/render-dom.js";
import { LIMITS } from "../Core/validate.js";
import { validateTextEdit, textChanged } from "./text-edit.js";

// One widget on the board: a header (title, Edit, Remove) over a body. A worksheet widget's body is a non-interactive
// worksheet view (createWorksheetView({ interactive: false })) of its worksheet's sheet, run with its own latest-wins gate
// and scope = the worksheet id; its error / hint states render inside the body, so a sibling is never affected. A text
// widget's body is its heading and body text as plain text (textContent — no markup, no Markdown).
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

function toolButton(name, label, className) {
  const b = h("button", `iconbtn board-widget__btn ${className}`);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(name, { size: 16 }));
  return b;
}

let formSeq = 0;
/** `host` = { results, onRemove(widget), onSaveText(widget, { heading, body }) }. Returns { el, update(widget), run(), destroy(), body, focusEdit() }. */
export function createWidget(widget, host) {
  const el = h("article", `board-widget board-widget--${widget.kind}`);
  el.dataset.widgetId = widget.id;
  // Focusable so the keyboard can move (arrows) and resize (Shift + arrows) it; board-interact.js handles the keys.
  el.tabIndex = 0;
  el.setAttribute("role", "group");
  el.setAttribute("aria-roledescription", "dashboard widget");
  el.setAttribute("aria-describedby", "board-keyhint");
  const head = h("header", "board-widget__head");
  const title = h("h3", "board-widget__title");
  const tools = h("div", "board-widget__tools");
  const remove = toolButton("close", "Remove", "iconbtn--danger board-widget__remove");
  remove.addEventListener("click", () => host.onRemove(current));
  const edit = toolButton("edit", "Edit", "board-widget__edit"); // worksheet → its tab; text → inline edit
  edit.addEventListener("click", () => (current.kind === "sheet" ? switchTab(current.sheetId) : startEdit()));
  tools.append(edit, remove);
  head.append(title, tools);
  const grip = h("span", "board-widget__resize"); // bottom-right corner: drag to resize (the keyboard path is Shift + arrows)
  grip.setAttribute("aria-hidden", "true");
  const notice = h("p", "ws-chart-notice board-widget__notice");
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const body = h("div", widget.kind === "sheet" ? "board-widget__body ws-chart" : "board-widget__body board-text");
  el.append(head, ...(widget.kind === "sheet" ? [notice] : []), body, grip);
  let current = widget;

  let view = null;
  if (widget.kind === "sheet") {
    view = createWorksheetView(body, () => {
      const tab = worksheetById(current.sheetId);
      return { dash: tab, noticeEl: notice, results: host.results, plan: planCtx(), categoryOf, castOf };
    }, { interactive: false, cancelLabel: () => labelFor(current) });
  }

  function labelFor(w) {
    if (w.kind === "text") return w.heading || "Text";
    return worksheetById(w.sheetId)?.name ?? "Closed worksheet";
  }
  // --- inline text edit: heading + body become labelled inputs; Save / Enter commits, Cancel / Esc discards ---
  let editing = null; // the text as it was when the edit began, or null
  function startEdit() {
    if (editing || current.kind !== "text") return;
    editing = { heading: current.heading ?? "", body: current.body ?? "" };
    el.classList.add("is-editing");
    const id = `tx${++formSeq}`;
    const form = h("form", "board-text-edit");
    form.noValidate = true;
    const field = (name, label, control, max, value) => {
      const wrap = h("div", "board-text-edit__field");
      const lab = h("label", "board-text-edit__label", label);
      control.id = `${id}-${name}`;
      lab.htmlFor = control.id;
      control.className = "board-text-edit__input";
      control.maxLength = max;
      control.value = value;
      control.setAttribute("aria-describedby", `${id}-${name}-meta`);
      const meta = h("p", "board-text-edit__meta");
      meta.id = `${id}-${name}-meta`;
      const count = h("span", "board-text-edit__count");
      const err = h("span", "board-text-edit__error");
      err.setAttribute("role", "alert");
      meta.append(count, err);
      const sync = () => { count.textContent = `${control.value.length} / ${max}`; };
      control.addEventListener("input", () => { sync(); err.textContent = ""; control.removeAttribute("aria-invalid"); });
      sync();
      wrap.append(lab, control, meta);
      return { wrap, control, err };
    };
    const hd = field("heading", "Heading", h("input"), LIMITS.widgetHeading, editing.heading);
    hd.control.type = "text";
    const bd = field("body", "Text", h("textarea"), LIMITS.widgetBody, editing.body);
    bd.control.rows = 3;
    const actions = h("div", "board-text-edit__actions");
    const save = h("button", "btn btn--primary board-text-edit__save", "Save");
    save.type = "submit";
    save.setAttribute("aria-label", "Save the text");
    const cancel = h("button", "btn board-text-edit__cancel", "Cancel");
    cancel.type = "button";
    cancel.setAttribute("aria-label", "Cancel editing the text");
    actions.append(save, cancel);
    form.append(hd.wrap, bd.wrap, actions);
    const finish = () => { editing = null; el.classList.remove("is-editing"); paintText(current); edit.focus(); };
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const r = validateTextEdit({ heading: hd.control.value, body: bd.control.value });
      if (!r.ok) {
        for (const [part, f] of [["heading", hd], ["body", bd]]) {
          f.err.textContent = r.errors[part] ?? "";
          if (r.errors[part]) f.control.setAttribute("aria-invalid", "true"); else f.control.removeAttribute("aria-invalid");
        }
        (r.errors.heading ? hd : bd).control.focus();
        return;
      }
      const changed = textChanged(current, r.value);
      finish();
      if (changed) host.onSaveText(current, r.value);
    });
    cancel.addEventListener("click", finish);
    form.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(); }
      else if (ev.key === "Enter" && ev.ctrlKey) { ev.preventDefault(); form.requestSubmit(); } // Enter alone submits from the heading and breaks a line in the text
    });
    body.replaceChildren(form);
    hd.control.focus();
    hd.control.select();
  }
  function paintText(w) {
    body.replaceChildren(); // the heading is the widget's title (header); the body is the text under it
    if (w.body) body.append(h("p", "board-text__body", w.body));
  }
  function update(w) {
    current = w;
    const name = labelFor(w);
    title.textContent = name;
    title.title = name;
    remove.setAttribute("aria-label", `Remove “${name}” from the dashboard`);
    edit.setAttribute("aria-label", w.kind === "text" ? `Edit the text “${name}”` : `Edit the worksheet “${name}”`);
    el.setAttribute("aria-label", name);
    if (w.kind !== "text") return;
    if (editing && !textChanged({ heading: editing.heading, body: editing.body }, { heading: w.heading ?? "", body: w.body ?? "" })) return; // keep the open form
    editing = null; // the text changed under the form (undo / redo): show the new text
    el.classList.remove("is-editing");
    paintText(w);
  }
  update(widget);

  return {
    el, body, get widget() { return current; },
    get editing() { return editing !== null; },
    focusEdit() { edit.focus(); },
    update,
    /** Run the worksheet's current sheet (a text widget has nothing to run). */
    run() {
      if (!view) return Promise.resolve();
      if (!worksheetById(current.sheetId)) { body.replaceChildren(hint("This worksheet was closed.")); toggle(notice, false); return Promise.resolve(); }
      return view.run();
    },
    /** Print: draw the chart at a fixed size (the widget's printed cell box, minus header and padding); null restores the pane size. */
    sizeChart(box) { if (view) sizeChart(body, box ? { width: Math.max(1, box.width - (box.chrome?.x ?? 0)), height: Math.max(1, box.height - head.offsetHeight - (notice.hidden ? 0 : notice.offsetHeight) - (box.chrome?.y ?? 0)) } : null); },
    /** Run again only if the body shows a hint or error (its tables' columns may have arrived since). */
    retryIfBlank() { return body.querySelector(".ws-hint") ? this.run() : Promise.resolve(); },
    destroy() { view?.destroy(); },
  };
}
