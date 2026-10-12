import { api } from "../Core/api.js";
import { icon, PATHS } from "../Core/icons.js";
import { wireMenu } from "../Core/menu.js";
import { visibleTools } from "./toolbar-rules.js";
import { toggle, makeButton, toast, fieldError } from "../Core/ui.js";
import { LIMITS } from "../Core/validate.js";
import { aggsFor, checkAdd, checkFilter, viewCounts, statFilters, withCategories, TEXT_VALUE_TYPES } from "./filter-rules.js";
import { entities, relationships, activeDashboard, isModelActive, updateSheet, bus, defaultFormat, defaultMarks } from "../Core/store.js";
import { renderChart as renderSeriesChart, disposeChart, exportChart, hasChartInstance } from "./chart.js";
import { makeValueFormatter, makeCategoryFormatter } from "../Core/format.js";
import { createLatestGate, createResultCache, requestKey, isAbortError, truncationNotice } from "./query-runner.js";

// Tableau-style worksheet: each dashboard is one sheet. Drag fields from the field pane onto the
// Columns (dimension), Rows (measure) and Filters shelves; the chart renders from a bounded,
// identifier-safe query. Fields from *different* tables are joined automatically along the
// relationships drawn in the Data Model (a join path found by BFS over the relationship graph).
const FIELD_MIME = "application/x-ch-field";
// Column category from the Data Model catalog (entity.columns), for filters saved without one.
function categoryOf(db, table, column) {
  try {
    // The worksheet's own column cache is warm by render time (buildFields awaited it); the Data Model's
    // entity columns (loaded asynchronously by the canvas) are the fallback.
    const cached = columnsCache.get(keyOf(db, table))?.find((x) => x.name === column);
    if (cached?.category) return cached.category;
    for (const e of entities.values())
      if (e.db === db && e.table === table) { const c = e.columns?.find((x) => x.name === column); if (c?.category) return c.category; }
  } catch { /* total: an odd catalog just means "unknown" */ }
  return undefined;
}
const FILTER_PLACEHOLDER = { numeric: "number", temporal: "YYYY-MM-DD", boolean: "true or false" };
const OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "between"];
// A filter contributes to the query only when checkFilter() says "ok" (empty = no-op, invalid = not applied).
// Map a client filter to the server QueryFilter shape (value for scalar ops, values for in/between).
const toFilter = (f) => ({ db: f.db, table: f.table, column: f.column, op: f.op, value: f.value ?? "", values: f.values ?? null });
// A field's role can be overridden on its pill (Tableau's convert-to-dimension/measure). Default:
// numeric → measure (aggregated), everything else → dimension (grouped). A numeric field made a
// dimension groups by its raw values; any field made a measure is aggregated (count/countDistinct
// always valid, sum/avg only meaningful for numbers).
const roleOf = (f) => f.role ?? (f.category === "numeric" ? "measure" : "dimension");

// Display name of a measure — matches the server's measure naming (see QueryAsync).
function measureName(f) {
  const a = f.agg ?? "sum";
  if (a === "count") return "count";
  if (a === "countDistinct") return `distinct ${f.column}`;
  return `${a} ${f.column}`;
}
// Stable identity for a pill, so a stored sort target survives re-renders.
const fieldId = (f, kind) => `${kind}:${f.db}.${f.table}.${f.column}:${f.agg ?? ""}`;

// --- marks card + query-shape helpers (P18) --------------------------------
// The canonical query shape lives in planDims()/planMeasures(): buildPlan sends exactly these, and
// renderChart re-derives the same ordering to know which result column is a series vs. a mark channel.
// With no marks set, both reduce to the pre-P18 ordering, so existing charts are byte-identical.
const EMPTY_MARKS = { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null };
const marksOf = (s) => s.marks ?? EMPTY_MARKS;
// Scatter-family types (P11 scatter + P19 square/circle marks): point charts that plot two measures
// and can carry a Shape encoding. They share buildScatter with a symbol override.
const SCATTER_TYPES = new Set(["scatter", "square", "circle"]);
const scatterSymbol = (type) => (type === "square" ? "rect" : type === "circle" ? "circle" : "circle");
const isNumericField = (f) => Boolean(f) && f.category === "numeric";
const sameField = (a, b) => Boolean(a) && Boolean(b) && a.db === b.db && a.table === b.table && a.column === b.column;
// Ordering comparator for Path (P19): numeric when both look numeric, else a locale string compare.
function cmpValues(a, b) {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}
// Colour encoding mode: a numeric Colour field ramps a CONTINUOUS gradient (P18); a categorical one
// splits into DISCRETE series (P7). "none" when the Colour shelf is empty.
function colorMode(sheet) {
  const cf = (sheet.color ?? [])[0];
  if (!cf) return "none";
  return isNumericField(cf) ? "continuous" : "discrete";
}
// Group-by dimensions in SELECT key order: [drill?, rows-dims, cols-dims, Detail-dims, discrete-Color].
// Discrete Colour MUST stay last (renderColorSplit treats the trailing key as the colour value).
function planDims(sheet) {
  const dd = drillActiveDim(sheet);
  const rowDims = [
    ...(dd ? [dd] : []),
    ...sheet.rows.filter((f) => roleOf(f) === "dimension"),
  ];
  const m = marksOf(sheet);
  const detail = m.detail ?? [];
  // Shape (P19): a dimension → distinct point shapes; it's a group-by only on the scatter family.
  const shapeDim = m.shape && SCATTER_TYPES.has(sheet.chartType) ? [m.shape] : [];
  const cf = (sheet.color ?? [])[0];
  const colorDiscrete = cf && colorMode(sheet) === "discrete" && COLOR_USES.has(sheet.chartType) ? [cf] : [];
  const colDims = [
    ...sheet.columns.filter((f) => roleOf(f) === "dimension"),
    ...detail,
    ...shapeDim,
    ...colorDiscrete, // discrete Colour MUST remain the last key (renderColorSplit)
  ];
  return { rowDims, colDims, keyOrder: [...rowDims, ...colDims] };
}
// Measures in SELECT value order, each tagged with its role: "shelf" (a series), "size", "color"
// (continuous gradient) or "aux" (a numeric Label/Tooltip field). Shelf measures come first so their
// aliases (v0,v1,…) and series indices are unchanged from pre-P18. A Table shows only shelf measures.
function planMeasures(sheet) {
  const shelf = [
    ...sheet.columns.filter((f) => roleOf(f) === "measure"),
    ...sheet.rows.filter((f) => roleOf(f) === "measure"),
  ].map((f) => ({ field: f, role: "shelf", agg: f.agg ?? "sum" }));
  if (sheet.chartType === "table") return shelf; // crosstab shows shelf measures only
  const out = [...shelf];
  const m = marksOf(sheet);
  if (isNumericField(m.size)) out.push({ field: m.size, role: "size", agg: m.size.agg ?? "sum" });
  if (colorMode(sheet) === "continuous") { const cf = sheet.color[0]; out.push({ field: cf, role: "color", agg: cf.agg ?? "sum" }); }
  // Numeric Label / Tooltip / Path fields ride along as extra measures so their aggregated value is
  // available per-mark (labels/tooltips read them; Path sorts line vertices by them).
  for (const f of [m.label, m.path, ...(m.tooltip ?? [])]) if (isNumericField(f)) out.push({ field: f, role: "aux", agg: f.agg ?? "sum" });
  return out;
}
const shelfMeasureCount = (sheet) => planMeasures(sheet).filter((e) => e.role === "shelf").length;

// The orderable output columns, in the same order the query selects them: all group-by dimensions
// (planDims key order) as k0,k1,…; then the SHELF measures (planMeasures) as v0,v1,…. Marks-only
// measures (size/colour/aux) aren't offered as sort targets but keep their aliases past the shelf ones.
function sortTargets(sheet) {
  const { keyOrder } = planDims(sheet);
  const shelf = planMeasures(sheet).filter((e) => e.role === "shelf");
  const out = [];
  keyOrder.forEach((f, i) => out.push({ alias: `k${i}`, id: fieldId(f, "dimension"), label: `${f.table}.${f.column}` }));
  shelf.forEach((e, i) => out.push({ alias: `v${i}`, id: fieldId(e.field, "measure"), label: measureName(e.field) }));
  return out;
}
// Chart types (P11). Cartesian bar/stacked/line/area/combo, circular pie/donut, scatter, plus the
// non-ECharts KPI tiles and crosstab Table. Validity per type is enforced in chartIssue().
const CHART_TYPES = [
  ["bar", "Bar"], ["stacked", "Stacked bar"], ["line", "Line"], ["area", "Area"],
  ["pie", "Pie"], ["donut", "Donut"], ["scatter", "Scatter"], ["combo", "Combo (dual-axis)"],
  // P19 point-mark types (square/circle share the scatter path with a symbol override).
  ["square", "Square"], ["circle", "Circle"],
  // P12 statistical types.
  ["heatmap", "Heatmap"], ["treemap", "Treemap"], ["histogram", "Histogram"], ["boxplot", "Box plot"],
  ["kpi", "KPI"], ["text", "Text"], ["table", "Table"],
];
const CHART_LIKE = new Set([
  "bar", "stacked", "line", "area", "pie", "donut", "scatter", "combo", "square", "circle",
  "heatmap", "treemap", "histogram", "boxplot",
]);
// P12 statistical charts that run their OWN single-table endpoint (not /api/query): histogram +
// box plot bypass buildPlan. Heatmap/treemap reuse the normal multi-dimension aggregate query.
const STAT_SINGLE_TABLE = new Set(["histogram", "boxplot"]);
// Chart types that consume a Color dimension (P7 marks). SPLIT types pivot it into one coloured
// series per value; a Table takes it as an extra group-by that renders as a free top-header level.
// Types outside COLOR_USES ignore a Color pill (pie already slices by colour; scatter/combo/KPI
// don't split) — the Color lane shows a note so it's honest, never a silent no-op.
const COLOR_SPLIT_TYPES = new Set(["bar", "stacked", "line", "area"]);
const COLOR_USES = new Set(["bar", "stacked", "line", "area", "table"]);
// Chart types whose marks map 1:1 to a category and so support click-to-filter (P15).
const CLICK_TYPES = new Set(["bar", "stacked", "line", "area", "combo", "pie", "donut", "scatter"]);
// The sheet's primary dimension = the first group-by key (Rows-shelf dims first, then Columns-shelf),
// matching buildPlan()'s key order. A click filters on this dimension's value. When a drill hierarchy
// is active its current level LEADS the group-by (see buildPlan), so it is the primary dimension.
function primaryDim(sheet) {
  const dd = drillActiveDim(sheet);
  if (dd) return dd;
  return [
    ...sheet.rows.filter((f) => roleOf(f) === "dimension"),
    ...sheet.columns.filter((f) => roleOf(f) === "dimension"),
  ][0] ?? null;
}

// --- drill hierarchy (P16) --------------------------------------------------
// A hierarchy is "active" once it has at least two ordered levels; a single level isn't a hierarchy.
function isDrillActive(sheet) { return (sheet.drill?.levels?.length ?? 0) >= 2; }
// The level currently shown (a plain dimension pill descriptor); null when no hierarchy is active.
function drillActiveDim(sheet) {
  if (!isDrillActive(sheet)) return null;
  const d = sheet.drill;
  const lvl = d.levels[Math.min(d.depth, d.levels.length - 1)];
  return { db: lvl.db, table: lvl.table, column: lvl.column, category: lvl.category, role: "dimension" };
}
// Each pinned ancestor becomes a bound-parameter equality filter (same table as the drill → never
// forces a join). Shape matches QueryFilter (value bound as a typed parameter — D6/D16).
function drillPathFilters(sheet) {
  if (!isDrillActive(sheet)) return [];
  const d = sheet.drill;
  const t = d.levels[0]; // all levels share one table
  return (d.path ?? []).map((p) => ({ db: t.db, table: t.table, column: p.column, op: "=", value: String(p.value), values: null }));
}
// P20 Pages: the current member as a bound-parameter equality filter, or null (no pages / not loaded /
// a null member — can't bind `= NULL`). buildPlan applies it only when the pages table is in the query.
function pagesFilter(sheet) {
  const p = sheet.pages;
  if (!p || !Array.isArray(p.members) || !p.members.length) return null;
  const v = p.members[Math.max(0, Math.min(p.index ?? 0, p.members.length - 1))];
  if (v == null) return null;
  return { db: p.db, table: p.table, column: p.column, op: "=", value: String(v), values: null };
}
// Chart orientation, Tableau-style: a dimension on **Rows** (and none on Columns) → **horizontal**
// bars (category down the left, value along the bottom); otherwise **vertical** (the default). Only
// the cartesian bar/stacked/line/area types honour it (combo keeps its dual y-axis vertical).
function chartOrientation(sheet) {
  const rowDims = sheet.rows.filter((f) => roleOf(f) === "dimension").length;
  const colDims = sheet.columns.filter((f) => roleOf(f) === "dimension").length;
  return rowDims > 0 && colDims === 0 ? "horizontal" : "vertical";
}
const keyOf = (db, table) => `${db}\u0000${table}`;
const splitKey = (k) => k.split("\u0000");
const columnsCache = new Map();
let headerAbort = null; // aborts the menus wired during the previous header render
const TYPE_ICONS = { numeric: "type-number", text: "type-text", temporal: "type-date", boolean: "type-bool" };

