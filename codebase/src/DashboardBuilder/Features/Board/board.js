import { bus, activeDashboard, worksheets, dashboards, worksheetById, setWidgets, setDashboardSize, setDashboardRange, nextWidgetId, isDashboardActive } from "../Core/store.js";
import { toggle, toast, makeButton } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { LIMITS } from "../Core/validate.js";
import { makeCategoryFormatter } from "../Core/format.js";
import { defaultFormat, metaOf } from "../Core/store.js";
import { labelOf } from "../Dashboard/member-labels.js";
import { sharedResults } from "../Dashboard/dashboards.js";
import { nextSelection, selectionRefusal, crossFor, chipText, stillValid, UNSELECTABLE_NOTE } from "../Dashboard/dashboard-select.js";
import { placeNew, NAV_LABEL } from "./board-model.js";
import { validateImageFile, isImageSrc, imageChars, budgetError } from "./image-model.js";
import { layoutBoard, widgetOrder, fixedRowH } from "./board-layout.js";
import { SIZE_PRESETS, sizeKey, sizeLabel, rangeProblem, rangedWidth, rangedHeight, rangeLabel, RANGE_KEYS } from "./board-size.js";
import { createWidget } from "./board-widget.js";
import { createPanel } from "./board-panel.js";
import { initInteract } from "./board-interact.js";
import { createBoardHistory, restorable } from "./board-history.js";

// The dashboard tab's body: a side panel (worksheets to add) and the 12-column canvas of widgets. Only the ACTIVE
// dashboard renders — leaving it destroys every worksheet view (queries aborted, chart instances and their resize observers
// released), so coming back re-runs each widget (from the result cache when its sheet is unchanged). Widgets are keyed by id:
// a layout change reconciles in place, so adding or removing one never redraws the others.
//
// The dashboard's one selection (Dashboard/dashboard-select.js) lives here: a mark click in a worksheet widget selects its
// value, every other worksheet widget filters to it (where its tables allow), a chip in the bar shows and clears it. It is
// transient — in memory only, never in the workbook — and ends with the dashboard being shown (tab switch, workbook open,
// reload), with its source widget or worksheet, and when the source's primary dimension stops being the selected column.
const PRINT_WIDTH = 1000; // px: the board's width on paper (the page, less margins, at 96 dpi); widgets print stacked, each chart sized to its cell

/** Row height and gap in px from the design tokens (`calc(var(--ctl-h) * 2)`, `var(--s2)`), so the pure layout has no constants. */
function readMetrics() {
  const css = getComputedStyle(document.documentElement);
  const px = (name, fallback) => { const v = parseFloat(css.getPropertyValue(name)); return Number.isFinite(v) ? v : fallback; };
  return { rowH: px("--ctl-h", 32) * 2, gap: px("--s2", 8), pad: px("--s2", 8) };
}

