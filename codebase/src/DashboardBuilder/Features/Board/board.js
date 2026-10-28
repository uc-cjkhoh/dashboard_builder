import { bus, activeDashboard, worksheets, setWidgets, nextWidgetId } from "../Core/store.js";
import { toggle, toast, makeButton } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { LIMITS } from "../Core/validate.js";
import { sharedResults } from "../Dashboard/dashboards.js";
import { placeNew } from "./board-model.js";
import { layoutBoard, widgetOrder } from "./board-layout.js";
import { createWidget } from "./board-widget.js";
import { createPanel } from "./board-panel.js";

// The dashboard tab's body: a side panel (worksheets to add) and the 12-column canvas of widgets. Only the ACTIVE
// dashboard renders — leaving it destroys every worksheet view (queries aborted, chart instances and their resize observers
// released), so coming back re-runs each widget (from the result cache when its sheet is unchanged). Widgets are keyed by id:
// a layout change reconciles in place, so adding or removing one never redraws the others.
const PRINT_WIDTH = 1000; // px: the grid's width on paper (the page, less margins, at 96 dpi)

/** Row height and gap in px from the design tokens (`calc(var(--ctl-h) * 2)`, `var(--s3)`), so the pure layout has no constants. */
function readMetrics() {
  const css = getComputedStyle(document.documentElement);
  const px = (name, fallback) => { const v = parseFloat(css.getPropertyValue(name)); return Number.isFinite(v) ? v : fallback; };
  return { rowH: px("--ctl-h", 32) * 2, gap: px("--s3", 12) };
}