export function initDashboards() {
  const view = document.getElementById("dashboard-view");
  const fieldsEl = document.getElementById("ws-fields");
  const shelvesEl = document.getElementById("ws-shelves");
  const chartEl = document.getElementById("ws-chart");
  const statusEl = document.getElementById("ws-status");
  if (!view) return;

  // Latest-wins queries + recent results per dashboard: a superseded query is aborted (its answer can
  // never overwrite a newer chart), and presentation-only changes re-render from the cached result
  // instead of re-querying ClickHouse. The Refresh button drops the dashboard's cache and re-queries.
  const gate = createLatestGate();
  const results = createResultCache();

  let formatOpen = false; // whether the Format panel (P10) is expanded — ephemeral UI state
  let openTool = null;    // which toolbar tool's editor panel is open (Color/Size/…/Filters/Drill/Pages), or null
  let pageTimer = null;   // P20 Pages autoplay interval id (transient; never persisted)

  bus.addEventListener("view:changed", sync);
  bus.addEventListener("dashboard:changed", () => { if (!isModelActive()) { renderShelves(); runChart(); } });
  // Safety net: an entity's columns finishing after the first render may be the only source of a
  // restored filter's category — re-render once if any filter is still waiting for one.
  bus.addEventListener("entity:loaded", () => {
    const dash = activeDashboard();
    if (!dash || isModelActive() || !dash.sheet.filters.some((f) => !f.category)) return;
    const missing = dash.sheet.filters.filter((f) => !f.category).length;
    withCategories(dash.sheet.filters, categoryOf);
    if (dash.sheet.filters.filter((f) => !f.category).length < missing) { renderShelves(); runChart(); }
  });
  // chart.js reads colours from :root at render time — redraw when the OS theme flips (a cache hit, no query).
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (!isModelActive()) runChart(); });
  sync();

  async function sync() {
    stopPaging();  // switching view/dashboard halts any running Pages animation
    openTool = null; // close any open tool editor when the view changes
    toggle(view, !isModelActive());
    if (isModelActive()) { gate.cancel(); return; }
    await buildFields();
    renderShelves();
    runChart();
  }
  function stopPaging() { if (pageTimer) { clearInterval(pageTimer); pageTimer = null; } }

  // --- field pane ----------------------------------------------------------
  async function buildFields() {
    fieldsEl.replaceChildren();
    const tables = uniqueTables();
    if (!tables.length) {
      fieldsEl.append(hint("Add tables to the Data Model, then drag their fields onto the shelves."));
      return;
    }
    for (const t of tables) {
      const cols = await columnsFor(t.db, t.table);
      const group = el("details", "ws-table ws-fieldset");
      group.open = true;
      group.append(el("summary", "ws-table__name", `${t.db}.${t.table}`));
      const dims = cols.filter((c) => c.category !== "numeric");
      const meas = cols.filter((c) => c.category === "numeric");
      if (dims.length) { group.append(el("div", "ws-field-group", "Dimensions")); for (const c of dims) group.append(fieldChip(t, c, "dimension")); }
      if (meas.length) { group.append(el("div", "ws-field-group", "Measures")); for (const c of meas) group.append(fieldChip(t, c, "measure")); }
      fieldsEl.append(group);
    }
  }

  function fieldChip(t, col, role) {
    const chip = el("div", `ws-field ws-field--${role}`);
    chip.draggable = true;
    chip.title = `${col.name} · ${col.type}`;
    const payload = { db: t.db, table: t.table, column: col.name, category: col.category };
    const typeIcon = icon(TYPE_ICONS[col.category] ?? "type-other", { size: 14 });
    typeIcon.classList.add("ws-field__type");
    chip.append(typeIcon, el("span", "ws-field__name", col.name));

    // Keyboard/non-drag path (a11y): a focusable plus button adds the field to its natural shelf without
    // dragging — measures to Rows, dimensions to Columns (mirrors the sidebar table chip's plus button).
    const shelfKey = role === "measure" ? "rows" : "columns";
    const shelfLabel = role === "measure" ? "Rows" : "Columns";
    const add = el("button", "ws-field__add");
    add.append(icon("plus", { size: 14 }));
    add.type = "button";
    add.setAttribute("aria-label", `Add ${col.name} to ${shelfLabel}`);
    add.title = `Add to ${shelfLabel}`;
    add.addEventListener("click", () => {
      const dash = activeDashboard();
      if (dash) addField(dash, shelfKey, payload);
    });
    chip.append(add);

    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(FIELD_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copy";
    });
    return chip;
  }

  // --- shelves -------------------------------------------------------------
  function renderShelves() {
    const dash = activeDashboard();
    if (!dash) return;
    const s = dash.sheet;
    withCategories(s.filters, categoryOf);
    // Clean three-tier header (redesign 2). Tier 1 — VIEW BAR: chart type (left); sort · format · export
    // (right). Tier 2 — the two PRIMARY data shelves, **Columns** and **Rows**, always visible at the top.
    // Tier 3 — every other encoding (the Marks channels + Filters/Drill/Pages) as a compact **icon+text
    // toolbar**; clicking a tool opens ONE small editor panel, and a field can be dropped straight onto a
    // tool button. This keeps the header to ~4 short rows so the chart owns the space.
    const viewbar = el("div", "ws-viewbar");
    const vbLeft = el("div", "ws-viewbar__group");
    vbLeft.append(chartTypeToggle(dash, s));
    const vbRight = el("div", "ws-viewbar__group ws-viewbar__group--right");
    headerAbort?.abort(); headerAbort = new AbortController();
    vbRight.append(sortControl(dash, s), formatToggle(), exportControl(dash, s), refreshButton(dash));
    viewbar.append(vbLeft, vbRight);

    const columns = shelf("Columns", "columns", s.columns.map((f, i) => fieldPill(dash, s, "columns", f, i)), (f) => addField(dash, "columns", f));
    const rows = shelf("Rows", "rows", s.rows.map((f, i) => fieldPill(dash, s, "rows", f, i)), (f) => addField(dash, "rows", f));

    const tools = buildTools(dash, s);
    const { visible, more } = visibleTools(s.chartType, tools);
    const toolbar = el("div", "ws-toolbar");
    for (const t of visible) toolbar.append(toolButton(dash, s, t));
    if (more.length) {
      const wrap = el("div", "menu ws-more");
      const btn = el("button", "ws-tool"); btn.type = "button";
      btn.append(icon("more"), el("span", "ws-tool__text", "More"));
      const list = el("div", "menu__list glass"); list.setAttribute("role", "menu"); list.hidden = true;
      for (const t of more) {
        const item = el("button", "menu__item"); item.type = "button"; item.setAttribute("role", "menuitem");
        item.append(icon(t.icon), document.createTextNode(t.label));
        item.addEventListener("click", () => { openTool = t.key; formatOpen = false; renderShelves(); });
        list.append(item);
      }
      wrap.append(btn, list); toolbar.append(wrap);
      wireMenu(btn, list, { signal: headerAbort.signal });
    }

    const children = [viewbar, columns, rows, toolbar];
    const active = tools.find((t) => t.key === openTool);
    if (active) children.push(toolPanel(dash, s, active));   // the one open tool editor
    if (formatOpen) children.push(formatPanel(dash, s));      // P10 format card
    // Active-interaction chips (thin status bars for live drill / pages / click-selection state).
    if (isDrillActive(s)) children.push(drillChip(dash, s));  // P16 breadcrumb + drill-up
    if (s.pages) children.push(pagesControl(dash, s));        // P20 page/animate control
    if (s.selection) children.push(selectionChip(dash, s));   // P15 click-to-filter selection
    shelvesEl.replaceChildren(...children);
  }

  // --- click-to-filter selection chip (P15) --------------------------------
  // Shows the mark the user clicked and lets them apply it as a filter: Keep only (col = value),
  // Exclude (col != value), or clear. Toggling an already-active action returns to a plain highlight.
  function selectionChip(dash, s) {
    const sel = s.selection;
    const wrap = el("div", "ws-select");
    wrap.append(iconSpan("ws-select__icon", "filter"), el("span", "ws-select__label", `Selected: ${sel.label}`));
    const setAction = (a) => { sel.action = sel.action === a ? null : a; commit(dash, s); };
    const btn = (label, a) => {
      const b = makeButton(label, `ws-select__btn${sel.action === a ? " is-active" : ""}`);
      b.setAttribute("aria-pressed", String(sel.action === a));
      b.addEventListener("click", () => setAction(a));
      return b;
    };
    const clear = iconButton("close", "Clear selection");
    clear.addEventListener("click", () => { s.selection = null; commit(dash, s); });
    wrap.append(btn("Keep only", "keep"), btn("Exclude", "exclude"), clear);
    return wrap;
  }

  // --- drill-down hierarchy (P16) ------------------------------------------
  // Drop dimension fields (from one table) onto the Drill-down lane to declare an ordered hierarchy;
  // with ≥2 levels the chart groups by the current level and a click drills one level finer (see
  // selectHandler → drillDown). Each pinned ancestor rides along as a bound-parameter filter.
  function addDrillLevel(dash, f) {
    const s = dash.sheet;
    const d = s.drill ?? (s.drill = { levels: [], depth: 0, path: [] });
    if (d.levels.length && (d.levels[0].db !== f.db || d.levels[0].table !== f.table)) {
      toast("Drill levels must all come from one table.", "info");
      return;
    }
    if (d.levels.some((l) => l.column === f.column)) return; // a level can't repeat
    if (d.levels.length >= LIMITS.drillLevels) {
      toast(`A drill hierarchy can have at most ${LIMITS.drillLevels} levels.`, "info");
      return;
    }
    d.levels.push({ db: f.db, table: f.table, column: f.column, category: f.category });
    d.depth = 0; d.path = []; // redefining the hierarchy resets the descent to the top level
    commit(dash, s);
  }

  // A level pill: ordinal + table.column, removable. Editing the levels resets the descent.
  function drillLevelPill(dash, s, level, i) {
    const remove = () => {
      s.drill.levels.splice(i, 1);
      if (!s.drill.levels.length) s.drill = null;
      else { s.drill.depth = 0; s.drill.path = []; }
      commit(dash, s);
    };
    const p = pill(`${i + 1}. ${level.table}.${level.column}`, remove);
    p.classList.add("ws-pill--drill");
    return p;
  }

  // Breadcrumb + drill-up. Crumb j targets depth j: "All" (top) then each pinned ancestor value; the
  // crumb at the current depth is inert. the Up button ascends one level. Clicking a crumb truncates the path.
  function drillChip(dash, s) {
    const d = s.drill;
    const wrap = el("div", "ws-drill");
    wrap.append(iconSpan("ws-drill__icon", "drill"), el("span", "ws-select__label", "Drill"));
    const crumbs = el("div", "ws-drill__crumbs");
    const labels = ["All", ...(d.path ?? []).map((p) => p.label)];
    labels.forEach((text, j) => {
      if (j) crumbs.append(el("span", "ws-drill__sep", "›"));
      if (j === d.depth) {
        crumbs.append(el("span", "ws-drill__crumb is-current", text));
      } else {
        const b = makeButton(text, "ws-drill__crumb");
        b.addEventListener("click", () => drillTo(d, dash, s, j));
        crumbs.append(b);
      }
    });
    wrap.append(crumbs);
    const showing = d.levels[Math.min(d.depth, d.levels.length - 1)]?.column;
    wrap.append(el("span", "ws-drill__level", `Showing: ${showing}`));
    const up = makeButton("Up", "ws-drill__crumb ws-drill__up");
    up.prepend(icon("chevron", { size: 14 }));
    up.firstChild.classList.add("icon--up");
    up.disabled = d.depth === 0;
    up.setAttribute("aria-label", "Drill up one level");
    up.addEventListener("click", () => drillTo(d, dash, s, d.depth - 1));
    wrap.append(up);
    return wrap;
  }

  // Jump to depth j (clamped): pin values above it stay, the rest are dropped.
  function drillTo(d, dash, s, j) {
    d.depth = Math.max(0, Math.min(j, d.levels.length - 1));
    d.path = (d.path ?? []).slice(0, d.depth);
    commit(dash, s);
  }

  // Descend one level, pinning the clicked value of the current level. A no-op at the finest level.
  function drillDown(rawValue) {
    const dash = activeDashboard();
    if (!dash) return;
    const s = dash.sheet;
    if (!isDrillActive(s)) return;
    const d = s.drill;
    if (d.depth >= d.levels.length - 1) return; // nothing finer to drill into
    const fmtCat = makeCategoryFormatter(s.format ?? defaultFormat());
    d.path = [...(d.path ?? []).slice(0, d.depth), { column: d.levels[d.depth].column, value: rawValue, label: fmtCat(rawValue) }];
    d.depth += 1;
    s.selection = null; // a drill supersedes any P15 mark selection
    commit(dash, s);
  }

  // --- format panel (P10) --------------------------------------------------
  // A collapsible row of presentation controls that never touch the query (except Top-N, which
  // caps the LIMIT). All state lives on sheet.format so it persists for the session (O1).
  // Re-run the query against ClickHouse, bypassing the result cache (data may have changed).
  function refreshButton(dash) {
    const btn = iconButton("refresh", "Refresh");
    btn.classList.add("ws-viewbar__btn");
    btn.title = "Re-run the query against ClickHouse";
    btn.addEventListener("click", () => { results.clear(dash.id); runChart(); });
    return btn;
  }

  function formatToggle() {
    const btn = iconButton("format", "Format");
    btn.className = `iconbtn ws-viewbar__btn${formatOpen ? " is-active" : ""}`;
    btn.title = "Format";
    btn.setAttribute("aria-expanded", String(formatOpen));
    btn.addEventListener("click", () => { formatOpen = !formatOpen; if (formatOpen) openTool = null; renderShelves(); });
    return btn;
  }

  // --- export (P13) --------------------------------------------------------
  // A small menu offering the chart image (PNG/SVG from the live ECharts instance) and the rows behind
  // it as CSV (the bounded, identifier-safe /api/query/export.csv). Image export needs a chart instance
  // (Table/KPI render as native DOM, so it isn't offered there).
  function exportControl(dash, s) {
    const wrap = el("div", "ws-export");
    const btn = iconButton("export", "Export");
    btn.classList.add("ws-viewbar__btn");
    btn.title = "Export";
    const menu = el("div", "ws-export__menu");
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const item = (label, on) => { const b = makeButton(label, "ws-menu-item"); b.setAttribute("role", "menuitem"); b.addEventListener("click", on); return b; };
    menu.append(
      item("PNG image", () => exportImage(dash, s, "png")),
      item("SVG image", () => exportImage(dash, s, "svg")),
      item("CSV data", () => exportCsvRows(dash, s)),
    );
    wireMenu(btn, menu, { signal: headerAbort?.signal }); // click toggles; Esc/outside/item click close; arrows move
    wrap.append(btn, menu);
    return wrap;
  }

  async function exportImage(dash, s, kind) {
    if (!hasChartInstance()) { toast("This view has no chart image to export — switch to a chart type (Table/KPI export as CSV).", "info"); return; }
    try {
      const out = await exportChart(kind);
      if (!out) { toast(kind === "png" ? "Couldn't rasterise the chart — try SVG." : "Nothing to export yet.", "danger"); return; }
      downloadBlob(out.blob, `${exportBaseName(dash)}.${out.ext}`);
    } catch { toast("Image export failed.", "danger"); }
  }

  async function exportCsvRows(dash, s) {
    if (STAT_SINGLE_TABLE.has(s.chartType)) { toast("CSV export isn't available for histogram / box plot yet — export the chart image instead.", "info"); return; }
    const plan = buildPlan(s);
    if (!plan) { toast("Add fields from related tables before exporting.", "info"); return; }
    try {
      const csv = await api.exportCsv(plan);
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${exportBaseName(dash)}.csv`);
    } catch (err) { toast(err.message, "danger"); }
  }

  function formatPanel(dash, s) {
    const f = s.format ?? (s.format = defaultFormat());
    const isChart = CHART_LIKE.has(s.chartType);              // pie/donut/scatter/… get legend etc.
    const hasAxes = isChart && s.chartType !== "pie" && s.chartType !== "donut";
    const canColourByCat = s.chartType === "bar" || s.chartType === "scatter";
    const set = (patch) => { s.format = { ...f, ...patch }; commit(dash, s); };

    const panel = el("div", "ws-format");
    panel.append(el("span", "ws-shelf__label", "Format"));
    // Number/date formats apply to every view (chart, crosstab, KPI).
    panel.append(
      fmtSelect("Number", [["auto", "Auto"], ["compact", "Compact"], ["currency", "Currency"], ["percent", "Percent"]],
        f.numberFormat, (v) => set({ numberFormat: v })),
      fmtSelect("Decimals", [["null", "Auto"], ["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"]],
        f.decimals ?? "null", (v) => set({ decimals: v === "null" ? null : Number(v) })),
      fmtSelect("Dates", [["auto", "Auto"], ["date", "Date"], ["month", "Month"], ["year", "Year"], ["datetime", "Date+time"]],
        f.dateFormat, (v) => set({ dateFormat: v })),
    );
    // Chart-only controls.
    if (isChart) {
      panel.append(
        s.chartType === "histogram"
          ? fmtSelect("Bins", [["5", "5"], ["10", "10"], ["20", "20"], ["50", "50"], ["100", "100"]],
            f.topN ?? 20, (v) => set({ topN: Number(v) }))
          : fmtSelect("Top N", [["null", "All"], ["5", "5"], ["10", "10"], ["20", "20"], ["50", "50"], ["100", "100"]],
            f.topN ?? "null", (v) => set({ topN: v === "null" ? null : Number(v) })),
        fmtSelect("Legend", [["auto", "Auto"], ["hidden", "Hidden"], ["top", "Top"], ["bottom", "Bottom"], ["left", "Left"], ["right", "Right"]],
          f.legend, (v) => set({ legend: v })),
        fmtCheck("Data labels", f.dataLabels, (v) => set({ dataLabels: v })),
      );
      if (canColourByCat)
        panel.append(fmtCheck("Colour by category", f.colorByDimension, (v) => set({ colorByDimension: v })));
      if (hasAxes)
        panel.append(
          fmtText("X title", f.xTitle, (v) => set({ xTitle: v })),
          fmtText("Y title", f.yTitle, (v) => set({ yTitle: v })),
        );
    }
    return panel;
  }

  // Sort control: pick a field to order by (dimensions + measures) and a direction. Default is the
  // first field, ascending. Selecting/​toggling re-runs the query (server ORDER BY).
  function sortControl(dash, s) {
    const wrap = el("div", "ws-sort");
    wrap.append(el("span", "ws-shelf__label", "Sort"));
    const targets = sortTargets(s);
    if (!targets.length) { wrap.append(el("span", "ws-shelf__hint", "add a field")); return wrap; }
    const sel = select(targets.map((t) => t.label), null, "ws-sort__by", "Sort by");
    const current = targets.find((t) => t.id === s.sort?.by) ?? targets[0];
    sel.selectedIndex = targets.indexOf(current);
    sel.addEventListener("change", () => {
      s.sort = { by: targets[sel.selectedIndex].id, dir: s.sort?.dir ?? "asc" };
      commit(dash, s);
    });
    const desc = s.sort?.dir === "desc";
    const dir = iconButton("sort", desc ? "Sorting descending" : "Sorting ascending");
    dir.classList.add("ws-viewbar__btn", "ws-sort__dir");
    dir.append(el("span", "ws-sort__dir-text", desc ? "Desc" : "Asc"));
    dir.setAttribute("aria-label", desc ? "Sorting descending; click for ascending" : "Sorting ascending; click for descending");
    dir.addEventListener("click", () => {
      s.sort = { by: s.sort?.by ?? current.id, dir: desc ? "asc" : "desc" };
      commit(dash, s);
    });
    wrap.append(sel, dir);
    return wrap;
  }

  function shelf(label, kind, pills, onDrop, note) {
    const reorderable = kind === "columns" || kind === "rows"; // only field shelves reorder
    const wrap = el("div", `ws-shelf ws-shelf--${kind}`);
    wrap.append(el("span", "ws-shelf__label", label));
    const zone = el("div", "ws-shelf__zone");
    if (!pills.length) zone.append(el("span", "ws-shelf__hint", "drop a field"));
    for (const p of pills) zone.append(p);
    if (note) zone.append(el("span", "ws-shelf__note", note));
    zone.addEventListener("dragover", (e) => {
      if (hasField(e) || (reorderable && hasPill(e))) { e.preventDefault(); zone.classList.add("is-over"); }
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => {
      zone.classList.remove("is-over");
      // A reorder dropped on empty zone space (not on a pill) appends to the end of this shelf.
      if (reorderable && hasPill(e)) {
        const pl = readPill(e);
        if (pl) { e.preventDefault(); moveField(pl.shelf, pl.index, kind, pills.length); }
        return;
      }
      const field = readField(e);
      if (field) { e.preventDefault(); onDrop(field); }
    });
    wrap.append(zone);
    return wrap;
  }

  function pill(text, onRemove, extra) {
    const p = el("div", "ws-pill");
    p.append(el("span", "ws-pill__text", text));
    if (extra) p.append(extra);
    const x = iconButton("close", "Remove field");
    x.addEventListener("click", onRemove);
    p.append(x);
    return p;
  }
  // A field pill on the Columns/Rows shelves. Its role (dimension vs measure) follows roleOf() but can
  // be flipped with the convert button — so a numeric field can group as a dimension, or a field can be
  // aggregated as a measure. A measure pill shows an aggregation picker (with countDistinct for unique
  // counts); a dimension pill just groups.
  function fieldPill(dash, s, shelfKey, f, i) {
    const label = `${f.table}.${f.column}`;
    const remove = () => { s[shelfKey].splice(i, 1); commit(dash, s); };
    const isMeasure = roleOf(f) === "measure";
    const controls = el("span", "ws-pill__ctl");
    if (isMeasure) {
      const opts = aggsFor(f.category);
      if (f.agg && !opts.includes(f.agg)) {
        toast(`${f.agg} isn't available for ${label}; switched to ${opts[0]}.`, "info");
        f.agg = opts[0]; // keep the screen in step with the query
      }
      const agg = select(opts, f.agg ?? opts[0], "ws-pill__agg", `Aggregation for ${f.table}.${f.column}`);
      agg.addEventListener("change", () => { f.agg = agg.value; commit(dash, s); });
      controls.append(agg);
    }
    // Convert button: → the role it will switch to. Title spells out the effect.
    const conv = iconButton(isMeasure ? "#" : "Σ",
      isMeasure ? "Use as dimension (group by values)" : "Use as measure (aggregate)");
    conv.classList.add("ws-pill__conv");
    conv.addEventListener("click", () => setRole(dash, s, f, isMeasure ? "dimension" : "measure"));
    controls.append(conv);
    const p = pill(label, remove, controls);
    p.classList.add(isMeasure ? "ws-pill--measure" : "ws-pill--dimension");

    // Drag-to-reorder (Columns/Rows). A dedicated grip is the only draggable part, so the agg select /
    // convert / remove controls keep working. Dropping onto this pill inserts the dragged pill before
    // it; the shelf then re-normalises so measures always sit behind dimensions.
    const grip = el("span", "ws-pill__grip", "⠿");
    grip.draggable = true;
    grip.setAttribute("aria-hidden", "true");
    grip.title = "Drag to reorder";
    grip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(PILL_MIME, JSON.stringify({ shelf: shelfKey, index: i }));
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setDragImage(p, 12, 12); } catch { /* older engines */ }
      p.classList.add("is-dragging");
    });
    grip.addEventListener("dragend", () => p.classList.remove("is-dragging"));
    p.prepend(grip);

    p.addEventListener("dragover", (e) => { if (hasPill(e)) { e.preventDefault(); p.classList.add("is-drop-target"); } });
    p.addEventListener("dragleave", () => p.classList.remove("is-drop-target"));
    p.addEventListener("drop", (e) => {
      p.classList.remove("is-drop-target");
      const pl = readPill(e);
      if (pl) { e.preventDefault(); e.stopPropagation(); moveField(pl.shelf, pl.index, shelfKey, i); }
    });
    return p;
  }
  // Move a field pill within/between the Columns & Rows shelves, then enforce the invariant that
  // measures always follow dimensions (normaliseShelf). `toIndex` is the insertion slot in the target.
  function moveField(fromShelf, fromIndex, toShelf, toIndex) {
    if (fromShelf !== "columns" && fromShelf !== "rows") return;
    if (toShelf !== "columns" && toShelf !== "rows") return;
    const dash = activeDashboard();
    if (!dash) return;
    const s = dash.sheet;
    const src = s[fromShelf];
    if (fromIndex < 0 || fromIndex >= src.length) return;
    if (fromShelf !== toShelf && s[toShelf].length >= LIMITS.pillsPerShelf) {
      toast(`The ${toShelf === "columns" ? "Columns" : "Rows"} shelf can hold at most ${LIMITS.pillsPerShelf} fields.`, "info"); return;
    }
    const [moved] = src.splice(fromIndex, 1);
    let ti = toIndex;
    if (fromShelf === toShelf && fromIndex < ti) ti -= 1; // removal shifted later slots left
    ti = Math.max(0, Math.min(ti, s[toShelf].length));
    s[toShelf].splice(ti, 0, moved);
    normaliseShelf(s, fromShelf);
    if (toShelf !== fromShelf) normaliseShelf(s, toShelf);
    commit(dash, s);
  }
  // Reorder a shelf so all dimensions (in their relative order) come before all measures (in theirs) —
  // the baseline rule. Reordering within either group is preserved; a measure dropped among dimensions
  // snaps behind them.
  function normaliseShelf(s, shelfKey) {
    const arr = s[shelfKey];
    s[shelfKey] = [...arr.filter((f) => roleOf(f) === "dimension"), ...arr.filter((f) => roleOf(f) === "measure")];
  }
  // Flip a field between dimension and measure. Becoming a measure gets a sensible default agg
  // (sum for numbers, count otherwise); becoming a dimension drops the agg.
  function setRole(dash, s, f, role) {
    const was = f.role;
    f.role = role;
    const c = viewCounts(s);
    f.role = was;
    if (role === "dimension" ? c.dims > LIMITS.dimensions : c.measures > LIMITS.measures) {
      toast(role === "dimension" ? `A view can group by at most ${LIMITS.dimensions} fields.` : `A view can show at most ${LIMITS.measures} measures.`, "info");
      return;
    }
    f.role = role;
    if (role === "measure") f.agg = f.agg ?? (f.category === "numeric" ? "sum" : "count");
    else delete f.agg;
    // Converting a field can violate dims-before-measures — re-normalise both field shelves.
    normaliseShelf(s, "columns");
    normaliseShelf(s, "rows");
    commit(dash, s);
  }
  // A Color pill (P7 marks): a plain dimension — no aggregation, no role toggle. It splits the chart
  // into one coloured series per distinct value. The shelf holds at most one (Tableau's discrete
  // Color); dropping another replaces it (see addColor).
  function colorPill(dash, s, f, i) {
    const remove = () => { s.color.splice(i, 1); commit(dash, s); };
    // A numeric Colour field reads as a continuous gradient (P18); tag the pill so the label says so.
    const continuous = f.category === "numeric";
    const p = pill(`${f.table}.${f.column}${continuous ? " (gradient)" : ""}`, remove);
    p.classList.add("ws-pill--color");
    if (continuous) p.title = "Continuous colour — a sequential gradient (Bar/Scatter)";
    return p;
  }
  // Filter pill (P14). The operator select drives which value control shows: a single input for the
  // scalar ops, a distinct-values multi-select for `in`, and two bounds for `between`.
  function filterPill(dash, s, f, i) {
    const op = select(OPS, f.op, "ws-pill__op", `Filter operator for ${f.table}.${f.column}`);
    op.addEventListener("change", () => {
      f.op = op.value;
      if (f.op === "in" && !Array.isArray(f.values)) f.values = [];
      if (f.op === "between" && !Array.isArray(f.values)) f.values = ["", ""];
      commit(dash, s); // re-render so the matching value control appears
    });
    const cfg = el("span", "ws-pill__filter");
    cfg.append(op, filterValueControl(dash, s, f));
    const chk = checkFilter(f);
    if (chk.state === "invalid") {
      const inputs = [...cfg.querySelectorAll("input")];
      // For a range, mark the bound that actually failed (a half range blames the empty one).
      const bad = f.op === "between" && inputs.length === 2
        ? (!String(f.values?.[0] ?? "").trim() ? inputs[0] : !String(f.values?.[1] ?? "").trim() ? inputs[1]
          : (checkFilter({ ...f, op: "=", value: f.values[0] }).state === "invalid" ? inputs[0] : inputs[1]))
        : inputs[0];
      if (bad) fieldError(bad, chk.error);
    }
    const p = pill(`${f.table}.${f.column}`, () => { s.filters.splice(i, 1); commit(dash, s); }, cfg);
    p.classList.toggle("ws-pill--invalid", chk.state === "invalid");
    if (chk.state === "invalid") p.prepend(icon("warning", { size: 14 }));
    return p;
  }

  // The value editor for a filter, by operator (P14).
  function filterValueControl(dash, s, f) {
    if (f.op === "in") {
      const sel = el("select", "select select--light ws-pill__in");
      sel.multiple = true; sel.size = 4;
      sel.setAttribute("aria-label", `Values for ${f.table}.${f.column}`);
      const wrap = el("span", "ws-pill__in-wrap");
      wrap.append(sel);
      populateDistinct(sel, f);                // async, cached; preselects f.values
      sel.addEventListener("change", () => { f.values = [...sel.selectedOptions].map((o) => o.value); commit(dash, s); });
      return wrap;
    }
    if (f.op === "between") {
      const wrap = el("span", "ws-pill__range");
      const lo = el("input", "input ws-pill__val"); lo.placeholder = "from"; lo.value = f.values?.[0] ?? "";
      const hi = el("input", "input ws-pill__val"); hi.placeholder = "to"; hi.value = f.values?.[1] ?? "";
      lo.maxLength = hi.maxLength = LIMITS.filterValue;
      if (f.category === "numeric") lo.inputMode = hi.inputMode = "decimal";
      lo.setAttribute("aria-label", `From value for ${f.table}.${f.column}`);
      hi.setAttribute("aria-label", `To value for ${f.table}.${f.column}`);
      const sync = () => { f.values = [lo.value, hi.value]; commit(dash, s); };
      lo.addEventListener("change", sync); hi.addEventListener("change", sync);
      wrap.append(lo, el("span", "ws-pill__range-sep", "–"), hi);
      return wrap;
    }
    const val = el("input", "input ws-pill__val");
    val.value = f.value ?? ""; val.maxLength = LIMITS.filterValue;
    val.placeholder = FILTER_PLACEHOLDER[f.category] ?? "value";
    if (f.category === "numeric") val.inputMode = "decimal";
    val.setAttribute("aria-label", `Value for ${f.table}.${f.column}`);
    val.addEventListener("change", () => { f.value = val.value; commit(dash, s); });
    return val;
  }

  // Fill an `in`-filter multi-select from the column's distinct values (bounded, cached), preselecting
  // whatever is already chosen. Failures degrade to a disabled note rather than an error.
  async function populateDistinct(sel, f) {
    sel.append(new Option("Loading…", ""));
    let note = null; // "first 200" cap note, placed beside the select once it is in the DOM
    try {
      const vals = await distinctFor(f.db, f.table, f.column);
      sel.replaceChildren();
      const chosen = new Set(f.values ?? []);
      for (const v of vals.slice(0, DISTINCT_SHOWN)) {
        const opt = new Option(v == null ? "—" : String(v), v == null ? "" : String(v));
        if (chosen.has(opt.value)) opt.selected = true;
        sel.add(opt);
      }
      if (!vals.length) sel.append(new Option("(no values)", ""));
      if (vals.length > DISTINCT_SHOWN) note = el("p", "ws-note", "Showing the first 200 values — more exist.");
    } catch {
      sel.replaceChildren(new Option("(couldn't load values)", ""));
    }
    if (note && sel.parentNode) sel.parentNode.append(note);
  }
  const DISTINCT_SHOWN = 200, DISTINCT_FETCH = DISTINCT_SHOWN + 1; // ask for one extra to know whether more exist
  const distinctCache = new Map();
  async function distinctFor(db, table, column) {
    const k = `${db}.${table}.${column}`;
    if (!distinctCache.has(k)) {
      try { distinctCache.set(k, await api.distinct(db, table, column, DISTINCT_FETCH)); }
      catch (e) { distinctCache.delete(k); throw e; }
    }
    return distinctCache.get(k);
  }
  function chartTypeToggle(dash, s) {
    const wrap = el("div", "ws-charttype");
    wrap.append(el("span", "ws-shelf__label", "Chart"));
    // A dropdown scales to the P11 type list better than a segmented toggle.
    const sel = el("select", "select select--light ws-charttype__sel");
    sel.setAttribute("aria-label", "Chart type");
    for (const [v, lbl] of CHART_TYPES) {
      const opt = new Option(lbl, v);
      if (s.chartType === v) opt.selected = true;
      sel.add(opt);
    }
    sel.addEventListener("change", () => { s.chartType = sel.value; commit(dash, s); });
    wrap.append(sel);
    return wrap;
  }

  // Drop a field onto Columns/Rows. Default role from type (numeric → measure with sum, else
  // dimension); the pill's convert button can change it. Not allowed twice on the same shelf.
  function addField(dash, shelfKey, f) {
    const list = dash.sheet[shelfKey];
    if (list.some((x) => x.db === f.db && x.table === f.table && x.column === f.column)) return;
    const entry = { db: f.db, table: f.table, column: f.column, category: f.category };
    entry.role = f.category === "numeric" ? "measure" : "dimension";
    if (!allowed(dash, shelfKey, f, entry.role)) return;
    if (entry.role === "measure") entry.agg = "sum";
    list.push(entry);
    normaliseShelf(dash.sheet, shelfKey); // keep dimensions ahead of measures
    commit(dash, dash.sheet);
  }
  // Refuse a drop that would break a shelf or view cap, telling the user why (same style as the filter cap).
  function allowed(dash, slot, f, role) {
    const r = checkAdd(dash.sheet, slot, f, role);
    if (!r.ok) toast(r.error, "info");
    return r.ok;
  }
  function addFilter(dash, f) {
    if (dash.sheet.filters.length >= LIMITS.filters) { toast(`A view can have at most ${LIMITS.filters} filters.`, "info"); return; }
    dash.sheet.filters.push({ db: f.db, table: f.table, column: f.column, category: f.category, op: "=", value: "" });
    commit(dash, dash.sheet);
  }
  // Drop a field onto Color (P7/P18 marks). A categorical field is discrete (group-by → coloured
  // series); a numeric field is continuous (P18 gradient — see colorMode/planMeasures). Capped at one —
  // a second drop replaces the first, matching Tableau's single Colour slot.
  function addColor(dash, f) {
    if (!allowed(dash, "color", f, "dimension")) return;
    dash.sheet.color = [{ db: f.db, table: f.table, column: f.column, category: f.category, role: "dimension" }];
    commit(dash, dash.sheet);
  }

  // --- encodings toolbar (redesign 2) --------------------------------------
  // All non-Columns/Rows encodings live in one compact icon+text toolbar. Each entry is a "tool": a
  // button that (a) is a drop target for a field, and (b) toggles a small editor panel showing/removing
  // its current field(s). Which tools stay visible vs. in "More" is decided by toolbar-rules.js.
  // Everything still feeds the SAME bounded query (planDims/planMeasures) — no new query shape.
  function buildTools(dash, s) {
    const m = s.marks ?? (s.marks = defaultMarks());
    const colorFields = s.color ?? (s.color = []);
    const drillLevels = s.drill?.levels ?? [];
    const one = (field, clear) => (field ? [markPill(field, clear)] : []); // single-field pill list
    return [
      { key: "color", icon: "color", label: "Color", count: colorFields.length,
        pills: colorFields.map((f, i) => colorPill(dash, s, f, i)), onDrop: (f) => addColor(dash, f),
        hint: "Drop a field — categorical = colour series, numeric = gradient",
        note: colorFields.length && colorMode(s) === "discrete" && !COLOR_USES.has(s.chartType)
          ? "Discrete colour needs Bar/Line/Area/Stacked/Table — or drop a numeric field for a gradient." : null },
      { key: "size", icon: "size", label: "Size", count: m.size ? 1 : 0,
        pills: one(m.size, () => { m.size = null; commit(dash, s); }), onDrop: (f) => addSize(dash, f),
        hint: "Drop a numeric field to size the marks (scatter bubbles)" },
      { key: "label", icon: "label", label: "Label", count: m.label ? 1 : 0,
        pills: one(m.label, () => { m.label = null; commit(dash, s); }), onDrop: (f) => addMarkSingle(dash, "label", f),
        hint: "Drop a field to write its value on each mark" },
      { key: "detail", icon: "detail", label: "Detail", count: (m.detail ?? []).length,
        pills: (m.detail ?? []).map((f, i) => markPill(f, () => { m.detail.splice(i, 1); commit(dash, s); })), onDrop: (f) => addMarkList(dash, "detail", f),
        hint: "Drop dimensions to add mark granularity (no visual channel)" },
      { key: "tooltip", icon: "tooltip", label: "Tooltip", count: (m.tooltip ?? []).length,
        pills: (m.tooltip ?? []).map((f, i) => markPill(f, () => { m.tooltip.splice(i, 1); commit(dash, s); })), onDrop: (f) => addMarkList(dash, "tooltip", f),
        hint: "Drop fields to list in each mark's tooltip" },
      { key: "shape", icon: "shape", label: "Shape", count: m.shape ? 1 : 0,
        pills: one(m.shape, () => { m.shape = null; commit(dash, s); }), onDrop: (f) => addShape(dash, f),
        hint: "Drop a categorical field for per-value point symbols (scatter)",
        note: m.shape && !SCATTER_TYPES.has(s.chartType) ? "Shape encodes Scatter / Square / Circle points." : null },
      { key: "path", icon: "path", label: "Path", count: m.path ? 1 : 0,
        pills: one(m.path, () => { m.path = null; commit(dash, s); }), onDrop: (f) => addMarkSingle(dash, "path", f),
        hint: "Drop a field to order a line/area's vertices" },
      { key: "angle", icon: "angle", label: "Angle", count: m.angle ? 1 : 0,
        pills: one(m.angle, () => { m.angle = null; commit(dash, s); }), onDrop: (f) => addAngle(dash, f),
        hint: "A radial magnitude — pie already maps its measure to angle" },
      { key: "filters", icon: "filter", label: "Filters", count: s.filters.length,
        pills: s.filters.map((f, i) => filterPill(dash, s, f, i)), onDrop: (f) => addFilter(dash, f),
        hint: "Drop a field to filter the view by it" },
      { key: "drill", icon: "drill", label: "Drill", count: drillLevels.length,
        pills: drillLevels.map((f, i) => drillLevelPill(dash, s, f, i)), onDrop: (f) => addDrillLevel(dash, f),
        hint: "Drop ≥2 same-table fields to build a drill hierarchy (year → quarter → month)",
        note: drillLevels.length === 1 ? "Add another same-table field to drill." : null },
      { key: "pages", icon: "pages", label: "Pages", count: s.pages ? 1 : 0,
        pills: s.pages ? [pagesPill(dash, s)] : [], onDrop: (f) => addPages(dash, f),
        hint: "Drop a dimension to step/animate the view through its members" },
    ];
  }

  // A toolbar button: icon + short text, a count badge when it holds field(s), and drop-target + click.
  function toolButton(dash, s, tool) {
    const set = tool.count > 0;
    const btn = el("button", `ws-tool${openTool === tool.key ? " is-active" : ""}${set ? " is-set" : ""}`);
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(openTool === tool.key));
    btn.setAttribute("aria-label", `${tool.label}${set ? ` (${tool.count} field${tool.count > 1 ? "s" : ""})` : " (empty)"}`);
    btn.title = tool.hint || tool.label;
    btn.append(icon(tool.icon), el("span", "ws-tool__text", tool.label));
    if (set) btn.append(el("span", "ws-tool__badge", String(tool.count)));
    btn.addEventListener("click", () => { openTool = openTool === tool.key ? null : tool.key; formatOpen = false; renderShelves(); });
    btn.addEventListener("dragover", (e) => { if (hasField(e)) { e.preventDefault(); btn.classList.add("is-over"); } });
    btn.addEventListener("dragleave", () => btn.classList.remove("is-over"));
    btn.addEventListener("drop", (e) => {
      btn.classList.remove("is-over");
      const f = readField(e);
      if (f) { e.preventDefault(); openTool = tool.key; tool.onDrop(f); } // set open BEFORE onDrop's commit re-renders
    });
    return btn;
  }

  // The editor panel for the open tool: a card with its current field pills over a drop zone (+ note).
  function toolPanel(dash, s, tool) {
    const panel = el("div", "ws-toolpanel");
    const head = el("div", "ws-toolpanel__head");
    const title = el("span", "ws-toolpanel__title");
    title.append(icon(tool.icon), ` ${tool.label}`);
    head.append(title);
    const close = iconButton("close", "Close editor");
    close.addEventListener("click", () => { openTool = null; renderShelves(); });
    head.append(close);
    panel.append(head);
    const zone = el("div", "ws-toolpanel__zone");
    if (!tool.pills.length) zone.append(el("span", "ws-shelf__hint", tool.hint || "Drag a field here"));
    for (const p of tool.pills) zone.append(p);
    wireFieldDrop(zone, tool.onDrop);
    panel.append(zone);
    if (tool.note) panel.append(el("span", "ws-shelf__note", tool.note));
    return panel;
  }

  // Wire a zone as a field-only drop target (no pill reorder). Shared by the tool panel.
  function wireFieldDrop(zone, onDrop) {
    zone.addEventListener("dragover", (e) => { if (hasField(e)) { e.preventDefault(); zone.classList.add("is-over"); } });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => { zone.classList.remove("is-over"); const f = readField(e); if (f) { e.preventDefault(); onDrop(f); } });
  }
  // A marks-encoding pill: table.column + a remove button, tinted as a marks pill.
  function markPill(f, remove) {
    const p = pill(`${f.table}.${f.column}`, remove);
    p.classList.add("ws-pill--mark");
    return p;
  }
  // Size takes one NUMERIC field (it scales the mark — a bubble); non-numeric is nudged away.
  function addSize(dash, f) {
    if (f.category !== "numeric") { toast("Size needs a numeric field (it scales the mark).", "info"); return; }
    if (!allowed(dash, "size", f)) return;
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    m.size = { db: f.db, table: f.table, column: f.column, category: f.category, agg: "sum" };
    commit(dash, dash.sheet);
  }
  // Label holds one field of any kind (numeric → its aggregate; categorical → its grouped value).
  function addMarkSingle(dash, key, f) {
    if (!allowed(dash, key, f)) return;
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    m[key] = { db: f.db, table: f.table, column: f.column, category: f.category, ...(f.category === "numeric" ? { agg: "sum" } : {}) };
    commit(dash, dash.sheet);
  }
  // Detail / Tooltip hold a list of fields (no duplicates). Detail adds group-by granularity.
  function addMarkList(dash, key, f) {
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    const list = m[key] ?? (m[key] = []);
    if (list.some((x) => sameField(x, f))) return;
    if (!allowed(dash, key, f)) return;
    list.push({ db: f.db, table: f.table, column: f.column, category: f.category, ...(f.category === "numeric" ? { agg: "sum" } : {}) });
    commit(dash, dash.sheet);
  }
  // Shape (P19) takes one CATEGORICAL field (distinct point symbols); numeric is nudged away.
  function addShape(dash, f) {
    if (f.category === "numeric") { toast("Shape needs a categorical field (each value gets its own symbol).", "info"); return; }
    if (!allowed(dash, "shape", f)) return;
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    m.shape = { db: f.db, table: f.table, column: f.column, category: f.category };
    commit(dash, dash.sheet);
  }
  // Angle (P19) takes one NUMERIC field (a radial magnitude — pie already maps its measure to angle).
  function addAngle(dash, f) {
    if (f.category !== "numeric") { toast("Angle needs a numeric field (it drives a radial magnitude).", "info"); return; }
    const m = dash.sheet.marks ?? (dash.sheet.marks = defaultMarks());
    m.angle = { db: f.db, table: f.table, column: f.column, category: f.category, agg: "sum" };
    commit(dash, dash.sheet);
  }

  // --- Pages shelf (P20) ---------------------------------------------------
  // One dimension whose members the view steps/animates through, one at a time. Each page is a
  // bound-parameter `=` filter on the current member (the P14 path); members come from the bounded
  // distinct-values query (shared with the `in` filter). Autoplay is suppressed under reduced-motion.
  function addPages(dash, f) {
    stopPaging();
    dash.sheet.pages = { db: f.db, table: f.table, column: f.column, category: f.category, index: 0 };
    commit(dash, dash.sheet);
  }
  function pagesPill(dash, s) {
    const remove = () => { stopPaging(); s.pages = null; commit(dash, s); };
    const p = pill(`${s.pages.table}.${s.pages.column}`, remove);
    p.classList.add("ws-pill--mark");
    return p;
  }
  // Load the member list once (bounded, cached), store it on the pages state, then re-render/re-run so
  // the page filter applies. Failures leave members = [] (the control shows a note; view stays unfiltered).
  async function ensurePagesMembers(dash, s) {
    const p = s.pages;
    if (!p || Array.isArray(p.members)) return;
    p.members = []; // in-flight guard against re-entry
    try {
      const vals = await distinctFor(p.db, p.table, p.column);
      if (dash.sheet.pages === p) {
        p.more = vals.length > DISTINCT_SHOWN;
        p.members = vals.slice(0, DISTINCT_SHOWN); p.index = Math.min(p.index ?? 0, Math.max(0, p.members.length - 1)); commit(dash, s);
      }
    } catch (err) { p.loadError = `Couldn't load members: ${err.message}`; if (dash.sheet.pages === p) commit(dash, s); }
  }
  // The page control: current member + count, ◀ ▶ step (wrapping), and Play/Pause. Play is omitted
  // under prefers-reduced-motion (done-when: no autoplay when reduced motion is set).
  function pagesControl(dash, s) {
    const p = s.pages;
    const wrap = el("div", "ws-pages");
    wrap.append(el("span", "ws-pages__icon", "▤"), el("span", "ws-select__label", `Page: ${p.column}`));
    if (!Array.isArray(p.members)) { wrap.append(el("span", "ws-shelf__hint", "loading members…")); ensurePagesMembers(dash, s); return wrap; }
    if (!p.members.length) { wrap.append(el("span", "ws-shelf__hint", p.loadError ?? "couldn't load members")); return wrap; }

    const n = p.members.length;
    const idx = Math.max(0, Math.min(p.index ?? 0, n - 1));
    const cur = p.members[idx];
    const step = (d) => { stopPaging(); p.index = (idx + d + n) % n; commit(dash, s); };
    const prev = makeButton("◀", "ws-pages__btn"); prev.setAttribute("aria-label", "Previous page"); prev.addEventListener("click", () => step(-1));
    const next = makeButton("▶", "ws-pages__btn"); next.setAttribute("aria-label", "Next page"); next.addEventListener("click", () => step(1));
    wrap.append(prev, el("span", "ws-pages__member", `${cur == null ? "—" : cur}  ·  ${idx + 1}/${n}`), next);
    if (p.more) wrap.append(el("p", "ws-note", "Showing the first 200 values — more exist."));

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) {
      const playing = Boolean(pageTimer);
      const play = makeButton(playing ? "❚❚ Pause" : "▶ Play", `ws-pages__btn${playing ? " is-active" : ""}`);
      play.setAttribute("aria-pressed", String(playing));
      play.addEventListener("click", () => {
        if (pageTimer) { stopPaging(); commit(dash, s); return; }
        pageTimer = setInterval(() => {
          const pg = dash.sheet.pages;
          if (!pg || !Array.isArray(pg.members) || !pg.members.length) { stopPaging(); return; }
          pg.index = ((pg.index ?? 0) + 1) % pg.members.length;
          commit(dash, s);
        }, 1500);
        commit(dash, s);
      });
      wrap.append(play);
    }
    return wrap;
  }
  const commit = (dash, sheet) => updateSheet(dash.id, sheet); // → dashboard:changed → renderShelves + runChart

  // --- chart ---------------------------------------------------------------
  async function runChart() {
    const dash = activeDashboard();
    if (!dash) return;
    const ticket = gate.begin(); // aborts any in-flight query for the previous state
    disposeChart(); // tear down any live ECharts instance before we repaint the chart pane
    const s = dash.sheet;
    withCategories(s.filters, categoryOf);
    const filterNote = invalidFilterNotice(s);
    setNotice(filterNote);
    // P12 statistical charts that run their own single-table endpoint (histogram / box plot).
    if (STAT_SINGLE_TABLE.has(s.chartType)) { await runStatChart(dash, s, ticket, filterNote); return; }
    const colorInPlay = s.color?.length && COLOR_USES.has(s.chartType);
    const drillInPlay = isDrillActive(s); // a hierarchy alone can drive a view (implicit count on the level)
    const m = s.marks ?? {};
    const marksInPlay = Boolean(m.detail?.length || m.size || m.label || m.tooltip?.length || m.shape || m.path || m.angle || s.color?.length); // P18/P19
    if (!s.columns.length && !s.rows.length && !colorInPlay && !drillInPlay && !marksInPlay) {
      chartEl.replaceChildren(hint("Drag fields onto Columns and Rows to build a chart — categorical fields group, numeric fields aggregate."));
      return;
    }
    const plan = buildPlan(s);
    if (!plan) {
      chartEl.replaceChildren(warn("These fields come from tables with no relationship between them — draw one in the Data Model."));
      return;
    }
    const result = await fetchCached(dash, ticket, requestKey("query", plan), (signal) => api.query(plan, { signal }));
    if (!result) return;
    try {
      renderChart(s, result);
      setNotice(joinNotices(filterNote, truncationNotice({ truncated: result.truncated, chartType: s.chartType, limit: Math.min(plan.limit ?? 50, 500) })));
    } catch (err) {
      console.error(err);
      chartEl.replaceChildren(warn("This view couldn't be drawn — try another chart type or remove a field."));
    }
  }

  // Status-line helpers: invalid filters are skipped by the query, so say so; notices join with " · ".
  const joinNotices = (...parts) => parts.filter(Boolean).join(" · ") || null;
  function invalidFilterNotice(sheet) {
    const n = sheet.filters.filter((f) => checkFilter(f).state === "invalid").length;
    return n ? `${n} filter${n === 1 ? "" : "s"} not applied — fix the highlighted value.` : null;
  }

  // Serve a request from the dashboard's result cache, or run it under the latest-wins ticket.
  // Resolves to the result, or null when the request was superseded (silently) or failed (the error
  // is shown in the chart pane).
  async function fetchCached(dash, ticket, key, run) {
    const cached = results.get(dash.id, key);
    if (cached) return cached;
    chartEl.replaceChildren(el("div", "ws-loading", "Loading…"));
    try {
      const result = await run(ticket.signal);
      if (!ticket.isCurrent()) return null;
      results.set(dash.id, key, result);
      return result;
    } catch (err) {
      if (!ticket.isCurrent() || isAbortError(err)) return null;
      chartEl.replaceChildren(warn(err.message));
      return null;
    }
  }

  // The status line between the shelves and the chart (e.g. "Showing the top 50 — more exist").
  function setNotice(text) {
    if (!statusEl) return;
    statusEl.replaceChildren(...(text ? [icon("info", { size: 14 }), ` ${text}`] : []));
    toggle(statusEl, Boolean(text));
  }

  // P12 histogram / box plot: single-table distribution charts. Histogram buckets one numeric column;
  // a box plot summarises one numeric measure, optionally grouped by one same-table dimension. They
  // use their own endpoints (a bucketing / quantile query shape), so they read fields directly rather
  // than through buildPlan. All fields must live on ONE table (the endpoints don't join).
  async function runStatChart(dash, s, ticket, filterNote = null) {
    const allFields = [...s.columns, ...s.rows];
    const numeric = allFields.find((f) => f.category === "numeric");
    if (!numeric) {
      chartEl.replaceChildren(hint(`${s.chartType === "histogram" ? "A histogram" : "A box plot"} needs a numeric field — add one to Columns or Rows.`));
      return;
    }
    const { db, table } = numeric;
    // Only same-table, usable filters apply (the single-table endpoints take in/between too);
    // the rest are counted and reported in the notice.
    const { apply: filters, ignored } = statFilters(s.filters, db, table);
    const kind = s.chartType === "histogram" ? "histogram" : "box plot";
    const ignoredNote = ignored > 0 ? `${ignored} filter${ignored === 1 ? "" : "s"} on other tables ${ignored === 1 ? "doesn't" : "don't"} apply to a ${kind}.` : null;

    if (s.chartType === "histogram") {
      // Reuse Top-N as the bucket count when set (else the server default); server clamps 1..100.
      const req = { column: numeric.column, buckets: s.format?.topN ?? null, filters };
      const result = await fetchCached(dash, ticket, requestKey("histogram", { db, table, req }),
        (signal) => api.histogram(db, table, req, { signal }));
      if (!result) return;
      if (!result.bins?.length) { chartEl.replaceChildren(hint("No data for this field.")); setNotice(joinNotices(filterNote, ignoredNote)); return; }
      chartEl.replaceChildren();
      renderSeriesChart(chartEl, { type: "histogram", bins: result.bins, format: s.format ?? defaultFormat() });
      setNotice(joinNotices(filterNote, ignoredNote));
    } else {
      // Box plot: group by the first same-table dimension, if any.
      const dim = allFields.find((f) => f.category !== "numeric" && f.db === db && f.table === table);
      const req = { dimension: dim ? dim.column : null, measure: numeric.column, filters, limit: s.format?.topN ?? null };
      const result = await fetchCached(dash, ticket, requestKey("boxplot", { db, table, req }),
        (signal) => api.boxplot(db, table, req, { signal }));
      if (!result) return;
      if (!result.groups?.length) { chartEl.replaceChildren(hint("No data for this field.")); setNotice(joinNotices(filterNote, ignoredNote)); return; }
      chartEl.replaceChildren();
      renderSeriesChart(chartEl, { type: "boxplot", boxes: result.groups, format: s.format ?? defaultFormat() });
      setNotice(joinNotices(filterNote, ignoredNote, truncationNotice({ truncated: result.truncated, chartType: "boxplot", limit: Math.min(req.limit ?? 50, 500) })));
    }
  }

  function buildPlan(sheet) {
    // Fields split by shelf AND type. Categorical pills are dimensions: Rows-shelf ones become the
    // crosstab's left stub, Columns-shelf ones the top header. Numeric pills are measures (the cell
    // values); we send them column-shelf-first then row-shelf-first so the result's measure order
    // lines up with measureAxis() at render time (the shelf decides where the measure band sits).
    const toDim = (f) => ({ db: f.db, table: f.table, column: f.column });
    // P16 drill + P18 marks fold into the canonical query shape (planDims/planMeasures): the drill level
    // and any Detail dims are group-bys; Size / continuous-Colour / numeric Label+Tooltip are measures.
    const { rowDims, colDims, keyOrder } = planDims(sheet);
    const rowDimensions = rowDims.map(toDim);
    const columnDimensions = colDims.map(toDim);
    const mplan = planMeasures(sheet);
    const measures = mplan.map((e) => ({ db: e.field.db, table: e.field.table, column: e.field.column, agg: e.agg }));

    const involved = [];
    const add = (ref) => { if (ref) { const k = keyOf(ref.db, ref.table); if (!involved.includes(k)) involved.push(k); } };
    keyOrder.forEach(add); mplan.forEach((e) => add(e.field)); sheet.filters.forEach(add);
    if (!involved.length) return null;
    const base = involved[0];
    const joins = buildJoins(base, involved.slice(1));
    if (joins === null) return null;
    const [db, table] = splitKey(base);
    // P15: a click selection with an action (keep/exclude) becomes a bound-parameter filter — but only
    // when its table is already in the query (the selected dimension is on a shelf), so it never forces
    // an unresolved join. keep → `col = value`, exclude → `col != value`.
    const sel = sheet.selection;
    const selFilters = (sel && sel.action && sel.value != null && involved.includes(keyOf(sel.db, sel.table)))
      ? [{ db: sel.db, table: sel.table, column: sel.column, op: sel.action === "keep" ? "=" : "!=", value: String(sel.value), values: null }]
      : [];
    // P20 pages: the current member as a bound `=` filter, only when its table is already in the query.
    const pf = pagesFilter(sheet);
    const pageFilters = (pf && involved.includes(keyOf(pf.db, pf.table))) ? [pf] : [];
    // Resolve the sort selection to a SELECT alias (k{n}/v{n}); default = first field, ascending.
    const targets = sortTargets(sheet);
    let sortColumn = targets.length ? targets[0].alias : "v0";
    if (sheet.sort && sheet.sort.by) {
      const t = targets.find((x) => x.id === sheet.sort.by);
      if (t) sortColumn = t.alias;
    }
    return {
      from: { db, table },
      joins,
      rowDimensions,
      columnDimensions,
      measures,
      // ...plus P16 drill (each pinned ancestor as a bound `=` filter) and P20 pages (the current
      // member as a bound `=` filter, only when its table is already in the query — never forces a join).
      filters: [...sheet.filters.filter((f) => checkFilter(f).state === "ok").map(toFilter), ...selFilters, ...drillPathFilters(sheet), ...pageFilters],
      // Top-N (P10): a chart caps categories via the query LIMIT (server sorts, then limits);
      // the table shows the full bounded set. Server re-clamps to 1..500 regardless.
      limit: sheet.chartType === "table" ? 500 : (sheet.format?.topN ?? 50),
      sort: { column: sortColumn, desc: sheet.sort?.dir === "desc" },
    };
  }

  // Join path over the relationship graph: connect every involved table back to the base.
  function buildJoins(baseKey, targets) {
    if (!targets.length) return [];
    const graph = relationshipGraph();
    const included = new Set([baseKey]);
    const joins = [];
    for (const target of targets) {
      if (included.has(target)) continue;
      const path = bfs(graph, included, target);
      if (!path) return null;
      for (const edge of path) {
        if (!included.has(edge.to.key)) {
          joins.push({ left: col(edge.from), right: col(edge.to) });
          included.add(edge.to.key);
        }
      }
    }
    return joins;
  }
  function relationshipGraph() {
    const g = new Map();
    const link = (a, b) => {
      if (!g.has(a.key)) g.set(a.key, []);
      g.get(a.key).push({ from: a, to: b });
    };
    for (const rel of relationships.values()) {
      const fe = entities.get(rel.from.entityId), te = entities.get(rel.to.entityId);
      if (!fe || !te) continue;
      const a = { key: keyOf(fe.db, fe.table), db: fe.db, table: fe.table, column: rel.from.column };
      const b = { key: keyOf(te.db, te.table), db: te.db, table: te.table, column: rel.to.column };
      if (a.key === b.key) continue;
      link(a, b); link(b, a);
    }
    return g;
  }
  function bfs(graph, included, target) {
    const queue = [...included].map((k) => ({ key: k, path: [] }));
    const seen = new Set(included);
    while (queue.length) {
      const { key, path } = queue.shift();
      for (const edge of graph.get(key) ?? []) {
        if (seen.has(edge.to.key)) continue;
        const next = [...path, edge];
        if (edge.to.key === target) return next;
        seen.add(edge.to.key);
        queue.push({ key: edge.to.key, path: next });
      }
    }
    return null;
  }
  const col = (node) => ({ db: node.db, table: node.table, column: node.column });

  // result = { rowDimensions:[name…], columnDimensions:[name…], measures:[name…],
  //            rows:[{ keys:[rowVals…, colVals…], values:[…] }] }
  function renderChart(sheet, result) {
    chartEl.replaceChildren();
    const { rowDimensions, columnDimensions, measures, rows } = result;
    if (!rows.length) { chartEl.append(hint("No data for these fields.")); return; }
    // P10 formatters: measure values + date-like dimension labels, from the sheet's format config.
    const format = sheet.format ?? defaultFormat();
    const fmtVal = makeValueFormatter(format);
    const fmtCat = makeCategoryFormatter(format);
    const type = sheet.chartType;
    // Min/Max of a text or date field comes back as text — only Table, Text and KPI can show that.
    if (!TEXT_VALUE_TYPES.has(type) && rows.some((r) => r.values.some((v) => typeof v === "string"))) {
      chartEl.replaceChildren(hint("Min/Max of a text or date field shows as Table, Text or KPI — switch the chart type, or use Count."));
      return;
    }
    // Table + P19 Text mark both render as the crosstab text grid (values written into cells).
    if (type === "table" || type === "text") { chartEl.append(crosstabTable(sheet, result, fmtVal, fmtCat)); return; }

    // P18 marks: re-derive the measure roles so size / continuous-colour / aux columns don't turn into
    // spurious series. Shelf measures (only) become series; the rest feed the mark channels below.
    const mplan = planMeasures(sheet);
    const seriesIdx = mplan.map((e, i) => (e.role === "shelf" ? i : -1)).filter((i) => i >= 0);
    const sizeIdx = mplan.findIndex((e) => e.role === "size");
    const colorMeasureIdx = mplan.findIndex((e) => e.role === "color");
    const shelfCount = seriesIdx.length;

    // Discrete Colour (P7): a categorical Colour dimension pivots the trailing group-by key into one
    // series per distinct value (bar → grouped, stacked → stacked, line/area → one per value).
    if (colorMode(sheet) === "discrete" && COLOR_SPLIT_TYPES.has(type)) {
      if (shelfCount !== 1) {
        chartEl.append(hint("Colour splits a single measure across series — use exactly one measure, or remove the Colour field."));
        return;
      }
      renderColorSplit(type, result, format, fmtCat);
      return;
    }

    // P11: an unsupported field mapping shows a hint, never an error (the done-when).
    const issue = chartIssue(type, rowDimensions.length + columnDimensions.length, shelfCount);
    if (issue) { chartEl.append(hint(issue)); return; }

    // P19 Shape: on the scatter family, split points by a Shape dimension into one symbol per value.
    if (SCATTER_TYPES.has(type) && marksOf(sheet).shape) { renderScatterShapes(sheet, result, seriesIdx, sizeIdx, format, fmtVal, fmtCat); return; }

    // P19 Path: a line/area orders its vertices by the Path field's value (not the category order).
    const usePath = type === "line" || type === "area";
    const rowsOrdered = usePath ? (pathOrderedRows(sheet, result, mplan) ?? rows) : rows;

    // Flatten both dimension axes onto the category axis; one series per SHELF measure (P7 layout).
    const dimCount = rowDimensions.length + columnDimensions.length;
    const categories = rowsOrdered.map((r) => r.keys.map((k) => (k == null ? "—" : fmtCat(k))).join(" / "));
    const series = seriesIdx.map((mi) => ({ name: measures[mi], data: rowsOrdered.map((r) => r.values[mi]) }));
    const seriesNames = seriesIdx.map((mi) => measures[mi]);

    // P12 heatmap/treemap reuse this multi-dimension result but pivot it differently.
    if (type === "heatmap") { renderHeatmap(result, format, fmtCat, fmtVal); return; }
    if (type === "treemap") { renderTreemap(result, format, fmtCat); return; }

    // KPI: explicit type, or a plain series chart with no dimensions (one value per measure).
    if (type === "kpi" || (dimCount === 0 && (type === "bar" || type === "stacked" || type === "line" || type === "area"))) {
      chartEl.append(kpiView(seriesNames, categories, series, dimCount, fmtVal));
      return;
    }
    // P18 mark channels: Size (bubble), continuous Colour (gradient), field-driven Label + custom
    // Tooltip. All read columns already in `result`; missing/unsupported mappings degrade to a note.
    const marks = marksChannels(sheet, result, mplan, sizeIdx, colorMeasureIdx, fmtVal, fmtCat, rowsOrdered);
    if (marks.note) chartEl.append(hint(marks.note)); // a Marks hint sits above the chart, never blocks it
    // P15 click-to-filter: marks map 1:1 to result rows here, so a click's dataIndex → rowsOrdered[i].keys[0]
    // (the primary dimension's raw value).
    const onSelect = selectHandler(sheet, primaryDim(sheet), type, rowsOrdered.map((r) => r.keys[0]));
    renderSeriesChart(chartEl, { type, symbol: SCATTER_TYPES.has(type) ? scatterSymbol(type) : undefined, categories, series, format, onSelect, orientation: chartOrientation(sheet), ...marks.spec });
  }

  // P19 Path: order rows by the Path field's value — a group-by dimension's key or a numeric measure.
  // Returns a reordered copy, or null when no Path field is set / it isn't in the query.
  function pathOrderedRows(sheet, result, mplan) {
    const pf = marksOf(sheet).path;
    if (!pf) return null;
    const { keyOrder } = planDims(sheet);
    const ki = keyOrder.findIndex((f) => sameField(f, pf));
    if (ki >= 0) return [...result.rows].sort((a, b) => cmpValues(a.keys[ki], b.keys[ki]));
    const mi = mplan.findIndex((e) => sameField(e.field, pf));
    if (mi >= 0) return [...result.rows].sort((a, b) => (Number(a.values[mi]) || 0) - (Number(b.values[mi]) || 0));
    return null;
  }

  // P19 Shape (scatter family): group rows by the Shape dimension's value → one scatter series per
  // value, each a distinct symbol (identity survives greyscale). X/Y are the two shelf measures.
  function renderScatterShapes(sheet, result, seriesIdx, sizeIdx, format, fmtVal, fmtCat) {
    if (seriesIdx.length < 2) { chartEl.append(hint("A shape scatter plots two measures (X and Y) — add a second measure.")); return; }
    const { keyOrder } = planDims(sheet);
    const si = keyOrder.findIndex((f) => sameField(f, marksOf(sheet).shape));
    const xIdx = seriesIdx[0], yIdx = seriesIdx[1];
    const groupsMap = new Map();
    for (const r of result.rows) {
      const sv = si >= 0 ? r.keys[si] : null;
      const gk = tupleKey([sv]);
      if (!groupsMap.has(gk)) groupsMap.set(gk, { name: sv == null ? "—" : fmtCat(sv), points: [] });
      const pt = [Number(r.values[xIdx]) || 0, Number(r.values[yIdx]) || 0];
      if (sizeIdx >= 0) pt.push(Number(r.values[sizeIdx]) || 0);
      const label = r.keys.map((k, i) => (i === si ? null : (k == null ? "—" : fmtCat(k)))).filter((v) => v != null).join(" / ");
      groupsMap.get(gk).points.push({ value: pt, name: label });
    }
    renderSeriesChart(chartEl, {
      type: "scatterShapes", groups: [...groupsMap.values()], format,
      xName: format.xTitle || result.measures[xIdx] || "x",
      yName: format.yTitle || result.measures[yIdx] || "y",
      hasSize: sizeIdx >= 0, sizeName: sizeIdx >= 0 ? result.measures[sizeIdx] : null,
    });
  }

  // Build the P18 mark-channel spec fed to chart.js: { spec: { sizes?, sizeName?, colorValues?,
  // colorName?, pointLabels?, tooltipExtra? }, note? }. Only channels valid for the current type/mapping
  // are populated; anything unmet becomes a friendly `note` (P11 rule: a hint, never an error).
  function marksChannels(sheet, result, mplan, sizeIdx, colorMeasureIdx, fmtVal, fmtCat, rowsOrdered) {
    const m = marksOf(sheet);
    const spec = {};
    const notes = [];
    const type = sheet.chartType;
    const rows = rowsOrdered ?? result.rows; // align channel arrays with the (possibly Path-ordered) rows

    // Size → the scatter family's bubbles (variable bar/line width is out of scope for v1).
    if (m.size) {
      if (SCATTER_TYPES.has(type) && sizeIdx >= 0) {
        spec.sizes = rows.map((r) => r.values[sizeIdx]);
        spec.sizeName = result.measures[sizeIdx];
      } else if (!SCATTER_TYPES.has(type)) {
        notes.push("Size shapes a Scatter (bubble) chart — switch to Scatter to use it.");
      }
    }
    // Continuous Colour → a token-derived gradient on scatter points, with a visualMap legend.
    if (colorMeasureIdx >= 0) {
      if (SCATTER_TYPES.has(type)) {
        spec.colorValues = rows.map((r) => r.values[colorMeasureIdx]);
        spec.colorName = result.measures[colorMeasureIdx];
      } else {
        notes.push("Continuous colour applies to Scatter — drop a categorical field on Colour for other chart types.");
      }
    }
    // Label → the field's value written on each mark. Numeric labels ride along as an aux measure;
    // categorical labels must be a group-by (on a shelf / Detail / Colour) to have one value per mark.
    if (m.label) {
      const resolved = markFieldValues(sheet, rows, mplan, m.label, fmtVal, fmtCat);
      if (resolved) spec.pointLabels = resolved.values;
      else notes.push("Label by a numeric field, or add the Label field to Columns/Rows/Detail so it groups.");
    }
    // Tooltip → extra lines listing each chosen field's per-mark value.
    const tips = (m.tooltip ?? []).map((f) => markFieldValues(sheet, rows, mplan, f, fmtVal, fmtCat)).filter(Boolean);
    if (tips.length) spec.tooltipExtra = tips.map((t) => ({ name: t.name, values: t.values }));
    // Angle: pie/donut already map their measure to slice angle; elsewhere a radial angle has no mark.
    if (m.angle && type !== "pie" && type !== "donut") notes.push("Angle drives a Pie/Donut slice — that mapping is already implicit there.");

    return { spec, note: notes.length ? notes.join(" ") : null };
  }

  // Per-row display values for a marks field over the given rows: a group-by dimension reads its key
  // (date-aware), a measure reads its aggregated value. null when the field isn't in the query.
  function markFieldValues(sheet, rows, mplan, field, fmtVal, fmtCat) {
    const { keyOrder } = planDims(sheet);
    const ki = keyOrder.findIndex((f) => sameField(f, field));
    if (ki >= 0) return { name: `${field.table}.${field.column}`, values: rows.map((r) => (r.keys[ki] == null ? "—" : fmtCat(r.keys[ki]))) };
    const mi = mplan.findIndex((e) => sameField(e.field, field));
    if (mi >= 0) return { name: measureName(mplan[mi].field.agg ? mplan[mi].field : { ...mplan[mi].field, agg: mplan[mi].agg }), values: rows.map((r) => fmtVal(r.values[mi])) };
    return null;
  }

  // Build the ECharts click handler that turns a mark click into a selection on the primary dimension
  // (P15). Returns undefined when the chart type or field mapping can't support click-to-filter.
  function selectHandler(sheet, dimField, type, rawByIndex) {
    if (!dimField || !CLICK_TYPES.has(type)) return undefined;
    const drilling = isDrillActive(sheet); // P16: on a drill hierarchy a click descends instead of selecting
    return (params) => {
      const raw = rawByIndex[params.dataIndex];
      if (raw === undefined || raw === null) return; // can't cleanly filter/drill a null value
      if (drilling) drillDown(raw);
      else toggleSelection(dimField, raw);
    };
  }

  // Toggle the click selection: a fresh click selects (action reset to a plain highlight); clicking the
  // already-selected value clears it. Keep-only / Exclude are chosen from the selection chip.
  function toggleSelection(dimField, rawValue) {
    const dash = activeDashboard();
    if (!dash) return;
    const s = dash.sheet;
    const cur = s.selection;
    const same = cur && cur.table === dimField.table && cur.column === dimField.column && String(cur.value) === String(rawValue);
    if (same) {
      s.selection = null;
    } else {
      const fmtCat = makeCategoryFormatter(s.format ?? defaultFormat());
      s.selection = {
        db: dimField.db, table: dimField.table, column: dimField.column, value: rawValue,
        label: `${dimField.table}.${dimField.column} = ${fmtCat(rawValue)}`, action: null,
      };
    }
    commit(dash, s);
  }

  // Field mappings a chart type needs; returns a friendly hint when unmet (P11 done-when: a hint,
  // not an error). bar/line/area/kpi accept any mapping (0 dimensions → KPI tiles).
  function chartIssue(type, dimCount, measureCount) {
    switch (type) {
      case "pie":
      case "donut":
        if (measureCount !== 1) return "Pie/Donut shows one measure — put exactly one measure on a shelf.";
        if (dimCount < 1) return "Pie/Donut needs a dimension to slice by — add a dimension.";
        return null;
      case "scatter":
      case "square":   // P19 point marks share the scatter mapping (two measures → X/Y)
      case "circle":
        if (measureCount < 2) return "A point chart plots two measures (X and Y) — add a second measure.";
        return null;
      case "combo":
        if (measureCount < 2) return "Combo (dual-axis) needs two measures — add a second measure.";
        if (dimCount < 1) return "Combo needs a dimension for the category axis — add a dimension.";
        return null;
      case "stacked":
        if (measureCount < 2) return "Stacked bar stacks two or more measures — add another measure.";
        if (dimCount < 1) return "Stacked bar needs a dimension for the category axis — add a dimension.";
        return null;
      case "heatmap":
        if (dimCount !== 2) return "Heatmap needs exactly two dimensions (the axes) — put one on Columns and one on Rows.";
        if (measureCount < 1) return "Heatmap colours by one measure — add a measure.";
        return null;
      case "treemap":
        if (dimCount < 1 || dimCount > 2) return "Treemap nests by one or two dimensions — add one or two.";
        if (measureCount < 1) return "Treemap sizes by one measure — add a measure.";
        return null;
      default:
        return null;
    }
  }

  // Pivot a Color-encoded result into one series per colour value and render it (P7 marks). The colour
  // dimension is the trailing group-by key; the remaining keys form the category axis. Missing
  // (category × colour) cells become null so series stay aligned. One measure only (guarded by caller).
  function renderColorSplit(type, result, format, fmtCat) {
    const { rowDimensions, columnDimensions, rows } = result;
    const colorIdx = rowDimensions.length + columnDimensions.length - 1;
    const catOf = (keys) => keys.filter((_, i) => i !== colorIdx);

    const catTuples = uniqueTuples(rows.map((r) => catOf(r.keys)));
    const colorVals = [];
    const seen = new Set();
    for (const r of rows) {
      const cv = r.keys[colorIdx];
      const k = tupleKey([cv]);
      if (!seen.has(k)) { seen.add(k); colorVals.push(cv); }
    }
    const cell = new Map();
    for (const r of rows) cell.set(tupleKey(catOf(r.keys)) + "|" + tupleKey([r.keys[colorIdx]]), r.values[0]);

    const categories = catTuples.map((t) => (t.length ? t.map((k) => (k == null ? "—" : fmtCat(k))).join(" / ") : ""));
    const series = colorVals.map((cv) => ({
      name: cv == null ? "—" : fmtCat(cv),
      data: catTuples.map((t) => cell.get(tupleKey(t) + "|" + tupleKey([cv])) ?? null),
    }));
    // P15: click a mark → the primary (first non-colour) dimension value = catTuples[dataIndex][0].
    const sheet = activeDashboard()?.sheet;
    const onSelect = sheet ? selectHandler(sheet, primaryDim(sheet), type, catTuples.map((t) => t[0])) : undefined;
    const orientation = sheet ? chartOrientation(sheet) : "vertical";
    renderSeriesChart(chartEl, { type, categories, series, format, onSelect, orientation });
  }

  // P12 heatmap: two dimensions → axes, first measure → colour. Key order is [rowDim, colDim] (guarded
  // to exactly two dims by chartIssue), so dim 0 is the Y axis and dim 1 the X axis. Cells carry the
  // [xIndex, yIndex, value] triples ECharts' heatmap expects.
  function renderHeatmap(result, format, fmtCat, fmtVal) {
    const rows = result.rows;
    const yVals = [], xVals = [], ySeen = new Set(), xSeen = new Set();
    for (const r of rows) {
      const y = tupleKey([r.keys[0]]); if (!ySeen.has(y)) { ySeen.add(y); yVals.push(r.keys[0]); }
      const x = tupleKey([r.keys[1]]); if (!xSeen.has(x)) { xSeen.add(x); xVals.push(r.keys[1]); }
    }
    const yCats = yVals.map((v) => (v == null ? "—" : fmtCat(v)));
    const xCats = xVals.map((v) => (v == null ? "—" : fmtCat(v)));
    const yIdx = new Map(yVals.map((v, i) => [tupleKey([v]), i]));
    const xIdx = new Map(xVals.map((v, i) => [tupleKey([v]), i]));
    const cells = rows.map((r) => [xIdx.get(tupleKey([r.keys[1]])), yIdx.get(tupleKey([r.keys[0]])), r.values[0]]);
    renderSeriesChart(chartEl, { type: "heatmap", xCats, yCats, cells, format });
  }

  // P12 treemap: one or two dimensions form the hierarchy; the first measure sizes the rectangles.
  // One dim → a flat list of leaves; two dims → dim 0 groups, dim 1 nests under it (values summed).
  function renderTreemap(result, format, fmtCat) {
    const dimCount = result.rowDimensions.length + result.columnDimensions.length;
    const rows = result.rows;
    let tree;
    if (dimCount === 1) {
      tree = rows.map((r) => ({ name: r.keys[0] == null ? "—" : fmtCat(r.keys[0]), value: r.values[0] }));
    } else {
      const parents = new Map();
      for (const r of rows) {
        const pk = tupleKey([r.keys[0]]);
        if (!parents.has(pk)) parents.set(pk, { name: r.keys[0] == null ? "—" : fmtCat(r.keys[0]), value: 0, children: [] });
        const node = parents.get(pk);
        node.value += Number(r.values[0]) || 0;
        node.children.push({ name: r.keys[1] == null ? "—" : fmtCat(r.keys[1]), value: r.values[0] });
      }
      tree = [...parents.values()];
    }
    renderSeriesChart(chartEl, { type: "treemap", tree, format });
  }

  // KPI tiles. With no dimension each measure is a single big number; with a dimension (P11) the
  // headline is the latest category's value under an inline sparkline of the trend.
  function kpiView(measures, categories, series, dimCount, fmtVal) {
    const wrap = el("div", "ws-kpi-row");
    measures.forEach((name, i) => {
      const data = series[i].data;
      const tile = el("div", "ws-kpi");
      if (dimCount === 0) {
        tile.append(el("div", "widget__kpi-num", fmtVal(data[0])));
        tile.append(el("div", "widget__kpi-sub", name));
      } else {
        tile.append(el("div", "widget__kpi-num", fmtVal(data[data.length - 1])));
        tile.append(sparkline(data));
        const sub = el("div", "widget__kpi-sub", name);
        const lastCat = categories[categories.length - 1];
        if (lastCat != null) sub.title = `latest: ${lastCat}`;
        tile.append(sub);
      }
      wrap.append(tile);
    });
    return wrap;
  }

  // A tiny inline SVG sparkline (no ECharts instance — the chart pane holds at most one of those).
  function sparkline(data) {
    const NS = "http://www.w3.org/2000/svg";
    const w = 132, h = 30, pad = 3;
    const nums = data.map((v) => Number(v) || 0);
    const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1, n = nums.length;
    const x = (i) => (n <= 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
    const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "ws-spark");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    const poly = document.createElementNS(NS, "polyline");
    poly.setAttribute("class", "ws-spark__line");
    poly.setAttribute("fill", "none");
    poly.setAttribute("points", nums.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "));
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("class", "ws-spark__dot");
    dot.setAttribute("cx", x(n - 1).toFixed(1));
    dot.setAttribute("cy", y(nums[n - 1]).toFixed(1));
    dot.setAttribute("r", "2.5");
    svg.append(poly, dot);
    return svg;
  }

  // Tableau-style crosstab. Row-shelf dimensions form the left stub; Column-shelf dimensions the top
  // header; measures are the cell values. The *measure name band* sits on whichever shelf the numeric
  // pills are on (measures on both shelves → shown across the top, with a note). Built by pivoting the
  // flat grouped rows: keys are [rowDim…, colDim…]; we take the distinct row/col tuples and index the
  // cells, then render nested headers (colSpan on top, rowSpan on the left stub).
  function crosstabTable(sheet, result, fmtVal, fmtCat) {
    const { rowDimensions, columnDimensions, measures, rows } = result;
    const rd = rowDimensions.length, cd = columnDimensions.length;
    const dimLabel = (v) => (v == null ? "—" : fmtCat(v)); // date-aware header label (P10)

    const colMeasures = sheet.columns.filter((f) => roleOf(f) === "measure");
    const rowMeasures = sheet.rows.filter((f) => roleOf(f) === "measure");
    const bothMeasures = colMeasures.length > 0 && rowMeasures.length > 0;
    const measureOnLeft = !bothMeasures && rowMeasures.length > 0;   // else on top (incl. implicit count)

    const rowTuples = uniqueTuples(rows.map((r) => r.keys.slice(0, rd)));
    const colTuples = uniqueTuples(rows.map((r) => r.keys.slice(rd, rd + cd)));
    const cells = new Map();
    for (const r of rows) cells.set(tupleKey(r.keys.slice(0, rd)) + "|" + tupleKey(r.keys.slice(rd, rd + cd)), r.values);
    const cellValue = (rt, ct, mi) => cells.get(tupleKey(rt) + "|" + tupleKey(ct))?.[mi];

    const leftLeaves = expandLeaves(rowTuples, measureOnLeft ? measures.length : 0);
    const topLeaves = expandLeaves(colTuples, measureOnLeft ? 0 : measures.length);
    const leftLevels = rd + (measureOnLeft ? 1 : 0);
    const topLevels = cd + (measureOnLeft ? 0 : 1);

    const table = el("table", "data xtab");

    // --- header: one row per top level; a merged corner spans the left-stub width and all header rows.
    const thead = document.createElement("thead");
    const leftLabel = [...rowDimensions, ...(measureOnLeft ? ["Measure"] : [])].join(" · ");
    for (let tl = 0; tl < Math.max(1, topLevels); tl++) {
      const tr = document.createElement("tr");
      if (tl === 0 && leftLevels > 0) {
        const corner = el("th", "xt-corner", leftLabel);
        corner.colSpan = leftLevels;
        corner.rowSpan = Math.max(1, topLevels);
        tr.append(corner);
      }
      if (topLevels === 0) {
        tr.append(el("th", "num", ""));                         // single unlabeled value column
      } else if (tl < cd) {
        for (const g of runs(topLeaves, (lf) => tupleKey(lf.tuple.slice(0, tl + 1)))) {
          const th = el("th", "xt-colhdr", dimLabel(g.leaf.tuple[tl]));
          th.colSpan = g.span;
          tr.append(th);
        }
      } else {
        for (const lf of topLeaves) tr.append(el("th", "num xt-meas", measures[lf.mi]));
      }
      thead.append(tr);
    }
    table.append(thead);

    // --- body: one row per left leaf; left-stub cells use rowSpan grouping per dimension level.
    const tbody = document.createElement("tbody");
    const dimStarts = [];
    for (let ll = 0; ll < rd; ll++) dimStarts.push(levelSpans(leftLeaves, ll));
    leftLeaves.forEach((leftLeaf, ri) => {
      const tr = document.createElement("tr");
      for (let ll = 0; ll < rd; ll++) {
        const span = dimStarts[ll][ri];
        if (!span) continue;                                    // covered by a rowSpan above
        const th = el("th", "xt-rowhdr", dimLabel(leftLeaf.tuple[ll]));
        if (span > 1) th.rowSpan = span;
        tr.append(th);
      }
      if (measureOnLeft) tr.append(el("th", "xt-rowhdr xt-meas", measures[leftLeaf.mi]));
      for (const topLeaf of topLeaves) {
        const mi = measureOnLeft ? leftLeaf.mi : topLeaf.mi ?? 0;
        const v = cellValue(leftLeaf.tuple, topLeaf.tuple, mi);
        tr.append(el("td", "num", fmtVal(v)));
      }
      tbody.append(tr);
    });
    table.append(tbody);

    if (bothMeasures) {
      const wrap = el("div", "xt-wrap");
      wrap.append(warn("Measures are on both shelves — showing them across the top. Put all measures on one shelf for a clean crosstab."), table);
      return wrap;
    }
    return table;
  }

  function uniqueTables() {
    const seen = new Set(), out = [];
    for (const e of entities.values()) {
      const k = keyOf(e.db, e.table);
      if (!seen.has(k)) { seen.add(k); out.push({ db: e.db, table: e.table }); }
    }
    return out;
  }
  async function columnsFor(db, table) {
    const k = keyOf(db, table);
    if (!columnsCache.has(k)) {
      try { columnsCache.set(k, await api.columns(db, table)); }
      catch { columnsCache.set(k, []); }
    }
    return columnsCache.get(k);
  }
  function iconButton(glyph, label) {
    const b = el("button", "iconbtn"); b.append(PATHS[glyph] ? icon(glyph) : glyph); b.type = "button"; b.setAttribute("aria-label", label);
    return b;
  }
}