export function initBoard() {
  const $ = (id) => document.getElementById(id);
  const view = $("board-view"), main = $("board-main"), grid = $("board-grid"), empty = $("board-empty");
  if (!view || !main || !grid) return;
  const title = $("board-title"), count = $("board-count"), chip = $("board-filter");
  const results = sharedResults; // the editor's cache: a widget draws what its worksheet tab just ran
  const entries = new Map(); // widget id → createWidget(...)
  let shownId = null;        // the dashboard whose widgets are on screen
  let printing = false;
  let selection = null;      // the dashboard selection { db, table, column, value, label, sourceWidgetId }, or null

  const history = createBoardHistory(); // undo / redo per dashboard id (in memory: a reload or a workbook open starts clean)
  const known = new Set();              // dashboard ids seen, to forget the history of a closed one
  const statusEl = $("board-status");
  let statusTimer = 0;
  /** The last edit's result — "Moved to column 3, row 2", or why a drop snapped back — in a polite live region (and visible). */
  function status(message, refused = false) {
    clearTimeout(statusTimer);
    const span = document.createElement("span"); // a fresh node each time, so an identical message is announced again
    span.textContent = message;
    statusEl.replaceChildren(...(refused ? [icon("warning", { size: 14 }), span] : [span]));
    statusEl.classList.toggle("is-refused", refused);
    statusTimer = setTimeout(() => statusEl.replaceChildren(), 8000);
  }
  /** One committed edit = one undo step. */
  function commit(next) {
    const dash = activeDashboard();
    if (!dash) return;
    history.record(dash.id, dash.widgets);
    setWidgets(dash.id, next); // → dashboard:changed → sync (autosave listens to the same event)
  }
  const nameOf = (w) => entries.get(w.id)?.el.getAttribute("aria-label") ?? (w.kind === "text" ? "Text" : w.kind === "image" ? "Image" : w.kind === "spacer" ? "Spacer" : w.kind === "nav" ? "Button" : "widget");

  const panel = createPanel($("board-panel"), { onAddSheet: (sheetId) => add("sheet", sheetId), onAddText: () => add("text"), onAddImage: (file) => addImage(file), onAddSpacer: () => add("spacer"), onAddNav: () => add("nav"), onDragStart() {}, onDragEnd() {} });

  function teardown() {
    for (const e of entries.values()) { e.destroy(); e.el.remove(); }
    entries.clear();
    shownId = null;
    selection = null; // leaving the dashboard ends its selection
    paintChip();
  }

  // --- the dashboard selection ---
  const syncCross = () => { for (const e of entries.values()) e.syncCross(); };
  function paintChip() {
    chip.replaceChildren();
    toggle(chip, Boolean(selection));
    if (!selection) return;
    const text = document.createElement("span");
    text.className = "board-chip__text";
    text.textContent = chipText(selection); // the value is data: text only
    text.title = selection.label;
    const clear = makeButton("", "iconbtn board-chip__clear");
    clear.append(icon("close", { size: 14 }));
    clear.title = "Clear the dashboard filter";
    clear.setAttribute("aria-label", `Clear the dashboard filter ${selection.label}`);
    clear.addEventListener("click", () => {
      const source = entries.get(selection.sourceWidgetId)?.el;
      setSelection(null);
      status("Dashboard filter cleared.");
      source?.focus({ preventScroll: true }); // the chip is gone: keyboard focus goes back to where the filter came from
    });
    chip.append(icon("filter", { size: 14 }), text, clear);
  }
  function setSelection(next) {
    selection = next;
    paintChip();
    syncCross();
  }
  /** A mark click in a widget: select it, replace the selection, or (the same mark again) clear it. */
  function onMark(widget, field, raw) {
    const refused = selectionRefusal(field);
    if (refused) { status(refused, true); return; }
    const sheet = worksheetById(widget.sheetId)?.sheet;
    const fmt = makeCategoryFormatter(sheet?.format ?? defaultFormat());
    const next = nextSelection(selection, field, raw, (v) => labelOf(metaOf(field), v, fmt), widget.id); // the chip names the member by its label; the value stays raw
    if (next === selection) return; // a null mark: nothing happens
    setSelection(next);
    status(next ? `Filtering the other widgets by ${next.label}.` : "Dashboard filter cleared.");
  }
  /** The selection is only meaningful while its source widget and worksheet exist and still select that column; false = it was dropped (nothing re-run yet). */
  function dropStale(dash) {
    if (!selection) return false;
    const src = dash.widgets.find((w) => w.id === selection.sourceWidgetId);
    const sheet = src ? worksheetById(src.sheetId)?.sheet : null;
    if (sheet && stillValid(selection, sheet)) return false;
    selection = null;
    paintChip();
    return true;
  }

  /** The canvas panel's width less its padding. */
  function panelInner() {
    const scroll = grid.parentElement, css = getComputedStyle(scroll);
    return scroll.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
  }

  function layout() {
    const dash = activeDashboard();
    if (!dash) return;
    const metrics = readMetrics();
    // A fixed dashboard is its box on screen; on paper the same box, scaled down proportionally to fit the page width (never up).
    const k = dash.size && printing ? Math.min(1, PRINT_WIDTH / dash.size.width) : 1;
    const fixed = dash.size ? { width: dash.size.width * k, height: dash.size.height * k } : null;
    // Set the box (or clear it) BEFORE reading clientWidth: leaving a fixed size must measure the panel, not the stale box.
    grid.classList.toggle("is-fixed", Boolean(fixed));
    const range = !fixed && !printing ? dash.range ?? null : null; // an Automatic dashboard may be bounded; a fixed size wins
    grid.classList.toggle("is-ranged", Boolean(range));
    grid.style.width = fixed ? `${fixed.width}px` : "";
    let width = fixed ? fixed.width : printing ? PRINT_WIDTH : grid.clientWidth;
    if (range) { // the box is the panel clamped into the range; widgets fill what is left after the (stable) scrollbar gutter
      const outer = rangedWidth(range, panelInner());
      if (outer > 0) { grid.style.width = `${outer}px`; width = grid.clientWidth; }
    }
    if (!width) return;
    const { height, rects } = layoutBoard(dash.widgets, width, { ...metrics, stack: printing && !fixed, fixed }); // paper: one column in flow, so no widget splits across pages
    if (printing) for (const [id, r] of rects) entries.get(id)?.sizeChart({ width: r.width, height: r.height, chrome: { x: 2 * metrics.pad + 2, y: 2 * metrics.pad + 2 } });
    grid.style.height = `${range ? rangedHeight(range, height) : height}px`;
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
      const e = createWidget(w, { results, onRemove: remove, onSaveText: saveText, onSaveNav: saveNav, ownId: () => activeDashboard()?.id, onMark, onUnselectable: () => status(UNSELECTABLE_NOTE, true), crossFor: (id) => crossFor(selection, id) });
      entries.set(w.id, e);
      grid.append(e.el);
      fresh.push(e);
    }
    const order = widgetOrder(dash.widgets).map((w) => entries.get(w.id).el); // DOM (tab) order = reading order
    const inDom = [...grid.children].filter((n) => n.classList.contains("board-widget"));
    if (order.some((el, i) => inDom[i] !== el)) { // re-appending a focused widget would drop its focus
      const focused = document.activeElement;
      grid.append(...order);
      if (focused && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    }
    toggle(empty, dash.widgets.length === 0);
    layout();
    for (const e of fresh) e.run();
  }

  function sync() {
    const dash = activeDashboard();
    toggle(view, Boolean(dash));
    if (!dash) { teardown(); return; }
    if (shownId !== dash.id) { teardown(); shownId = dash.id; statusEl.replaceChildren(); interact?.cancel(); }
    known.add(dash.id);
    title.textContent = dash.name;
    count.textContent = `${dash.widgets.length} of ${LIMITS.widgets} widgets`;
    panel.render(worksheets());
    paintSize(dash);
    const dropped = dropStale(dash); // its source widget was removed / closed: the others show their own data again
    reconcile(dash);
    if (dropped) syncCross();
    syncUndo(dash);
  }

  function add(kind, sheetId) {
    const dash = activeDashboard();
    if (!dash) return;
    const spot = placeNew(dash.widgets, kind);
    if (!spot.ok) { toast(spot.error, "danger"); return; }
    addWidget(dash, kind, sheetId, spot);
  }

  /** Add a widget at `cell` ({ x, y, w, h }) — from Add (first free spot) or a drop (the cell under the pointer). */
  function addWidget(dash, kind, sheetId, cell, extra = {}) {
    const { x, y, w, h } = cell;
    const widget = kind === "sheet" ? { id: nextWidgetId(), kind, sheetId, x, y, w, h }
      : kind === "text" ? { id: nextWidgetId(), kind, heading: "Text", body: "", x, y, w, h }
      : kind === "nav" ? { id: nextWidgetId(), kind, label: NAV_LABEL, tip: "", target: null, x, y, w, h }
      : { id: nextWidgetId(), kind, ...extra, x, y, w, h }; // image { alt, src } | spacer
    commit([...dash.widgets, widget]);
    toast(`Added “${entries.get(widget.id)?.el.getAttribute("aria-label") ?? "widget"}” to the dashboard.`, "ok"); // polite live region (#toast-live)
    entries.get(widget.id)?.el.scrollIntoView({ block: "nearest" });
  }

  /** Add image: check the file, read it as a data URL (it is saved in the workbook), then place it at the first free spot. */
  function addImage(file) {
    const dash0 = activeDashboard();
    if (!dash0) return;
    const pre = placeNew(dash0.widgets, "image");
    if (!pre.ok) { toast(pre.error, "danger"); return; }
    const checked = validateImageFile(file);
    if (!checked.ok) { toast(checked.error, "danger"); return; }
    const reader = new FileReader();
    reader.onerror = () => toast("That image couldn't be read.", "danger");
    reader.onload = () => {
      const src = String(reader.result);
      const dash = activeDashboard();
      if (!dash) return;
      if (!isImageSrc(src)) { toast("That image couldn't be used. Choose a PNG, JPEG, GIF or WebP file.", "danger"); return; }
      const spot = placeNew(dash.widgets, "image");
      if (!spot.ok) { toast(spot.error, "danger"); return; }
      const over = budgetError(imageChars(dashboards()), src.length);
      if (over) { toast(over, "danger"); return; }
      addWidget(dash, "image", null, spot, { alt: checked.alt, src });
    };
    reader.readAsDataURL(file);
  }

  function remove(widget) {
    const dash = activeDashboard();
    if (!dash) return;
    const ordered = widgetOrder(dash.widgets);
    const at = ordered.findIndex((w) => w.id === widget.id);
    const name = entries.get(widget.id)?.el.getAttribute("aria-label") ?? "widget";
    commit(dash.widgets.filter((w) => w.id !== widget.id));
    toast(`Removed “${name}”. Undo brings it back.`, "info");
    const next = widgetOrder(activeDashboard().widgets)[Math.min(at, dash.widgets.length - 1)];
    (next ? entries.get(next.id)?.el.querySelector(".board-widget__remove") : $("board-panel").querySelector(".board-panel__add-text"))?.focus();
  }

  function saveText(widget, value) {
    const dash = activeDashboard();
    if (!dash) return;
    commit(dash.widgets.map((w) => (w.id === widget.id ? { ...w, ...value } : w)));
    status("Text updated.");
  }

  function saveNav(widget, value) {
    const dash = activeDashboard();
    if (!dash) return;
    commit(dash.widgets.map((w) => (w.id === widget.id ? { ...w, ...value } : w)));
    status("Button updated.");
  }

  // --- undo / redo on the dashboard tab (Dashboard/history.js snapshots of the widget list, keyed by dashboard id) ---
  const undoBtn = makeButton("", "iconbtn board-bar__iconbtn"), redoBtn = makeButton("", "iconbtn board-bar__iconbtn");
  for (const [b, name, label] of [[undoBtn, "undo", "Undo (Ctrl+Z)"], [redoBtn, "redo", "Redo (Ctrl+Y)"]]) { b.append(icon(name, { size: 16 })); b.title = label; b.setAttribute("aria-label", label); }
  function syncUndo(dash) { undoBtn.disabled = !history.canUndo(dash.id); redoBtn.disabled = !history.canRedo(dash.id); }
  function step(which) {
    const dash = activeDashboard();
    if (!dash || !isDashboardActive()) return;
    const target = history[which](dash.id, dash.widgets);
    if (!target) { status(which === "undo" ? "Nothing to undo." : "Nothing to redo."); return; }
    setWidgets(dash.id, restorable(target, (id) => worksheetById(id) !== null)); // a restore is not itself recorded
    status(which === "undo" ? "Undid the last change." : "Redid the change.");
  }
  undoBtn.addEventListener("click", () => step("undo"));
  redoBtn.addEventListener("click", () => step("redo"));
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !isDashboardActive() || view.hidden || interact.dragging) return; // never mid-drag
    if (e.target.closest?.("input, textarea, select, [contenteditable='true'], dialog")) return; // the field's own undo
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); step("undo"); }
    else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); step("redo"); }
  });
  bus.addEventListener("tabs:changed", () => { // a closed dashboard's history goes with it
    const live = new Set(dashboards().map((d) => d.id));
    for (const id of [...known]) if (!live.has(id)) { known.delete(id); history.forget(id); }
  });

  /** Pointer snapping uses the rows as drawn: a fixed dashboard stretches them to its height. */
  function dragMetrics() {
    const m = readMetrics(), dash = activeDashboard();
    return dash?.size ? { ...m, rowH: fixedRowH(dash.widgets, dash.size, m.gap, m.rowH) } : m;
  }
  const interact = initInteract({
    grid, scroll: $("board-scroll"), getDash: activeDashboard, nameOf, metrics: dragMetrics, commit, status,
    addAt(sheetId, cand) { const dash = activeDashboard(); if (dash && worksheetById(sheetId)) addWidget(dash, "sheet", sheetId, cand); },
  });

  bus.addEventListener("dashboard:changed", () => interact.cancelIfGone());

  const runAll = () => { for (const e of entries.values()) e.run(); };
  for (const type of ["view:changed", "tabs:changed", "dashboard:changed"]) bus.addEventListener(type, sync);
  // A worksheet edit while its dashboard is on screen re-runs that sheet's widgets; otherwise the dashboard re-runs on its next show.
  bus.addEventListener("worksheet:changed", (ev) => {
    const dash = activeDashboard();
    if (dash) dropStale(dash); // the source's primary dimension may have changed (no widget runs until the loop below)
    for (const e of entries.values()) { if (e.widget.sheetId === ev.detail?.id) e.run(); else e.syncCross(); }
  });
  // Colours are read at render time: redraw from the result cache (no query) when light / dark or the workbook theme flips.
  for (const type of ["scheme:changed", "theme:changed"]) bus.addEventListener(type, runAll);
  // A parameter's new value reaches a widget through its filters, Top N, calculated fields and reference line: re-plan (the result cache keys on the request, so an unchanged widget costs no query).
  bus.addEventListener("parameters:changed", runAll);
  // After a reload a widget may show a hint before its tables' columns arrive: those (only) run again once they do.
  let columnsTimer = 0;
  bus.addEventListener("entity:loaded", () => { clearTimeout(columnsTimer); columnsTimer = setTimeout(() => { for (const e of entries.values()) e.retryIfBlank(); }, 100); });

  // The canvas width follows its panel: re-lay out on resize (charts re-fit through their own observers — no query).
  let lastWidth = 0, lastPanel = 0;
  const widthObserver = new ResizeObserver(() => {
    const w = grid.clientWidth, p = panelInner();
    if (w === lastWidth && p === lastPanel) return;
    lastWidth = w; lastPanel = p;
    layout();
  });
  widthObserver.observe(grid);
  widthObserver.observe(grid.parentElement); // a fixed box is narrower than its panel: the panel resizing re-fits it

  // Full screen and print apply to the whole canvas.
  const tools = $("board-tools");
  const isFull = () => document.fullscreenElement === main || main.classList.contains("is-presenting");
  const fullBtn = makeButton("", "btn board-bar__btn");
  const syncFull = () => {
    fullBtn.replaceChildren(icon("expand", { size: 14 }), document.createTextNode(isFull() ? "Exit full screen" : "Full screen"));
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
  window.addEventListener("afterprint", () => { printing = false; for (const e of entries.values()) e.sizeChart(null); layout(); });
  syncFull();
  // Size: Automatic fills the panel; a preset fixes the board to that box (a loaded size that is no preset gets its own option).
  const sizeSel = document.createElement("select");
  sizeSel.className = "select board-bar__size";
  sizeSel.setAttribute("aria-label", "Dashboard size");
  sizeSel.addEventListener("change", () => {
    const dash = activeDashboard();
    if (!dash) return;
    const value = sizeSel.value; // read first: each store change below repaints the select
    if (value === "range") {
      setDashboardSize(dash.id, null);
      setDashboardRange(dash.id, dash.range ?? { minWidth: 800, maxWidth: 1280 });
      status(`Size range ${rangeLabel(activeDashboard().range)}.`);
      return;
    }
    setDashboardRange(dash.id, null);
    const pick = value === "auto" ? null : SIZE_PRESETS.concat(dash.size ?? []).find((p) => sizeKey(p) === value) ?? null;
    setDashboardSize(dash.id, pick);
    status(pick ? `Fixed size ${sizeLabel(pick)}.` : "Automatic size.");
  });
  function paintSize(dash) {
    const sizes = [null, ...SIZE_PRESETS];
    const ro = document.createElement("option"); ro.value = "range"; ro.textContent = "Range…";
    if (dash.size && !SIZE_PRESETS.some((p) => sizeKey(p) === sizeKey(dash.size))) sizes.push(dash.size);
    sizeSel.replaceChildren(...sizes.map((p) => { const o = document.createElement("option"); o.value = sizeKey(p); o.textContent = sizeLabel(p); return o; }), ro);
    sizeSel.value = dash.range && !dash.size ? "range" : sizeKey(dash.size);
    paintRange(dash);
  }
  // Range: four optional pixel limits (empty = no limit); an invalid set is refused in place, never clamped.
  const rangeBox = document.createElement("span");
  rangeBox.className = "board-bar__range";
  rangeBox.hidden = true;
  const rangeInputs = {};
  const RANGE_LABELS = { minWidth: "Min width", maxWidth: "Max width", minHeight: "Min height", maxHeight: "Max height" };
  const onRangeChange = () => {
    const dash = activeDashboard();
    if (!dash?.range) return;
    const next = {};
    for (const key of RANGE_KEYS) { const t = rangeInputs[key].value.trim(); if (t !== "") next[key] = Number(t); }
    const problem = rangeProblem(next);
    for (const key of RANGE_KEYS) rangeInputs[key].setAttribute("aria-invalid", problem?.keys.includes(key) ? "true" : "false");
    if (problem) { status(problem.error, true); return; }
    setDashboardRange(dash.id, next);
    status(`Size range ${rangeLabel(next)}.`);
  };
  for (const [what, keys] of [["Width", ["minWidth", "maxWidth"]], ["Height", ["minHeight", "maxHeight"]]]) {
    const grp = document.createElement("span");
    grp.className = "board-bar__rangegrp"; grp.setAttribute("role", "group"); grp.setAttribute("aria-label", `${what} limits`);
    const title = document.createElement("span"); title.className = "board-bar__rangetitle"; title.textContent = what; grp.append(title);
    for (const k of keys) {
      const lab = document.createElement("label"); lab.className = "board-bar__rangelab";
      lab.append(document.createTextNode(k.startsWith("min") ? "Min" : "Max"));
      const inp = document.createElement("input");
      inp.type = "number"; inp.className = "input board-bar__rangein"; inp.setAttribute("aria-label", `${RANGE_LABELS[k]} in pixels`);
      inp.addEventListener("change", onRangeChange);
      rangeInputs[k] = inp; lab.append(inp); grp.append(lab);
    }
    rangeBox.append(grp);
  }
  function paintRange(dash) {
    const on = Boolean(dash.range && !dash.size);
    rangeBox.hidden = !on;
    for (const k of RANGE_KEYS) { rangeInputs[k].value = dash.range?.[k] ?? ""; rangeInputs[k].setAttribute("aria-invalid", "false"); }
  }
  tools.append(sizeSel, rangeBox, undoBtn, redoBtn, fullBtn, printBtn);

  sync();
}
