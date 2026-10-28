import { worksheetById, switchTab } from "../Core/store.js";
import { icon } from "../Core/icons.js";
import { toggle } from "../Core/ui.js";
import { sizeChart } from "../Dashboard/chart.js";
import { createWorksheetView } from "../Dashboard/worksheet-view.js";
import { planCtx, categoryOf, castOf } from "../Dashboard/dashboards.js";
import { hint } from "../Dashboard/render-dom.js";

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

/** `host` = { results, onRemove(widget) }. Returns { el, update(widget), run(), destroy(), body }. */
export function createWidget(widget, host) {
  const el = h("article", `board-widget board-widget--${widget.kind}`);
  el.dataset.widgetId = widget.id;
  const head = h("header", "board-widget__head");
  const title = h("h3", "board-widget__title");
  const tools = h("div", "board-widget__tools");
  const remove = toolButton("close", "Remove", "iconbtn--danger board-widget__remove");
  remove.addEventListener("click", () => host.onRemove(current));
  let edit = null;
  if (widget.kind === "sheet") {
    edit = toolButton("edit", "Edit", "board-widget__edit");
    edit.addEventListener("click", () => switchTab(current.sheetId));
    tools.append(edit);
  }
  tools.append(remove);
  head.append(title, tools);
  const notice = h("p", "ws-chart-notice board-widget__notice");
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const body = h("div", widget.kind === "sheet" ? "board-widget__body ws-chart" : "board-widget__body board-text");
  el.append(head, ...(widget.kind === "sheet" ? [notice] : []), body);
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
    edit?.setAttribute("aria-label", `Edit the worksheet “${name}”`);
    el.setAttribute("aria-label", name);
    if (w.kind === "text") paintText(w);
  }
  update(widget);

  return {
    el, body, get widget() { return current; },
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