// --- DnD + DOM helpers ------------------------------------------------------
function hasField(e) { return e.dataTransfer && Array.from(e.dataTransfer.types).includes(FIELD_MIME); }
function readField(e) {
  const raw = e.dataTransfer?.getData(FIELD_MIME);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
// A pill-reorder drag carries { shelf, index } under its own MIME, distinct from a new field dragged
// from the field pane (FIELD_MIME), so a shelf can tell "reorder an existing pill" from "add a field".
const PILL_MIME = "application/x-ch-pill";
function hasPill(e) { return e.dataTransfer && Array.from(e.dataTransfer.types).includes(PILL_MIME); }
function readPill(e) {
  const raw = e.dataTransfer?.getData(PILL_MIME);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
function iconSpan(cls, name) { const s = el("span", cls); s.append(icon(name)); return s; }
function hint(text) { return el("div", "ws-hint", text); }
function warn(text) { return el("div", "ws-hint ws-hint--warn", text); }

// --- export helpers (P13) ---------------------------------------------------
// Trigger a browser download of a Blob, cleaning up the object URL afterwards.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
// A safe file base name from the dashboard name (fallback "worksheet").
function exportBaseName(dash) {
  const raw = (dash?.name || "worksheet").trim().toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "worksheet";
}

// --- crosstab (pivot) helpers ----------------------------------------------
// NUL joins tuple cells into a comparison key without colliding on legitimate separators.
function tupleKey(tuple) { return tuple.map((v) => (v ?? "")).join("\u0000"); }
// Distinct tuples, preserving first-seen order (the backend already sorts by dimension keys).
function uniqueTuples(list) {
  const seen = new Set(); const out = [];
  for (const t of list) { const k = tupleKey(t); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}
// Expand tuples into header/stub leaves. measureCount 0 → one leaf per tuple (mi:null); >0 → one leaf
// per (tuple × measure). No tuples (no dims on that axis) → a single empty tuple so a value still shows.
function expandLeaves(tuples, measureCount) {
  const src = tuples.length ? tuples : [[]];
  const out = [];
  for (const t of src) {
    if (measureCount === 0) out.push({ tuple: t, mi: null });
    else for (let mi = 0; mi < measureCount; mi++) out.push({ tuple: t, mi });
  }
  return out;
}
// Run-length groups of consecutive leaves sharing keyFn — for colSpan on the top header.
function runs(leaves, keyFn) {
  const out = [];
  for (let i = 0; i < leaves.length;) {
    let j = i + 1; const k = keyFn(leaves[i]);
    while (j < leaves.length && keyFn(leaves[j]) === k) j++;
    out.push({ leaf: leaves[i], span: j - i });
    i = j;
  }
  return out;
}
// Per-leaf rowSpan for dimension level `ll`: the group size at each group's first leaf, else 0
// (that cell is covered by the rowSpan above) — for merging repeated row-stub headers.
function levelSpans(leaves, ll) {
  const spans = new Array(leaves.length).fill(0);
  for (let i = 0; i < leaves.length;) {
    let j = i + 1; const k = tupleKey(leaves[i].tuple.slice(0, ll + 1));
    while (j < leaves.length && tupleKey(leaves[j].tuple.slice(0, ll + 1)) === k) j++;
    spans[i] = j - i;
    i = j;
  }
  return spans;
}
function select(options, selected, className, label) {
  const sel = el("select", `select select--light ${className ?? ""}`.trim());
  if (label) sel.setAttribute("aria-label", label); // accessible name (a11y — no visible <label>)
  for (const o of options) { const opt = new Option(o, o); if (o === selected) opt.selected = true; sel.add(opt); }
  return sel;
}

// --- format-panel controls (P10). Each wraps its control in a <label> so the visible text is the
// control's accessible name. `options` is [value, text] pairs; `current` matches by string value. ---
function fmtSelect(labelText, options, current, onPick) {
  const wrap = el("label", "ws-fmt-field");
  wrap.append(el("span", "ws-fmt-label", labelText));
  const sel = el("select", "select select--light ws-fmt-select");
  for (const [val, text] of options) {
    const opt = new Option(text, String(val));
    if (String(val) === String(current)) opt.selected = true;
    sel.add(opt);
  }
  sel.addEventListener("change", () => onPick(sel.value));
  wrap.append(sel);
  return wrap;
}
function fmtCheck(labelText, checked, onToggle) {
  const wrap = el("label", "ws-fmt-field ws-fmt-check");
  const cb = el("input"); cb.type = "checkbox"; cb.checked = !!checked;
  cb.addEventListener("change", () => onToggle(cb.checked));
  wrap.append(cb, el("span", "ws-fmt-label", labelText));
  return wrap;
}
function fmtText(labelText, value, onChange) {
  const wrap = el("label", "ws-fmt-field");
  wrap.append(el("span", "ws-fmt-label", labelText));
  const inp = el("input", "input ws-fmt-input");
  inp.type = "text";
  inp.value = value ?? "";
  inp.placeholder = "auto"; inp.maxLength = LIMITS.axisTitle;
  inp.addEventListener("change", () => onChange(inp.value.trim() || null));
  wrap.append(inp);
  return wrap;
}