export function initBoard() {
  const $ = (id) => document.getElementById(id);
  const view = $("board-view"), main = $("board-main"), grid = $("board-grid"), empty = $("board-empty");
  if (!view || !main || !grid) return;
  const title = $("board-title"), count = $("board-count");
  const results = sharedResults; // the editor's cache: a widget draws what its worksheet tab just ran
  const entries = new Map(); // widget id → createWidget(...)
  let shownId = null;        // the dashboard whose widgets are on screen
  let printing = false;

  const panel = createPanel($("board-panel"), { onAddSheet: (sheetId) => add("sheet", sheetId), onAddText: () => add("text") });

  function teardown() {
    for (const e of entries.values()) { e.destroy(); e.el.remove(); }
    entries.clear();
    shownId = null;
  }

  function layout() {
    const dash = activeDashboard();
    const width = printing ? PRINT_WIDTH : grid.clientWidth;
    if (!dash || !width) return;
    const { stacked, height, rects } = layoutBoard(dash.widgets, width, readMetrics());
    grid.classList.toggle("is-stacked", stacked);
    grid.style.height = `${height}px`;
    for (const [id, r] of rects) {
      const s = entries.get(id)?.el.style;
      if (s) { s.left = `${r.left}px`; s.top = `${r.top}px`; s.width = `${r.width}px`; s.height = `${r.height}px`; }
    }
  }

  function reconcile(dash) {
    const ids = new Set(dash.widgets.map((w) => w.id));
    for (const [id, e] of entries) if (!ids.has(id)) { e.destroy(); e.el.remove(); entries.delete(id); }
    const fresh = [];
    for (const w of dash.widgets) {
      const known = entries.get(w.id);
      if (known) { known.update(w); continue; }
      const e = createWidget(w, { results, onRemove: remove });
      entries.set(w.id, e);
      grid.append(e.el);
      fresh.push(e);
    }
    const order = widgetOrder(dash.widgets).map((w) => entries.get(w.id).el); // DOM (tab) order = reading order
    if (order.some((el, i) => grid.children[i] !== el)) grid.append(...order);
    toggle(empty, dash.widgets.length === 0);
    layout();
    for (const e of fresh) e.run();
  }

  function sync() {
    const dash = activeDashboard();
    toggle(view, Boolean(dash));
    if (!dash) { teardown(); return; }
    if (shownId !== dash.id) { teardown(); shownId = dash.id; }
    title.textContent = dash.name;
    count.textContent = `${dash.widgets.length} of ${LIMITS.widgets} widgets`;
    panel.render(worksheets());
    reconcile(dash);
  }

  function add(kind, sheetId) {
    const dash = activeDashboard();
    if (!dash) return;
    const spot = placeNew(dash.widgets, kind);
    if (!spot.ok) { toast(spot.error, "danger"); return; }
    const { x, y, w, h } = spot;
    const widget = kind === "sheet" ? { id: nextWidgetId(), kind, sheetId, x, y, w, h } : { id: nextWidgetId(), kind, heading: "Text", body: "", x, y, w, h };
    setWidgets(dash.id, [...dash.widgets, widget]); // → dashboard:changed → sync (autosave listens to the same event)
    entries.get(widget.id)?.el.scrollIntoView({ block: "nearest" });
  }

  function remove(widget) {
    const dash = activeDashboard();
    if (!dash) return;
    const ordered = widgetOrder(dash.widgets);
    const at = ordered.findIndex((w) => w.id === widget.id);
    const name = entries.get(widget.id)?.el.getAttribute("aria-label") ?? "widget";
    setWidgets(dash.id, dash.widgets.filter((w) => w.id !== widget.id));
    toast(`Removed “${name}”.`, "info");
    const next = widgetOrder(activeDashboard().widgets)[Math.min(at, dash.widgets.length - 1)];
    (next ? entries.get(next.id)?.el.querySelector(".board-widget__remove") : $("board-panel").querySelector(".board-panel__add-text"))?.focus();
  }

  const runAll = () => { for (const e of entries.values()) e.run(); };
  for (const type of ["view:changed", "tabs:changed", "dashboard:changed"]) bus.addEventListener(type, sync);
  // A worksheet edit while its dashboard is on screen re-runs that sheet's widgets; otherwise the dashboard re-runs on its next show.
  bus.addEventListener("worksheet:changed", (ev) => { for (const e of entries.values()) if (e.widget.sheetId === ev.detail?.id) e.run(); });
  // Colours are read at render time: redraw from the result cache (no query) when light / dark or the workbook theme flips.
  for (const type of ["scheme:changed", "theme:changed"]) bus.addEventListener(type, runAll);
  // After a reload a widget may show a hint before its tables' columns arrive: those (only) run again once they do.
  let columnsTimer = 0;
  bus.addEventListener("entity:loaded", () => { clearTimeout(columnsTimer); columnsTimer = setTimeout(() => { for (const e of entries.values()) e.retryIfBlank(); }, 100); });

  // The canvas width follows its panel: re-lay out on resize (charts re-fit through their own observers — no query).
  let lastWidth = 0;
  new ResizeObserver(() => { if (grid.clientWidth !== lastWidth) { lastWidth = grid.clientWidth; layout(); } }).observe(grid);

  // Full screen and print apply to the whole canvas.
  const tools = $("board-tools");
  const isFull = () => document.fullscreenElement === main || main.classList.contains("is-presenting");
  const fullBtn = makeButton("", "btn board-bar__btn");
  const syncFull = () => {
    fullBtn.replaceChildren(icon("expand", { size: 14 }), document.createTextNode(isFull() ? "Exit full screen" : "Full screen"));
    fullBtn.setAttribute("aria-pressed", String(isFull()));
  };
  fullBtn.addEventListener("click", async () => {
    if (isFull()) { main.classList.remove("is-presenting"); if (document.fullscreenElement) await document.exitFullscreen(); }
    else { try { await main.requestFullscreen(); } catch { main.classList.add("is-presenting"); } }
    syncFull();
  });
  document.addEventListener("fullscreenchange", syncFull);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && main.classList.contains("is-presenting")) { main.classList.remove("is-presenting"); syncFull(); } });
  const printBtn = makeButton("", "btn board-bar__btn");
  printBtn.append(icon("print", { size: 14 }), document.createTextNode("Print"));
  printBtn.addEventListener("click", () => window.print());
  window.addEventListener("beforeprint", () => { if (activeDashboard()) { printing = true; layout(); } });
  window.addEventListener("afterprint", () => { printing = false; layout(); });
  syncFull();
  tools.append(fullBtn, printBtn);

  sync();
}
