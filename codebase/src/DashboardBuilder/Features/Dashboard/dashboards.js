import { api } from "../Core/api.js";
import { icon, PATHS } from "../Core/icons.js";
import { wireMenu } from "../Core/menu.js";
import { visibleTools } from "./toolbar-rules.js";
import { roleOf, COLOR_SPLIT_TYPES, STAT_SINGLE_TABLE, chartIssue, TEXT_VALUE_HINT, COLOR_SPLIT_HINT, statFieldHint, showMeOptions, placeFor, samePlacement } from "./show-me-rules.js";
import { toggle, makeButton, toast, fieldError, confirmDialog } from "../Core/ui.js";
import { LIMITS, number } from "../Core/validate.js";
import { aggsFor, checkAdd, checkFilter, viewCounts, statFilters, withCategories, TEXT_VALUE_TYPES, opsFor, OP_LABELS, serverFilter } from "./filter-rules.js";
import { entities, relationships, activeDashboard, isModelActive, updateSheet, bus, defaultFormat, defaultMarks, sharedFilters,
  metaOf, nameOf, setFieldMeta, emptySheet, parameters, updateParameter } from "../Core/store.js";
import { checkValue, paramTypeFor, withParamValue, effectiveTopN } from "../Core/parameters-model.js";
import { renderChart as renderSeriesChart, disposeChart, exportChart, hasChartInstance, animateNextChart, sizeChart, focusSeries } from "./chart.js";
import { makeValueFormatter, makeCategoryFormatter } from "../Core/format.js";
import { createLatestGate, createResultCache, requestKey, isAbortError, truncationNotice } from "./query-runner.js";
import { CHART_TYPES, chartIcon, chartLabel, sortSummary } from "./viewbar-model.js";
import { enter, MOTION } from "../Core/motion.js";
import { wireResizer } from "../Core/resizer.js";
import { PRESET_CHOICES, COMPARE_CHOICES, COMPARE_TYPES, newPeriod, resolveRange, compareRange, rangeFilter, rangeLabel,
  compareName, changeOf, toneOf, pctText, alignCompare, targetProgress } from "./period-model.js";
import { CF_MODE_CHOICES, CF_SCALE_CHOICES, CF_OP_CHOICES, CF_TONE_CHOICES, CF_MAX_RULES, TONE_ICON, measureKey, emptyRule,
  extentOf, scaleColors, barGeometry, matchRule, isActive, midpointOf } from "./conditional-model.js";
import { templateError, buildActionUrl, MAX_LABEL, MAX_TEMPLATE } from "./action-model.js";
import { DATE_PART_CHOICES, isGroupingPart, stepPart, labelParts } from "./date-parts.js";
import { CALC_CHOICES, ALONG_CHOICES, WINDOW_CHOICES, applyTableCalcs, isCalc, calcName } from "./table-calc.js";
import { createHistory } from "./history.js";
import { REF_CHOICES, TREND_CHOICES, FORECAST_CHOICES, defaultAnalytics, refValue, trendSeries, combine } from "./analytics-model.js";
import { scalePlan, withOther, bucketNotice, tableProgress, needsNextPage, OTHER_TYPES, BUCKET_TYPES, DATE_BUCKET_CHOICES } from "./scale-model.js";

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
// A Date / Date32 column holds days only (no time) — its range filter is sent as plain days.
function isDateOnlyColumn(db, table, column) {
  const t = columnsCache.get(keyOf(db, table))?.find((x) => x.name === column)?.type
    ?? [...entities.values()].find((e) => e.db === db && e.table === table)?.columns?.find((x) => x.name === column)?.type ?? "";
  return /^(Nullable\()?(LowCardinality\()?Date(32)?\)*$/.test(t);
}
const FILTER_PLACEHOLDER = { numeric: "number", temporal: "YYYY-MM-DD", boolean: "true or false" };
const OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "between"];
// A filter contributes to the query only when checkFilter() says "ok" (empty = no-op, invalid = not applied).
// Map a client filter to the server QueryFilter shape (value for scalar ops, values for in/between).
// P30: relative dates resolve to a bound `between` (whole days), top-N carries its ranking measure.
const toFilter = (f) => serverFilter(f, { resolve: (preset) => resolveRange({ preset }), dateOnly: isDateOnlyColumn(f.db, f.table, f.column) });
// A field's role can be overridden on its pill (Tableau's convert-to-dimension/measure). Default:
// numeric → measure (aggregated), everything else → dimension (grouped). A numeric field made a
// dimension groups by its raw values; any field made a measure is aggregated (count/countDistinct
// always valid, sum/avg only meaningful for numbers).
// (roleOf itself lives in show-me-rules.js.)

// Display name of a measure — matches the server's measure naming (see QueryAsync).
function measureName(f) {
  const a = f.agg ?? "sum";
  const n = metaOf(f).alias || f.column; // P28 display name
  if (a === "count") return "count";
  if (a === "countDistinct") return `distinct ${n}`;
  return `${a} ${n}`;
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
  keyOrder.forEach((f, i) => out.push({ alias: `k${i}`, id: fieldId(f, "dimension"), label: nameOf(f) }));
  shelf.forEach((e, i) => out.push({ alias: `v${i}`, id: fieldId(e.field, "measure"), label: measureName(e.field) }));
  return out;
}
const CHART_LIKE = new Set([
  "bar", "stacked", "line", "area", "pie", "donut", "scatter", "combo", "square", "circle",
  "heatmap", "treemap", "histogram", "boxplot",
  "waterfall", "funnel", "gauge", "bullet", "sankey", "multiples", // P36
]);
// P36 types drawn by renderP36 (each from the ordinary /api/query result).
const P36_TYPES = new Set(["waterfall", "funnel", "gauge", "bullet", "sankey", "multiples"]);
// Charts without x / y axes: no axis-title controls in Format.
const NO_AXES = new Set(["pie", "donut", "funnel", "gauge", "sankey"]);
// Charts that read Format → Target (P35 scorecard; P36 gauge maximum / bullet target).
const TARGET_TYPES = new Set(["kpi", "gauge", "bullet"]);
// Small multiples draw at most this many panels.
const MAX_PANELS = 24;
// Chart types that consume a Color dimension (P7 marks). SPLIT types pivot it into one coloured
// series per value; a Table takes it as an extra group-by that renders as a free top-header level.
// Types outside COLOR_USES ignore a Color pill (pie already slices by colour; scatter/combo/KPI
// don't split) — the Color lane shows a note so it's honest, never a silent no-op.
const COLOR_USES = new Set(["bar", "stacked", "line", "area", "table"]);
// Chart types whose marks map 1:1 to a category and so support click-to-filter (P15).
// P21: chart types that take reference lines / bands / a trend.
const ANALYTICS_TYPES = new Set(["bar", "line", "area"]);
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
// P22 Show Me: the field counts one candidate chart type sees — the same dims the chart hint counts
// (planDims with that type: drill, shelf, Detail, Shape, discrete Colour) and the shelf measures.
function showMeCounts(sheet, type) {
  const shelf = [...sheet.columns, ...sheet.rows];
  const measures = shelf.filter((f) => roleOf(f) === "measure");
  return {
    dims: planDims({ ...sheet, chartType: type }).keyOrder.length,
    shelfDims: (drillActiveDim(sheet) ? 1 : 0) + shelf.filter((f) => roleOf(f) === "dimension").length,
    measures: measures.length,
    hasDate: shelf.some((f) => roleOf(f) === "dimension" && f.category === "temporal"),
    textValue: measures.some((f) => f.category !== "numeric" && (f.agg === "min" || f.agg === "max")),
    discreteColor: colorMode(sheet) === "discrete",
    numericField: shelf.some((f) => f.category === "numeric"),
  };
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
  const noticeEl = document.getElementById("ws-chart-notice");
  const headEl = document.getElementById("ws-chart-head");
  if (!view) return;
  initFieldResizer();

  // Latest-wins queries + recent results per dashboard: a superseded query is aborted (its answer can
  // never overwrite a newer chart), and presentation-only changes re-render from the cached result
  // instead of re-querying ClickHouse. The Refresh button drops the dashboard's cache and re-queries.
  const history = createHistory(); // P23 undo / redo per dashboard
  const lastSnap = new Map();       // dashId → the sheet as last committed (the "before" of the next edit)
  const gate = createLatestGate();
  const results = createResultCache();
  // Table scroll-loading: the pages loaded so far for the table on screen (re-used while its plan stays
  // the same, so a format tweak keeps what was loaded). { dashId, key, plan, rows, total, loading, ctl }.
  let tablePager = null;
  let freshNext = false; // P33: the next query skips the server's result cache (Refresh)
  let legendFocus = null; // P29: the legend item the user clicked (highlighted), or null
  let calcFor = null;     // P27: the measure slot whose table-calculation editor is open — { shelf, index } or null
  let calcPercent = new Set(); // P27: result measure indexes whose values are percentages (per-cell "%")
  let choicesFor = null;  // P40: the shelf slot whose field-choices editor is open — { shelf, index } or null
  let extraNotice = null; // a line the last render wants in the notice (e.g. the small-multiples panel cap)
  let cfMeasure = null;   // which measure the Format card's conditional-formatting editor shows (P37)
  let bucketedKey = null; // which group key the last result grouped by date grain (its marks can't be click-filtered)

  let formatOpen = false; // whether the Format panel (P10) is expanded — ephemeral UI state
  let analyticsOpen = false; // P21: whether the Analytics card is open
  let showMeOpen = false; // P22: whether the Show Me card is open
  let shownPanel = null;  // the tool/format panel on screen last render, so only a newly opened one animates in
  let shownPills = new Set(); // pill keys on screen last render, so only a newly added pill animates in
  let shownFor = null;        // the dashboard those were rendered for (switching dashboards animates nothing)
  let shownDash = null;       // the dashboard on screen, so switching between two replays the view entrance
  let freshResult = false; // the last result came from ClickHouse (not the cache): animate the chart in
  let openTool = null;    // which toolbar tool's editor panel is open (Color/Size/…/Filters/Drill/Pages), or null
  let pageTimer = null;   // P20 Pages autoplay interval id (transient; never persisted)

  bus.addEventListener("view:changed", sync);
  bus.addEventListener("dashboard:changed", () => {
    // A change from outside commit() (bookmark, workbook open, undo) becomes the new baseline.
    const d = activeDashboard();
    if (d && !isModelActive()) lastSnap.set(d.id, structuredClone(d.sheet));
    if (!isModelActive()) { renderShelves(); runChart(); }
  });
  initUndoKeys();
  // Safety net: an entity's columns finishing after the first render may be the only source of a
  // restored filter's category — re-render once if any filter is still waiting for one.
  bus.addEventListener("entity:loaded", () => {
    const dash = activeDashboard();
    if (!dash || isModelActive() || !dash.sheet.filters.some((f) => !f.category)) return;
    const missing = dash.sheet.filters.filter((f) => !f.category).length;
    withCategories(dash.sheet.filters, categoryOf);
    if (dash.sheet.filters.filter((f) => !f.category).length < missing) { renderShelves(); runChart(); }
  });
  // chart.js reads colours from :root at render time — redraw when light/dark flips (Core/scheme.js; a cache hit, no query).
  bus.addEventListener("scheme:changed", () => { if (!isModelActive()) runChart(); });
  bus.addEventListener("theme:changed", () => { if (!isModelActive()) runChart(); }); // P41: redraw in the new colours
  // P28: a rename / hide / default aggregation redraws the field pane, the pills and the chart's labels.
  bus.addEventListener("fields:changed", () => { if (isModelActive()) return; buildFields(); renderShelves(); runChart(); });
  // P32: a parameter's new value re-runs the view (its filters / Top N read it at plan time).
  bus.addEventListener("parameters:changed", () => { if (isModelActive()) return; renderShelves(); runChart(); });
  initPresentation();
  sync();

  async function sync() {
    stopPaging();  // switching view/dashboard halts any running Pages animation
    legendFocus = null; // P29: a highlight belongs to the chart it was made on
    openTool = null; // close any open tool editor when the view changes
    toggle(view, !isModelActive());
    if (isModelActive()) { gate.cancel(); shownDash = null; return; }
    const id = activeDashboard()?.id ?? null;
    if (shownDash && id !== shownDash) enter(view.querySelector(".worksheet"), { y: 4, duration: MOTION.view });
    shownDash = id;
    const cur = activeDashboard();
    if (cur && !lastSnap.has(cur.id)) lastSnap.set(cur.id, structuredClone(cur.sheet));
    await buildFields();
    renderShelves();
    runChart();
  }
  function stopPaging() { if (pageTimer) { clearInterval(pageTimer); pageTimer = null; } }

  // Drag the field pane's right edge (or ←/→ on the handle) to resize it: 180px … 40% of the
  // worksheet, remembered in this browser. The width lives in .worksheet's --ws-fields-w.
  function initFieldResizer() {
    const sheet = view.querySelector(".worksheet");
    const handle = document.getElementById("ws-fields-resizer");
    if (!sheet || !handle) return;
    wireResizer(handle, {
      min: 180,
      max: () => sheet.getBoundingClientRect().width * 0.4,
      origin: () => sheet.getBoundingClientRect().left,
      current: () => fieldsEl.getBoundingClientRect().width,
      apply: (w) => sheet.style.setProperty("--ws-fields-w", `${w}px`),
      storageKey: "dashboardbuilder.fields.width",
    });
  }

  // --- field pane ----------------------------------------------------------
  // Latest call wins: overlapping calls (e.g. while a workbook restores) each wait for columns, so the
  // pane is replaced once, by the newest build, instead of cleared then appended to twice.
  let fieldsSeq = 0;
  async function buildFields() {
    const seq = ++fieldsSeq;
    const tables = uniqueTables();
    if (!tables.length) {
      fieldsEl.replaceChildren(hint("Add tables to the Data Model, then drag their fields onto the shelves."));
      return;
    }
    const groups = [];
    let hiddenCount = 0;
    for (const t of tables) {
      const cols = await columnsFor(t.db, t.table);
      const group = el("details", "ws-table ws-fieldset");
      group.open = true;
      group.append(el("summary", "ws-table__name", `${t.db}.${t.table}`));
      // P28: hidden fields stay out of the pane unless "Show hidden" is on.
      const visible = cols.filter((c) => { const h = metaOf({ ...t, column: c.name }).hidden; if (h) hiddenCount++; return !h || showHiddenFields; });
      const dims = visible.filter((c) => c.category !== "numeric");
      const meas = visible.filter((c) => c.category === "numeric");
      if (dims.length) { group.append(el("div", "ws-field-group", "Dimensions")); for (const c of dims) group.append(fieldChip(t, c, "dimension")); }
      if (meas.length) { group.append(el("div", "ws-field-group", "Measures")); for (const c of meas) group.append(fieldChip(t, c, "measure")); }
      groups.push(group);
    }
    if (seq !== fieldsSeq) return;
    fieldsEl.replaceChildren(fieldTools(hiddenCount), ...groups);
    filterFields();
  }

  // P28: the field pane's search box + "Show hidden" toggle. Search matches the column name or its
  // display name; non-matching fields and empty groups get `hidden`.
  let fieldQuery = "";
  let showHiddenFields = false;
  function fieldTools(hiddenCount) {
    const box = el("div", "ws-fieldtools");
    const search = el("input", "input ws-fieldtools__search");
    search.type = "search"; search.placeholder = "Search fields"; search.value = fieldQuery;
    search.setAttribute("aria-label", "Search fields");
    search.addEventListener("input", () => { fieldQuery = search.value; filterFields(); });
    box.append(search);
    if (hiddenCount || showHiddenFields) {
      const t = makeButton(showHiddenFields ? `Hide hidden fields` : `Show hidden (${hiddenCount})`, "btn ws-fieldtools__hidden");
      t.setAttribute("aria-pressed", String(showHiddenFields));
      t.addEventListener("click", () => { showHiddenFields = !showHiddenFields; buildFields(); });
      box.append(t);
    }
    return box;
  }
  function filterFields() {
    const q = fieldQuery.trim().toLowerCase();
    for (const group of fieldsEl.querySelectorAll(".ws-fieldset")) {
      let any = false;
      for (const chip of group.querySelectorAll(".ws-field")) {
        const hit = !q || chip.dataset.search.includes(q);
        chip.hidden = !hit;
        any ||= hit;
      }
      for (const label of group.querySelectorAll(".ws-field-group")) {
        let n = label.nextElementSibling, shown = false;
        while (n && n.classList.contains("ws-field")) { if (!n.hidden) shown = true; n = n.nextElementSibling; }
        label.hidden = !shown;
      }
      group.hidden = !any && Boolean(q);
    }
  }

  function fieldChip(t, col, role) {
    const chip = el("div", `ws-field ws-field--${role}`);
    chip.draggable = true;
    chip.title = `${col.name} · ${col.type}`;
    const payload = { db: t.db, table: t.table, column: col.name, category: col.category };
    const meta = metaOf(payload);
    const typeIcon = icon(TYPE_ICONS[col.category] ?? "type-other", { size: 14 });
    typeIcon.classList.add("ws-field__type");
    const nameEl = el("span", "ws-field__name", meta.alias || col.name);
    if (meta.alias) { nameEl.title = `${meta.alias} — column ${col.name}`; chip.classList.add("is-renamed"); }
    if (meta.hidden) chip.classList.add("is-hidden");
    chip.dataset.search = `${col.name} ${meta.alias ?? ""}`.toLowerCase();
    chip.append(typeIcon, nameEl);
    chip.append(fieldMenu(payload, col, nameEl));

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

  // P28: a field's ⋯ menu — Rename (inline), Default aggregation (numeric), Hide / Show.
  function fieldMenu(f, col, nameEl) {
    const wrap = el("div", "menu ws-field__menu");
    const btn = iconButton("more", `Options for ${col.name}`);
    btn.classList.add("ws-field__more");
    const list = el("div", "menu__list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    const item = (label, on, extra = {}) => {
      const b = el("button", "menu__item"); b.type = "button"; b.setAttribute("role", extra.role ?? "menuitem");
      if (extra.checked !== undefined) { b.setAttribute("aria-checked", String(extra.checked)); b.append(icon("check", { size: 14 })); }
      b.append(document.createTextNode(label));
      b.addEventListener("click", on);
      return b;
    };
    const meta = metaOf(f);
    list.append(item("Rename…", () => renameField(f, col, nameEl)));
    if (meta.alias) list.append(item("Use the column name", () => setFieldMeta(f, { alias: null })));
    if (col.category === "numeric") {
      list.append(el("div", "menu__sep"), el("div", "menu__heading", "Default aggregation"));
      for (const a of aggsFor(col.category))
        list.append(item(a, () => setFieldMeta(f, { agg: a === "sum" ? null : a }), { role: "menuitemradio", checked: (meta.agg ?? "sum") === a }));
    }
    list.append(el("div", "menu__sep"), item(meta.hidden ? "Show in the field list" : "Hide from the field list", () => setFieldMeta(f, { hidden: !meta.hidden })));
    wireMenu(btn, list);
    wrap.append(btn, list);
    return wrap;
  }
  // Inline rename, like a tab: Enter / blur saves (1–60 characters; blank = back to the column name), Esc cancels.
  function renameField(f, col, nameEl) {
    const input = el("input", "input ws-field__rename");
    input.value = metaOf(f).alias ?? col.name;
    input.maxLength = LIMITS.tabName;
    input.setAttribute("aria-label", `Display name for ${col.name}`);
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (!save) { input.replaceWith(nameEl); return; }
      setFieldMeta(f, { alias: !v || v === col.name ? null : v.slice(0, LIMITS.tabName) });
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("dragstart", (e) => e.preventDefault());
  }

  // --- shelves -------------------------------------------------------------
  function renderShelves() {
    const dash = activeDashboard();
    if (!dash) return;
    const s = dash.sheet;
    withCategories(s.filters, categoryOf);
    withCategories(sharedFilters, categoryOf);
    // Data controls live in the glass header; view controls live on the chart card they act on.
    //  • Header: the PRIMARY shelves **Columns** and **Rows**, then **Marks** — every other encoding
    //    (Color/Label/…, Filters/Drill/Pages) as a compact icon+text toolbar on the same label grid;
    //    clicking a tool opens ONE small editor panel, and a field can be dropped straight onto a tool.
    //  • Chart card head: chart-type picker (left); sort picker · format · export · refresh (right).
    headerAbort?.abort(); headerAbort = new AbortController();

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
      const list = el("div", "menu__list menu__list--start"); list.setAttribute("role", "menu"); list.hidden = true;
      for (const t of more) {
        const item = el("button", "menu__item"); item.type = "button"; item.setAttribute("role", "menuitem");
        item.append(icon(t.icon), document.createTextNode(t.label));
        item.addEventListener("click", () => { openTool = t.key; formatOpen = false; showMeOpen = false; renderShelves(); });
        list.append(item);
      }
      wrap.append(btn, list); toolbar.append(wrap);
      wireMenu(btn, list, { signal: headerAbort.signal });
    }
    const marks = el("div", "ws-shelf ws-shelf--marks");
    marks.append(el("span", "ws-shelf__label", "Marks"), toolbar);

    const children = [fieldsToggle(), columns, rows, marks];
    const active = tools.find((t) => t.key === openTool);
    const toolEl = calcFor ? calcPanel(dash, s) : choicesFor ? choicesPanel(dash, s) : active ? toolPanel(dash, s, active) : null;
    if (toolEl) children.push(toolEl);                        // the one open tool editor
    // Active-interaction chips (thin status bars for live drill / pages / click-selection state).
    if (isDrillActive(s)) children.push(drillChip(dash, s));  // P16 breadcrumb + drill-up
    if (s.pages) children.push(pagesControl(dash, s));        // P20 page/animate control
    if (s.selection) children.push(selectionChip(dash, s));   // P15 click-to-filter selection
    shelvesEl.replaceChildren(...children);

    const viewbar = el("div", "ws-viewbar");
    const vbRight = el("div", "ws-viewbar__group ws-viewbar__group--right");
    const vbIcons = el("div", "ws-viewbar__icons");
    vbIcons.append(formatToggle(), analyticsToggle(), exportControl(dash, s), refreshButton(dash), sheetActions(dash, s), fullScreenButton());
    vbRight.append(sortControl(dash, s), vbIcons);
    const vbLeft = el("div", "ws-viewbar__group");
    vbLeft.append(chartTypePicker(dash, s), showMeToggle(), undoButtons(dash));
    viewbar.append(vbLeft, vbRight);
    const fmtEl = showMeOpen ? showMePanel(dash, s) : formatOpen ? formatPanel(dash, s) : analyticsOpen ? analyticsPanel(dash, s) : null; // P10 format / P21 analytics card
    const swEl = switchers(dash, s); // P40
    const titleEl = s.showTitle === false ? null : titleBlock(dash, s); // P23
    const cardsEl = filterCards(dash, s); // P30
    const paramsEl = paramControls(s); // P32
    headEl.replaceChildren(viewbar, ...(swEl ? [swEl] : []), ...(fmtEl ? [fmtEl] : []), ...(titleEl ? [titleEl] : []), ...(paramsEl ? [paramsEl] : []), ...(cardsEl ? [cardsEl] : []));

    // Motion only for what is new since the last render (every edit re-renders the header).
    const panelKey = toolEl ? `tool:${openTool}` : fmtEl ? (showMeOpen ? "showme" : "format") : null;
    if (panelKey && panelKey !== shownPanel) enter(toolEl ?? fmtEl);
    shownPanel = panelKey;
    const pillKeys = new Set();
    for (const p of shelvesEl.querySelectorAll(".ws-pill[data-key]")) {
      const k = `${p.closest(".ws-shelf, .ws-toolpanel")?.className}|${p.dataset.key}`;
      if (shownFor === dash.id && !shownPills.has(k)) enter(p, { y: 4 });
      pillKeys.add(k);
    }
    shownPills = pillKeys;
    shownFor = dash.id;
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
    clear.addEventListener("click", () => { s.selection = null; legendFocus = null; commit(dash, s); });
    wrap.append(btn("Keep only", "keep"), btn("Exclude", "exclude"));
    // P39 URL action: open the sheet's link for the selected value (new tab, noopener, https only).
    if (s.urlAction && !templateError(s.urlAction.template)) {
      const go = makeButton(`${s.urlAction.label} ↗`, "ws-select__btn ws-select__link");
      go.prepend(icon("link", { size: 14 }));
      const r = buildActionUrl(s.urlAction.template, sel.value);
      go.title = r.url ?? r.error;
      go.addEventListener("click", () => {
        const now = buildActionUrl(s.urlAction.template, sel.value);
        if (now.error) { toast(now.error, "danger"); return; }
        window.open(now.url, "_blank", "noopener,noreferrer");
      });
      wrap.append(go);
    }
    wrap.append(clear);
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
    btn.title = "Re-run the query against ClickHouse";
    btn.addEventListener("click", () => { results.clear(dash.id); tablePager?.ctl?.abort(); tablePager = null; freshNext = true; runChart(); });
    return btn;
  }

  // P21: the Analytics card toggle (like Format) and the card itself.
  function analyticsToggle() {
    const btn = iconButton("analytics", "Analytics");
    btn.className = `iconbtn ws-viewbar__btn${analyticsOpen ? " is-active" : ""}`;
    btn.setAttribute("aria-pressed", String(analyticsOpen));
    btn.setAttribute("aria-expanded", String(analyticsOpen));
    btn.title = "Analytics — reference lines, trend, forecast, totals";
    btn.addEventListener("click", () => { analyticsOpen = !analyticsOpen; if (analyticsOpen) { openTool = null; formatOpen = false; showMeOpen = false; } renderShelves(); });
    return btn;
  }
  function analyticsPanel(dash, s) {
    const a = { ...defaultAnalytics(), ...(s.analytics ?? {}) };
    const set = (patch) => { s.analytics = { ...a, ...patch }; commit(dash, s); };
    const panel = el("div", "ws-format ws-analytics");
    panel.append(el("span", "ws-shelf__label", "Analytics"));
    const isTable = s.chartType === "table" || s.chartType === "text";
    if (ANALYTICS_TYPES.has(s.chartType)) {
      panel.append(fmtSelect("Reference line", REF_CHOICES, a.ref.kind, (v) => set({ ref: { kind: v, ...(v === "constant" ? { value: a.ref.value ?? 0 } : {}) } })));
      if (a.ref.kind === "constant") panel.append(fmtNumber("at", a.ref.value, "0", (v) => set({ ref: { kind: "constant", value: v ?? 0 } })));
      panel.append(fmtNumber("Band from", a.band?.from ?? null, "none", (v) => set({ band: v == null ? null : { from: v, to: a.band?.to ?? v } })),
        fmtNumber("to", a.band?.to ?? null, "none", (v) => set({ band: v == null ? null : { from: a.band?.from ?? v, to: v } })),
        fmtSelect("Trend", TREND_CHOICES, a.trend, (v) => set({ trend: v })));
      if (s.chartType === "line" || s.chartType === "area")
        panel.append(fmtSelect("Forecast", FORECAST_CHOICES, a.forecast, (v) => set({ forecast: Number(v) })));
      panel.append(el("span", "ws-shelf__note", "On the first measure, over the rows shown, in category order. A forecast extends the trend (linear if none is picked)."));
    } else if (isTable) {
      panel.append(fmtCheck("Grand totals", a.totals.grand, (v) => set({ totals: { ...a.totals, grand: v } })),
        fmtCheck("Subtotals", a.totals.sub, (v) => set({ totals: { ...a.totals, sub: v } })),
        el("span", "ws-shelf__note", "Sums and counts add up; min / max take the min / max; averages and distinct counts can't be totalled from their parts — they show —."));
    } else {
      panel.append(el("span", "ws-shelf__note", "Analytics work on Bar, Line and Area charts, and totals on Table / Text."));
    }
    return panel;
  }

  function formatToggle() {
    const btn = iconButton("format", "Format");
    btn.className = `iconbtn ws-viewbar__btn${formatOpen ? " is-active" : ""}`;
    btn.setAttribute("aria-pressed", String(formatOpen));
    btn.title = "Format";
    btn.setAttribute("aria-expanded", String(formatOpen));
    btn.addEventListener("click", () => { formatOpen = !formatOpen; if (formatOpen) { openTool = null; analyticsOpen = false; showMeOpen = false; } renderShelves(); });
    return btn;
  }
  // P22 Show Me: every chart type, greyed with the reason when the sheet's fields can't draw it, the best
  // one outlined; a click sets the type and lays Columns / Rows out for it (one commit = one undo step).
  function showMeToggle() {
    const btn = iconButton("show-me", "Show Me");
    btn.className = `iconbtn ws-viewbar__btn ws-showme-toggle${showMeOpen ? " is-active" : ""}`;
    btn.append(el("span", null, "Show Me"));
    btn.setAttribute("aria-pressed", String(showMeOpen));
    btn.setAttribute("aria-expanded", String(showMeOpen));
    btn.title = "Show Me — chart types that fit these fields";
    btn.addEventListener("click", () => {
      showMeOpen = !showMeOpen; if (showMeOpen) { openTool = null; formatOpen = false; analyticsOpen = false; }
      renderShelves();
      headEl.querySelector(".ws-showme-toggle")?.focus(); // the re-render replaced this button
    });
    return btn;
  }
  function showMePanel(dash, s) {
    const panel = el("div", "ws-format ws-showme");
    panel.append(el("span", "ws-shelf__label", "Show Me"));
    const status = el("p", "ws-shelf__note ws-showme__status");
    status.setAttribute("aria-live", "polite");
    const empty = !s.columns.length && !s.rows.length; // a drill level alone isn't "fields to suggest for"
    if (empty) status.textContent = "Add fields to Columns or Rows to see suggestions.";
    const grid = el("div", "ws-showme__grid");
    for (const o of showMeOptions(CHART_TYPES.map(([id]) => id), (type) => showMeCounts(s, type))) {
      const tile = el("button", "ws-showme__tile"); tile.type = "button"; tile.dataset.type = o.id;
      tile.append(icon(chartIcon(o.id)), el("span", "ws-showme__label", chartLabel(o.id)));
      const current = o.id === s.chartType;
      tile.setAttribute("aria-pressed", String(current));
      if (current) { const tick = icon("check", { size: 14 }); tick.classList.add("ws-showme__check"); tile.append(tick); }
      if (o.recommended && !empty) { tile.classList.add("is-recommended"); tile.append(el("span", "ws-showme__badge", "Recommended")); }
      if (o.issue) {
        tile.setAttribute("aria-disabled", "true"); tile.title = o.issue;
        const why = el("span", null, o.issue); why.id = `ws-showme-why-${o.id}`; why.hidden = true;
        tile.setAttribute("aria-describedby", why.id); tile.append(why);
        tile.addEventListener("click", () => { status.textContent = `${chartLabel(o.id)}: ${o.issue}`; });
      } else {
        tile.addEventListener("click", () => {
          const placed = placeFor(o.id, s.columns, s.rows);
          if (current && samePlacement(placed, s)) return; // already laid out — no empty undo step
          s.chartType = o.id; s.columns = placed.columns; s.rows = placed.rows;
          commit(dash, s); // re-renders the header synchronously
          headEl.querySelector(`.ws-showme__tile[data-type="${o.id}"]`)?.focus();
        });
      }
      grid.append(tile);
    }
    panel.append(grid, status);
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); showMeOpen = false; renderShelves();
      headEl.querySelector(".ws-showme-toggle")?.focus();
    });
    return panel;
  }

  // --- export (P13) --------------------------------------------------------
  // A small menu offering the chart image (PNG/SVG from the live ECharts instance) and the rows behind
  // it as CSV (the bounded, identifier-safe /api/query/export.csv). Image export needs a chart instance
  // (Table/KPI render as native DOM, so it isn't offered there).
  function exportControl(dash, s) {
    const wrap = el("div", "menu ws-export");
    const btn = iconButton("export", "Export");
    btn.title = "Export";
    const menu = el("div", "menu__list");
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const item = (glyph, label, on) => {
      const b = el("button", "menu__item"); b.type = "button"; b.setAttribute("role", "menuitem");
      b.append(icon(glyph), document.createTextNode(label));
      b.addEventListener("click", on);
      return b;
    };
    menu.append(
      item("chart-bar", "PNG image", () => exportImage(dash, s, "png")),
      item("chart-bar", "SVG image", () => exportImage(dash, s, "svg")),
      item("table", "CSV data", () => exportCsvRows(dash, s)),
      item("print", "Print / PDF…", () => printView(dash, s)),
    );
    wireMenu(btn, menu, { signal: headerAbort?.signal }); // click toggles; Esc/outside/item click close; arrows move
    wrap.append(btn, menu);
    return wrap;
  }

  // Phone layout (P41): the field pane is an overlay opened from the data header (CSS shows this button
  // only on narrow screens; on wide ones the pane is always beside the shelves).
  function fieldsToggle() {
    const ws = view.querySelector(".worksheet");
    const open = ws.classList.contains("is-fields-open");
    const btn = makeButton(open ? "Hide fields" : "Fields", `btn ws-fields-toggle${open ? " is-active" : ""}`);
    btn.prepend(icon("table", { size: 16 }));
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-controls", "ws-fields");
    btn.addEventListener("click", () => { ws.classList.toggle("is-fields-open"); renderShelves(); });
    return btn;
  }

  // --- worksheet chrome (P23): undo / redo, sheet actions, title / caption, status bar ---
  function undoButtons(dash) {
    const wrap = el("div", "ws-undo");
    const u = iconButton("undo", "Undo (Ctrl+Z)"), r = iconButton("redo", "Redo (Ctrl+Shift+Z)");
    u.disabled = !history.canUndo(dash.id); r.disabled = !history.canRedo(dash.id);
    u.title = "Undo (Ctrl+Z)"; r.title = "Redo (Ctrl+Shift+Z)";
    u.addEventListener("click", () => step("undo")); r.addEventListener("click", () => step("redo"));
    wrap.append(u, r);
    return wrap;
  }
  function step(which) {
    const dash = activeDashboard();
    if (!dash || isModelActive()) return;
    stopPaging();
    const target = history[which](dash.id, dash.sheet);
    if (!target) return;
    lastSnap.set(dash.id, structuredClone(target));
    updateSheet(dash.id, target);
  }
  function initUndoKeys() {
    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || isModelActive() || view.hidden) return;
      if (e.target.closest?.("input, textarea, select, [contenteditable='true'], dialog")) return; // the field's own undo
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); step("undo"); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); step("redo"); }
    });
  }
  // The ⋯ menu: Swap Rows ↔ Columns, Clear sheet…, Fit (radio), Show title.
  function sheetActions(dash, s) {
    const wrap = el("div", "menu ws-actions");
    const btn = iconButton("more", "Sheet actions");
    btn.title = "Sheet actions";
    const menu = el("div", "menu__list");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const item = (label, on, extra = {}) => {
      const b = el("button", "menu__item"); b.type = "button"; b.setAttribute("role", extra.role ?? "menuitem");
      if (extra.checked !== undefined) { b.setAttribute("aria-checked", String(extra.checked)); b.append(icon("check", { size: 14 })); }
      else if (extra.icon) b.append(icon(extra.icon));
      b.append(document.createTextNode(label));
      b.addEventListener("click", on);
      return b;
    };
    const fit = s.format?.fit ?? "standard";
    menu.append(
      item("Swap Rows and Columns", () => swapShelves(dash, s), { icon: "swap" }),
      item("Clear sheet…", () => clearSheet(dash, s), { icon: "close" }),
      el("div", "menu__sep"), el("div", "menu__heading", "Fit"),
      ...[["standard", "Standard (scroll)"], ["width", "Fit width"], ["height", "Fit height"], ["entire", "Entire view"]].map(([v, t]) =>
        item(t, () => { s.format = { ...(s.format ?? defaultFormat()), fit: v }; commit(dash, s); }, { role: "menuitemradio", checked: fit === v })),
      el("div", "menu__sep"),
      item("Show title and caption", () => { s.showTitle = s.showTitle === false; commit(dash, s); }, { role: "menuitemcheckbox", checked: s.showTitle !== false }),
      item("Show filter cards", () => { s.showFilterCards = s.showFilterCards === false; commit(dash, s); }, { role: "menuitemcheckbox", checked: s.showFilterCards !== false }),
    );
    wireMenu(btn, menu, { signal: headerAbort?.signal });
    wrap.append(btn, menu);
    return wrap;
  }
  function swapShelves(dash, s) {
    [s.columns, s.rows] = [s.rows, s.columns];
    normaliseShelf(s, "columns"); normaliseShelf(s, "rows");
    choicesFor = null; calcFor = null;
    commit(dash, s);
  }
  async function clearSheet(dash, s) {
    if (dashboardHasContentSheet(s) && !(await confirmDialog("Clear this sheet? Fields, filters, marks and format go — Undo brings them back.", { danger: true, confirmText: "Clear" }))) return;
    const fresh = emptySheet();
    fresh.chartType = s.chartType;
    choicesFor = null; calcFor = null; openTool = null;
    Object.keys(s).forEach((k) => delete s[k]);
    Object.assign(s, fresh);
    commit(dash, s);
  }
  const dashboardHasContentSheet = (s) => Boolean(s.columns.length || s.rows.length || s.filters.length || s.color?.length || s.period || s.drill || s.pages);
  // The automatic caption: "sum amount by customers.name, customers.country · 2 filters".
  function autoCaption(s) {
    const ms = planMeasures(s).filter((e) => e.role === "shelf").map((e) => measureName({ ...e.field, agg: e.agg }));
    const ds = planDims(s).keyOrder.filter(Boolean).map(nameOf);
    const parts = [];
    if (ms.length || ds.length) parts.push(`${ms.length ? ms.join(", ") : "count"}${ds.length ? ` by ${ds.join(", ")}` : ""}`);
    const nf = s.filters.filter((f) => checkFilter(f).state === "ok").length;
    if (nf) parts.push(`${nf} filter${nf === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }
  // Title (defaults to the tab name) and caption (defaults to autoCaption): click to edit, Enter saves,
  // Esc cancels; an empty value goes back to the automatic one.
  function titleBlock(dash, s) {
    const box = el("div", "ws-titleblock");
    const editable = (tag, cls, value, auto, max, key, label) => {
      const b = el("button", `ws-titleblock__btn ${cls}${value ? "" : " is-auto"}`);
      b.type = "button";
      b.append(el(tag, null, value || auto || (key === "caption" ? "Add a caption" : "")));
      b.title = `Edit the ${label}`;
      b.setAttribute("aria-label", `${label}: ${value || auto || "none"} — edit`);
      b.addEventListener("click", () => {
        const input = el("input", `input ws-titleblock__input ${cls}`);
        input.value = value ?? ""; input.placeholder = auto || label; input.maxLength = max;
        input.setAttribute("aria-label", label);
        b.replaceWith(input); input.focus(); input.select();
        let done = false;
        const finish = (save) => {
          if (done) return; done = true;
          if (!save) { renderShelves(); return; }
          const v = input.value.trim();
          s[key] = v && v !== auto ? v.slice(0, max) : null;
          commit(dash, s);
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } });
        input.addEventListener("blur", () => finish(true));
      });
      return b;
    };
    box.append(editable("h2", "ws-titleblock__title", s.title, dash.name, 80, "title", "Title"),
      editable("p", "ws-titleblock__caption", s.caption, autoCaption(s), 300, "caption", "Caption"));
    return box;
  }
  // The status bar under the chart: marks, rows × columns, the selection.
  function setStatusBar(s, result) {
    const bar = document.getElementById("ws-statusbar");
    if (!bar) return;
    if (!result) { bar.replaceChildren(); toggle(bar, false); return; }
    const parts = [`${result.rows.length.toLocaleString("en-US")} mark${result.rows.length === 1 ? "" : "s"}`];
    const tuples = (from, n) => new Set(result.rows.map((r) => JSON.stringify(r.keys.slice(from, from + n)))).size;
    const rd = result.rowDimensions.length, cd = result.columnDimensions.length;
    if (s.chartType === "table" || s.chartType === "text")
      parts.push(`${tuples(0, rd).toLocaleString("en-US")} row${tuples(0, rd) === 1 ? "" : "s"} × ${tuples(rd, cd).toLocaleString("en-US")} column${tuples(rd, cd) === 1 ? "" : "s"}`);
    parts.push(`${result.measures.length} measure${result.measures.length === 1 ? "" : "s"}`);
    if (s.selection) parts.push(`Selected: ${s.selection.label}`);
    bar.textContent = parts.join(" · ");
    toggle(bar, true);
  }

  // --- presentation (P41): full screen + print ------------------------------
  const card = chartEl.closest(".ws-chart-card");
  const isFull = () => document.fullscreenElement === card || card.classList.contains("is-presenting");
  // Full screen shows the chart card alone (view bar kept — Esc or the button leaves). Uses the browser's
  // Fullscreen API; where that's refused, a fixed overlay with the same look and an Esc handler.
  function fullScreenButton() {
    const on = isFull();
    const btn = iconButton(on ? "collapse" : "expand", on ? "Exit full screen" : "Full screen");
    btn.className = `iconbtn ws-viewbar__btn${on ? " is-active" : ""}`;
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Exit full screen (Esc)" : "Full screen";
    btn.addEventListener("click", () => toggleFullScreen());
    return btn;
  }
  async function toggleFullScreen() {
    if (isFull()) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      card.classList.remove("is-presenting");
    } else {
      try { await card.requestFullscreen(); }
      catch { card.classList.add("is-presenting"); }
    }
    renderShelves();
  }
  function initPresentation() {
    // Phone field pane: a tap outside it, or Esc, closes it.
    const ws = view.querySelector(".worksheet");
    const closeFields = () => { if (ws.classList.contains("is-fields-open")) { ws.classList.remove("is-fields-open"); renderShelves(); } };
    ws.querySelector(".ws-main")?.addEventListener("pointerdown", (e) => { if (!e.target.closest(".ws-fields-toggle")) closeFields(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ws.classList.contains("is-fields-open")) closeFields(); });
    document.addEventListener("fullscreenchange", () => { if (!isModelActive()) renderShelves(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && card.classList.contains("is-presenting") && !e.defaultPrevented) {
        card.classList.remove("is-presenting"); renderShelves();
      }
    });
    bus.addEventListener("view:changed", () => {
      if (card.classList.contains("is-presenting")) card.classList.remove("is-presenting");
      if (document.fullscreenElement === card) document.exitFullscreen().catch(() => {});
    });
    // Print: a header naming the dashboard, its filters / range and the notice; the chart drawn at page
    // size (print.css rules in dashboard.css hide everything else). Removed after printing.
    window.addEventListener("beforeprint", () => { if (!isModelActive()) beginPrint(); });
    window.addEventListener("afterprint", endPrint);
  }
  let printHead = null;
  function beginPrint() {
    const dash = activeDashboard();
    if (!dash || printHead) return;
    const s = dash.sheet;
    printHead = el("div", "ws-print-head");
    printHead.append(el("h1", "ws-print-head__title", s.title || dash.name));
    if (s.showTitle !== false) printHead.append(el("p", "ws-print-head__line", s.caption || autoCaption(s)));
    const lines = [];
    const range = s.period ? periodNotice(s, null) : null;
    if (range) lines.push(`Date range: ${s.period.table}.${s.period.column} — ${range}`);
    for (const f of s.filters.filter((x) => checkFilter(x).state === "ok"))
      lines.push(`Filter: ${f.table}.${f.column} ${f.op} ${f.values ? f.values.join(f.op === "between" ? " – " : ", ") : f.value}`);
    if (noticeEl && !noticeEl.hidden && noticeEl.textContent) lines.push(noticeEl.textContent);
    lines.push(`Printed ${new Date().toLocaleString()}`);
    for (const l of lines) printHead.append(el("p", "ws-print-head__line", l));
    card.prepend(printHead);
    sizeChart({ width: 1000, height: 560 });
  }
  function endPrint() {
    printHead?.remove(); printHead = null;
    sizeChart(null);
  }
  function printView() { window.print(); }

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
    const view = buildPlan(s);
    if (!view) { toast("Add fields from related tables before exporting.", "info"); return; }
    // The whole result (up to 100,000 rows), not just what the view shows: no Top-N, no paging.
    const plan = { ...view, limit: LIMITS.exportRows, offset: undefined, withTotal: undefined, otherBucket: undefined };
    try {
      const csv = await api.exportCsv(plan);
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${exportBaseName(dash)}.csv`);
    } catch (err) { toast(err.message, "danger"); }
  }

  function formatPanel(dash, s) {
    const f = s.format ?? (s.format = defaultFormat());
    const isChart = CHART_LIKE.has(s.chartType);              // pie/donut/scatter/… get legend etc.
    const hasAxes = isChart && !NO_AXES.has(s.chartType);
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
    // P35 scorecard: a KPI's target, and which way a change counts as good when a comparison runs.
    if (TARGET_TYPES.has(s.chartType))
      panel.append(fmtText("Target", f.target == null ? "" : String(f.target), (v) => {
        if (v == null) { set({ target: null }); return; }
        const r = number(v);
        if (!r.ok) { toast(r.error, "danger"); return; }
        set({ target: r.value });
      }));
    if (s.period && s.period.compare !== "none")
      panel.append(fmtCheck("A fall is good", f.downIsGood, (v) => set({ downIsGood: v })));
    if (!STAT_SINGLE_TABLE.has(s.chartType))
      panel.append(fmtCheck("Approximate (faster)", f.approximate, (v) => set({ approximate: v }))); // P33
    if (s.chartType === "table" || s.chartType === "text") panel.append(conditionalEditor(dash, s));
    if (CLICK_TYPES.has(s.chartType)) panel.append(linkActionEditor(dash, s));
    // Chart-only controls.
    if (isChart) {
      panel.append(
        s.chartType === "histogram"
          ? fmtSelect("Bins", [["5", "5"], ["10", "10"], ["20", "20"], ["50", "50"], ["100", "100"]],
            f.topN ?? 20, (v) => set({ topN: Number(v) }))
          : fmtSelect("Top N", [["null", "All"], ["5", "5"], ["10", "10"], ["20", "20"], ["50", "50"], ["100", "100"],
              ...parameters.filter((p) => p.type === "number").map((p) => [`param:${p.id}`, `= ${p.name}`])], // P32
            f.topNParam ? `param:${f.topNParam}` : f.topN ?? "null",
            (v) => (v.startsWith("param:") ? set({ topNParam: v.slice(6) }) : set({ topN: v === "null" ? null : Number(v), topNParam: undefined }))),
        ...(BUCKET_TYPES.has(s.chartType)
          ? [fmtSelect("Group dates", DATE_BUCKET_CHOICES, f.dateBucket ?? "auto", (v) => set({ dateBucket: v }))] : []),
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

  // Sort picker: one quiet button showing the current order ("↑ customers.name"); its menu picks the
  // field (dimensions + measures in play) and the direction. Default: first field, ascending.
  // Choosing re-runs the query (server ORDER BY).
  function sortControl(dash, s) {
    const wrap = el("div", "menu ws-pick ws-pick--sort");
    const btn = el("button", "ws-pick__btn"); btn.type = "button";
    const targets = sortTargets(s);
    const sum = sortSummary(targets, s.sort);
    if (!sum) {
      btn.disabled = true; btn.title = "Add a field to sort";
      btn.append(icon("sort"), el("span", "ws-pick__text", "Sort"));
      wrap.append(btn);
      return wrap;
    }
    const { current, dir } = sum;
    const dirName = dir === "desc" ? "descending" : "ascending";
    btn.title = "Sort";
    btn.setAttribute("aria-label", `Sort: ${current.label}, ${dirName}`);
    btn.append(icon(`sort-${dir}`), el("span", "ws-pick__text", current.label), caret());
    const list = el("div", "menu__list"); list.setAttribute("role", "menu"); list.setAttribute("aria-label", "Sort"); list.hidden = true;
    list.append(el("div", "menu__heading", "Sort by"));
    for (const t of targets)
      list.append(radioItem(null, t.label, t === current, () => pickSort(dash, s, { by: t.id, dir })));
    list.append(menuSeparator());
    list.append(
      radioItem("sort-asc", "Ascending", dir === "asc", () => pickSort(dash, s, { by: current.id, dir: "asc" })),
      radioItem("sort-desc", "Descending", dir === "desc", () => pickSort(dash, s, { by: current.id, dir: "desc" })),
    );
    wrap.append(btn, list);
    wireMenu(btn, list, { signal: headerAbort.signal });
    return wrap;
  }
  function pickSort(dash, s, sort) {
    if (s.sort?.by === sort.by && (s.sort?.dir ?? "asc") === sort.dir) return;
    s.sort = sort;
    commit(dash, s);
    focusPicker("ws-pick--sort");
  }

  // Shared bits of the view-bar pickers.
  function caret() { const c = icon("chevron", { size: 14 }); c.classList.add("ws-pick__caret"); return c; }
  function menuSeparator() { const d = el("div", "menu__sep"); d.setAttribute("role", "separator"); return d; }
  function radioItem(glyph, label, checked, on) {
    const b = el("button", "menu__item"); b.type = "button";
    b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(checked));
    if (glyph) b.append(icon(glyph));
    b.append(el("span", "menu__label", label));
    const tick = icon("check", { size: 14 }); tick.classList.add("menu__check");
    b.append(tick);
    b.addEventListener("click", on);
    return b;
  }
  // A pick re-renders the chart head; put focus back on the (new) picker button.
  function focusPicker(cls) { headEl.querySelector(`.${cls} .ws-pick__btn`)?.focus(); }

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
    p.dataset.key = text;
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
    const label = nameOf(f); // P28: the display name
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
    // P27: a measure's quick table calculation (opens its editor); the pill names the calculation when set.
    if (isMeasure) {
      const on = isCalc(f.tableCalc);
      const open = calcFor && calcFor.shelf === shelfKey && calcFor.index === i;
      const fx = iconButton("calc", on ? `Table calculation: ${calcName(f.tableCalc)} — change` : `Add a table calculation to ${label}`);
      fx.classList.add("ws-pill__calc");
      if (on) fx.classList.add("is-set");
      fx.setAttribute("aria-pressed", String(Boolean(open)));
      fx.addEventListener("click", () => { calcFor = open ? null : { shelf: shelfKey, index: i }; if (calcFor) { openTool = null; choicesFor = null; } formatOpen = false; showMeOpen = false; renderShelves(); });
      controls.append(fx);
    }
    // P26: a date dimension picks its part here, and +/− step through year → quarter → month → day → hour.
    if (!isMeasure && f.category === "temporal") {
      const dateOnly = isDateOnlyColumn(f.db, f.table, f.column);
      const choices = DATE_PART_CHOICES.filter(([v]) => !(dateOnly && (v === "hour" || v === "hourOfDay")));
      const part = select(choices.map(([v]) => v), f.datePart ?? "auto", "ws-pill__part", `Date part for ${label}`);
      [...part.options].forEach((o) => { o.textContent = choices.find(([v]) => v === o.value)[1]; });
      part.addEventListener("change", () => { f.datePart = part.value; commit(dash, s); });
      const step = (dir) => {
        const next = stepPart(f.datePart ?? "auto", dir, dateOnly);
        const b = iconButton(dir > 0 ? "plus" : "−", dir > 0 ? `Finer: ${next ?? "none"}` : `Coarser: ${next ?? "none"}`);
        b.classList.add("ws-pill__step");
        b.disabled = !next;
        b.addEventListener("click", () => { if (next) { f.datePart = next; commit(dash, s); } });
        return b;
      };
      controls.append(step(-1), part, step(1));
    }
    // P40: alternative fields for this slot (opens the Choices editor).
    const n = f.choices?.length ?? 0;
    const sw = iconButton("swap", n >= 2 ? `Field choices for ${label} (${n})` : `Add field choices for ${label}`);
    sw.classList.add("ws-pill__swap");
    if (n >= 2) sw.classList.add("is-set");
    const open = choicesFor && choicesFor.shelf === shelfKey && choicesFor.index === i;
    sw.setAttribute("aria-pressed", String(Boolean(open)));
    sw.addEventListener("click", () => { choicesFor = open ? null : { shelf: shelfKey, index: i }; if (choicesFor) { openTool = null; calcFor = null; } formatOpen = false; showMeOpen = false; renderShelves(); });
    controls.append(sw);
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
    if (role === "measure") f.agg = f.agg ?? (f.category === "numeric" ? defaultAgg(f) : "count");
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
  function filterPill(dash, s, f, i, list) {
    const shared = list === sharedFilters;
    const ops = opsFor(f.category);
    const op = select(ops.includes(f.op) ? ops : [...ops, f.op], f.op, "ws-pill__op", `Filter operator for ${f.table}.${f.column}`);
    for (const o of op.options) if (OP_LABELS[o.value]) o.textContent = OP_LABELS[o.value];
    op.addEventListener("change", () => {
      f.op = op.value;
      if (f.op === "top" && !f.topBy) { // P30: rank by the first shelf measure until the user picks another
        const e = planMeasures(s).find((m) => m.role === "shelf");
        if (e) f.topBy = { db: e.field.db, table: e.field.table, column: e.field.column, agg: e.agg };
      }
      if (f.op === "in" && !Array.isArray(f.values)) f.values = [];
      if (f.op === "between" && !Array.isArray(f.values)) f.values = ["", ""];
      commit(dash, s); // re-render so the matching value control appears
    });
    const cfg = el("span", "ws-pill__filter");
    cfg.append(op, filterValueControl(dash, s, f));
    const chk = checkFilter(pv(f));
    if (chk.state === "invalid") {
      const inputs = [...cfg.querySelectorAll("input")];
      // For a range, mark the bound that actually failed (a half range blames the empty one).
      const bad = f.op === "between" && inputs.length === 2
        ? (!String(f.values?.[0] ?? "").trim() ? inputs[0] : !String(f.values?.[1] ?? "").trim() ? inputs[1]
          : (checkFilter({ ...f, op: "=", value: f.values[0] }).state === "invalid" ? inputs[0] : inputs[1]))
        : inputs[0];
      if (bad) fieldError(bad, chk.error);
    }
    // P40: share with every dashboard (moves it to the workbook's shared list), or take it back.
    const share = iconButton("link", shared ? `Stop sharing the filter on ${f.table}.${f.column} (keep it on this dashboard)` : `Share the filter on ${f.table}.${f.column} with every dashboard`);
    share.classList.add("ws-pill__share");
    share.setAttribute("aria-pressed", String(shared));
    share.addEventListener("click", () => toggleShared(dash, s, f, list, i));
    cfg.append(share);
    const p = pill(nameOf(f), () => { list.splice(i, 1); commit(dash, s); }, cfg);
    p.classList.toggle("ws-pill--invalid", chk.state === "invalid");
    if (chk.state === "invalid") p.prepend(icon("warning", { size: 14 }));
    if (shared) { p.classList.add("ws-pill--shared"); p.prepend(el("span", "ws-pill__badge", "All dashboards")); }
    return p;
  }

  // --- shared filters & field choices (P40) --------------------------------
  function toggleShared(dash, s, f, list, i) {
    const toShared = list !== sharedFilters;
    const target = toShared ? sharedFilters : s.filters;
    const cap = toShared ? LIMITS.sharedFilters : LIMITS.filters;
    if (target.length >= cap) {
      toast(toShared ? `At most ${LIMITS.sharedFilters} filters can be shared.` : `A view can have at most ${LIMITS.filters} filters.`, "info");
      return;
    }
    list.splice(i, 1);
    target.push(f);
    commit(dash, s);
  }
  // Shared filters whose table isn't in this view don't apply here — say which, never silently.
  function sharedSkipped(sheet) {
    const plan = buildPlan(sheet);
    if (!plan) return [];
    const inView = new Set([keyOf(plan.from.db, plan.from.table), ...plan.joins.map((j) => keyOf(j.right.db, j.right.table))]);
    return sharedFilters.filter((f) => checkFilter(f).state === "ok" && !inView.has(keyOf(f.db, f.table)));
  }
  function sharedNote(sheet) {
    const skipped = sharedSkipped(sheet);
    return skipped.length ? `${skipped.map((f) => `${f.table}.${f.column}`).join(", ")}: shared, but not applied here — its table isn't in this view.` : null;
  }

  // P28: rename a result's dimension and measure labels by the fields' display names.
  function aliasNames(sheet, result) {
    const { rowDims, colDims } = planDims(sheet);
    const mplan = planMeasures(sheet);
    const dimName = (f, fallback) => (f && metaOf(f).alias) || fallback;
    const aggWord = (a) => (a === "countDistinct" ? "distinct" : a);
    const measures = result.measures.map((m, mi) => {
      const e = mplan[mi];
      return e && metaOf(e.field).alias && e.agg !== "count" ? `${aggWord(e.agg)} ${metaOf(e.field).alias}` : m;
    });
    return { ...result,
      rowDimensions: result.rowDimensions.map((n, i) => dimName(rowDims[i], n)),
      columnDimensions: result.columnDimensions.map((n, i) => dimName(colDims[i], n)),
      measures };
  }

  // P27: the table-calculation editor for one measure slot.
  function calcPanel(dash, s) {
    const { shelf, index } = calcFor;
    const f = s[shelf]?.[index];
    if (!f || roleOf(f) !== "measure") { calcFor = null; return null; }
    const c = { type: "none", along: "auto", ...(f.tableCalc ?? {}) };
    const set = (patch) => {
      const next = { ...c, ...patch };
      if (next.type === "none") delete f.tableCalc;
      else f.tableCalc = { type: next.type, along: next.along, ...(next.type === "moving" ? { window: next.window ?? 3 } : {}) };
      commit(dash, s);
    };
    const panel = el("div", "ws-toolpanel ws-calc");
    const head = el("div", "ws-toolpanel__head");
    const title = el("span", "ws-toolpanel__title");
    title.append(icon("calc"), ` Table calculation · ${f.agg ?? "sum"} ${f.table}.${f.column}`);
    const close = iconButton("close", "Close editor");
    close.addEventListener("click", () => { calcFor = null; renderShelves(); });
    head.append(title, close);
    const row = el("div", "ws-cf__row");
    row.append(fmtSelect("Calculation", CALC_CHOICES, c.type, (v) => set({ type: v })));
    if (c.type !== "none") row.append(fmtSelect("Along", ALONG_CHOICES, c.along, (v) => set({ along: v })));
    if (c.type === "moving") row.append(fmtSelect("Window", WINDOW_CHOICES.map((n) => [n, `${n} values`]), c.window ?? 3, (v) => set({ window: Number(v) })));
    panel.append(head, row, el("span", "ws-shelf__note",
      "Computed in the browser over the rows returned, in the sort order — restarting for each member of the other shelf's dimensions."));
    return panel;
  }

  // Field choices: a shelf pill may carry alternative fields; the switcher on the chart card picks one.
  const sameRef = (a, b) => a.db === b.db && a.table === b.table && a.column === b.column;
  function choicesOf(f) { return f.choices?.length ? f.choices : [{ db: f.db, table: f.table, column: f.column, category: f.category }]; }
  function addChoice(dash, s, shelf, index, field) {
    const f = s[shelf][index];
    const list = choicesOf(f);
    if (list.some((c) => sameRef(c, field))) return;
    if (list.length >= LIMITS.fieldChoices) { toast(`A slot can switch between at most ${LIMITS.fieldChoices} fields.`, "info"); return; }
    f.choices = [...list, { db: field.db, table: field.table, column: field.column, category: field.category }];
    commit(dash, s);
  }
  function removeChoice(dash, s, shelf, index, c) {
    const f = s[shelf][index];
    const rest = choicesOf(f).filter((x) => !sameRef(x, c));
    if (sameRef(f, c)) switchField(f, rest[0]); // removing the shown one shows the next
    if (rest.length >= 2) f.choices = rest; else delete f.choices;
    commit(dash, s);
  }
  // Put a choice in the slot: the field changes, the slot's role stays; a measure keeps its aggregation
  // when the new field supports it, else takes the first it does.
  function switchField(f, c) {
    Object.assign(f, { db: c.db, table: c.table, column: c.column, category: c.category });
    if (c.category !== "temporal") delete f.datePart; // a date part only means something on a date field
    if (f.agg && !aggsFor(c.category).includes(f.agg)) f.agg = aggsFor(c.category)[0];
  }
  function choicesPanel(dash, s) {
    const { shelf, index } = choicesFor;
    const f = s[shelf]?.[index];
    if (!f) { choicesFor = null; return null; }
    const panel = el("div", "ws-toolpanel ws-choices");
    const head = el("div", "ws-toolpanel__head");
    const title = el("span", "ws-toolpanel__title");
    title.append(icon("swap"), ` Choices for ${shelf === "columns" ? "Columns" : "Rows"} · ${f.table}.${f.column}`);
    const close = iconButton("close", "Close editor");
    close.addEventListener("click", () => { choicesFor = null; renderShelves(); });
    head.append(title, close);
    const zone = el("div", "ws-toolpanel__zone");
    for (const c of choicesOf(f)) {
      const p = pill(`${c.table}.${c.column}`, () => removeChoice(dash, s, shelf, index, c));
      p.classList.add("ws-pill--mark");
      if (sameRef(c, f)) p.prepend(el("span", "ws-pill__badge", "Showing"));
      zone.append(p);
    }
    wireFieldDrop(zone, (field) => addChoice(dash, s, shelf, index, field));
    panel.append(head, zone, el("span", "ws-shelf__note",
      choicesOf(f).length < 2 ? "Drop more fields here — then pick between them on the chart card." : "Pick the field to show with the switcher on the chart card."));
    return panel;
  }
  // The chart card's switchers: one "Show" select per slot that has choices.
  function switchers(dash, s) {
    const slots = [];
    for (const shelf of ["columns", "rows"]) s[shelf].forEach((f, index) => { if (f.choices?.length >= 2) slots.push({ shelf, index, f }); });
    if (!slots.length) return null;
    const row = el("div", "ws-switchers");
    for (const { shelf, f } of slots) {
      const opts = f.choices.map((c) => [`${c.db}.${c.table}.${c.column}`, `${c.table}.${c.column}`]);
      const label = `${shelf === "columns" ? "Columns" : "Rows"}: show`;
      row.append(fmtSelect(label, opts, `${f.db}.${f.table}.${f.column}`, (v) => {
        const c = f.choices.find((x) => `${x.db}.${x.table}.${x.column}` === v);
        if (c) { switchField(f, c); commit(dash, s); }
      }));
    }
    return row;
  }

  // The value editor for a filter, by operator (P14).
  // P32: a filter value can follow a parameter of the field's type (scalar / text-match / top-N count).
  const pv = (f) => withParamValue(f, parameters);
  const PARAMABLE = new Set(["=", "!=", ">", ">=", "<", "<=", "contains", "startsWith", "endsWith", "top"]);
  function paramChoices(f) {
    const t = f.op === "top" ? "number" : paramTypeFor(f.category);
    return t ? parameters.filter((p) => p.type === t) : [];
  }
  function paramBinding(dash, s, f) {
    if (!PARAMABLE.has(f.op)) return null;
    const choices = paramChoices(f);
    const b = iconButton("param", f.param ? "Use a fixed value instead of the parameter" : "Use a parameter for this value");
    b.classList.add("ws-pill__param");
    b.setAttribute("aria-pressed", String(Boolean(f.param)));
    b.addEventListener("click", () => {
      if (f.param) { f.value = String(pv(f).value ?? ""); delete f.param; commit(dash, s); return; }
      if (!choices.length) { toast(`No ${f.op === "top" ? "number" : paramTypeFor(f.category) ?? ""} parameter yet — add one from Workbook → Parameters….`, "info"); return; }
      f.param = choices[0].id; commit(dash, s);
    });
    return b;
  }
  function filterValueControl(dash, s, f) {
    if (f.param && f.op !== "top") {
      const sel = el("select", "select select--light ws-pill__paramsel");
      sel.setAttribute("aria-label", `Parameter for ${f.table}.${f.column}`);
      for (const p of paramChoices(f)) sel.add(new Option(`= ${p.name} (${p.value})`, p.id, false, p.id === f.param));
      sel.addEventListener("change", () => { f.param = sel.value; commit(dash, s); });
      const wrap = el("span", "ws-pill__pwrap");
      wrap.append(sel, paramBinding(dash, s, f));
      return wrap;
    }
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
    // P30: relative date — a period preset; top-N — n, the ranking measure, top or bottom.
    if (f.op === "relative") {
      const choices = PRESET_CHOICES.filter(([v]) => v !== "custom");
      const sel = select(choices.map(([v]) => v), f.value || "", "ws-pill__rel", `Date range for ${f.table}.${f.column}`);
      if (!f.value) { sel.prepend(new Option("Pick…", "")); sel.value = ""; }
      for (const o of sel.options) { const c = choices.find(([v]) => v === o.value); if (c) o.textContent = c[1].toLowerCase(); }
      sel.addEventListener("change", () => { f.value = sel.value; commit(dash, s); });
      return sel;
    }
    if (f.op === "top") return topControl(dash, s, f);
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
    const bind = paramBinding(dash, s, f);
    if (!bind) return val;
    const wrap = el("span", "ws-pill__pwrap");
    wrap.append(val, bind);
    return wrap;
  }

  // P30 top-N editor: [top|bottom] [n] by [measure on the shelves].
  function topControl(dash, s, f) {
    const wrap = el("span", "ws-pill__top");
    const dir = select(["top", "bottom"], f.bottom ? "bottom" : "top", "ws-pill__topdir", `Top or bottom for ${f.table}.${f.column}`);
    dir.addEventListener("change", () => { f.bottom = dir.value === "bottom"; commit(dash, s); });
    let n;
    if (f.param) {
      n = el("select", "select select--light ws-pill__paramsel");
      n.setAttribute("aria-label", `Parameter for how many ${f.table}.${f.column}`);
      for (const p of paramChoices(f)) n.add(new Option(`${p.name} (${p.value})`, p.id, false, p.id === f.param));
      n.addEventListener("change", () => { f.param = n.value; commit(dash, s); });
    } else {
      n = el("input", "input ws-pill__val ws-pill__topn");
      n.value = f.value ?? ""; n.inputMode = "numeric"; n.placeholder = "10"; n.maxLength = 4;
      n.setAttribute("aria-label", `How many for ${f.table}.${f.column}`);
      n.addEventListener("change", () => { f.value = n.value.trim(); commit(dash, s); });
    }
    const measures = planMeasures(s).filter((e) => e.role === "shelf");
    const opts = measures.map((e) => [`${e.field.db}.${e.field.table}.${e.field.column}:${e.agg}`, measureName({ ...e.field, agg: e.agg })]);
    const cur = f.topBy ? `${f.topBy.db}.${f.topBy.table}.${f.topBy.column}:${f.topBy.agg ?? "sum"}` : "";
    const by = el("select", "select select--light ws-pill__topby");
    by.setAttribute("aria-label", `Rank ${f.table}.${f.column} by`);
    if (!opts.length) by.append(new Option("add a measure to rank by", ""));
    for (const [v, t] of opts) { const o = new Option(`by ${t}`, v); if (v === cur) o.selected = true; by.add(o); }
    // Default to the first shelf measure the first time.
    if (!f.topBy && measures[0]) { const e = measures[0]; f.topBy = { db: e.field.db, table: e.field.table, column: e.field.column, agg: e.agg }; }
    by.addEventListener("change", () => {
      const e = measures.find((m) => `${m.field.db}.${m.field.table}.${m.field.column}:${m.agg}` === by.value);
      if (e) { f.topBy = { db: e.field.db, table: e.field.table, column: e.field.column, agg: e.agg }; commit(dash, s); }
    });
    wrap.append(dir, n, by);
    const bind = paramBinding(dash, s, f);
    if (bind) wrap.append(bind);
    return wrap;
  }

  // P32 parameter controls: one per parameter this sheet uses (its filters, shared filters, Top N) — a
  // select for a list, a slider + box for a number range, else a typed input. Every value is checked.
  function paramControls(s) {
    const used = new Set([...s.filters, ...sharedFilters].map((f) => f.param).filter(Boolean));
    if (s.format?.topNParam) used.add(s.format.topNParam);
    const ps = parameters.filter((p) => used.has(p.id));
    if (!ps.length) return null;
    const row = el("div", "ws-params");
    row.setAttribute("aria-label", "Parameters");
    for (const p of ps) {
      const wrap = el("label", "ws-param");
      wrap.append(el("span", "ws-param__name", p.name));
      const setValue = (raw) => {
        const r = checkValue(p, raw);
        if (!r.ok) { toast(r.error, "danger"); renderShelves(); return; }
        updateParameter(p.id, { value: r.value });
      };
      const a = p.allowed ?? { kind: "any" };
      if (a.kind === "list") {
        const sel = el("select", "select select--light");
        for (const v of a.list) sel.add(new Option(v, v, false, String(v) === String(p.value)));
        sel.addEventListener("change", () => setValue(sel.value));
        wrap.append(sel);
      } else if (p.type === "number" && a.kind === "range" && a.min != null && a.max != null) {
        const slider = el("input", "ws-param__range"); slider.type = "range";
        slider.min = a.min; slider.max = a.max; slider.step = a.step ?? (Number.isInteger(a.min) && Number.isInteger(a.max) ? 1 : "any");
        slider.value = p.value;
        const out = el("input", "input ws-param__num"); out.value = p.value; out.inputMode = "decimal";
        slider.addEventListener("input", () => { out.value = slider.value; });
        slider.addEventListener("change", () => setValue(slider.value));
        out.addEventListener("change", () => setValue(out.value));
        slider.setAttribute("aria-label", p.name); out.setAttribute("aria-label", `${p.name} value`);
        wrap.append(slider, out);
      } else {
        const i = el("input", "input ws-param__num");
        if (p.type === "date") i.type = "date";
        i.value = p.value; if (p.type === "number") i.inputMode = "decimal";
        i.addEventListener("change", () => setValue(i.value));
        wrap.append(i);
      }
      row.append(wrap);
    }
    return row;
  }

  // P30 filter cards: each of the sheet's filters (and the shared ones that apply here) as a card above
  // the chart — a checkbox list for `in`, the filter's own editor otherwise. Same objects as the Filters
  // tool, so the two always agree.
  function filterCards(dash, s) {
    const list = [...s.filters.map((f, i) => ({ f, i, src: s.filters })), ...sharedFilters.map((f, i) => ({ f, i, src: sharedFilters }))];
    if (!list.length || s.showFilterCards === false) return null;
    const row = el("div", "ws-filtercards");
    row.setAttribute("aria-label", "Filter cards");
    for (const { f, i, src } of list) {
      const card = el("div", `ws-fcard${checkFilter(f).state === "invalid" ? " is-invalid" : ""}`);
      const head = el("div", "ws-fcard__head");
      head.append(el("span", "ws-fcard__name", nameOf(f)));
      if (src === sharedFilters) head.append(el("span", "ws-pill__badge", "All dashboards"));
      const x = iconButton("close", `Remove the filter on ${nameOf(f)}`);
      x.addEventListener("click", () => { src.splice(i, 1); commit(dash, s); });
      head.append(x);
      card.append(head);
      if (f.op === "in") card.append(checklist(dash, s, f));
      else {
        const body = el("div", "ws-fcard__body");
        if (f.op !== "top") body.append(el("span", "ws-fcard__op", OP_LABELS[f.op] ?? f.op)); // top-N names itself
        body.append(filterValueControl(dash, s, f));
        card.append(body);
      }
      row.append(card);
    }
    return row;
  }
  // An `in` filter as checkboxes over its distinct values (bounded, cached) with a quick search.
  function checklist(dash, s, f) {
    const box = el("div", "ws-fcard__list");
    box.append(el("span", "ws-note", "Loading…"));
    distinctFor(f.db, f.table, f.column).then((vals) => {
      box.replaceChildren();
      const chosen = new Set(f.values ?? []);
      for (const v of vals.slice(0, DISTINCT_SHOWN)) {
        const val = v == null ? "" : String(v);
        const row = el("label", "ws-fcard__item");
        const cb = el("input"); cb.type = "checkbox"; cb.checked = chosen.has(val);
        cb.addEventListener("change", () => {
          const set = new Set(f.values ?? []);
          if (cb.checked) set.add(val); else set.delete(val);
          f.values = [...set];
          commit(dash, s);
        });
        row.append(cb, el("span", null, v == null ? "—" : String(v)));
        box.append(row);
      }
      if (vals.length > DISTINCT_SHOWN) box.append(el("span", "ws-note", "Showing the first 200 values — more exist."));
      if (!vals.length) box.append(el("span", "ws-note", "(no values)"));
    }).catch(() => box.replaceChildren(el("span", "ws-note", "(couldn't load values)")));
    return box;
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
  // Chart-type picker: the current type's icon + name; its menu is a two-column grid of every type.
  function chartTypePicker(dash, s) {
    const wrap = el("div", "menu ws-pick ws-pick--chart");
    const btn = el("button", "ws-pick__btn"); btn.type = "button";
    btn.title = "Chart type";
    btn.setAttribute("aria-label", `Chart type: ${chartLabel(s.chartType)}`);
    btn.append(icon(chartIcon(s.chartType)), el("span", "ws-pick__text", chartLabel(s.chartType)), caret());
    const list = el("div", "menu__list menu__list--start ws-charttypes");
    list.setAttribute("role", "menu"); list.setAttribute("aria-label", "Chart type"); list.hidden = true;
    for (const [v, lbl] of CHART_TYPES)
      list.append(radioItem(chartIcon(v), lbl, v === s.chartType, () => {
        if (s.chartType === v) return;
        s.chartType = v;
        commit(dash, s);
        focusPicker("ws-pick--chart");
      }));
    wrap.append(btn, list);
    wireMenu(btn, list, { signal: headerAbort.signal });
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
    if (entry.role === "measure") entry.agg = defaultAgg(f);
    list.push(entry);
    normaliseShelf(dash.sheet, shelfKey); // keep dimensions ahead of measures
    commit(dash, dash.sheet);
  }
  // P28: a field's default aggregation (its setting when the column supports it, else sum).
  function defaultAgg(f) {
    const a = metaOf(f).agg;
    return a && aggsFor(f.category).includes(a) ? a : "sum";
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
      { key: "filters", icon: "filter", label: "Filters", count: s.filters.length + sharedFilters.length,
        pills: [...s.filters.map((f, i) => filterPill(dash, s, f, i, s.filters)),
          ...sharedFilters.map((f, i) => filterPill(dash, s, f, i, sharedFilters))],
        onDrop: (f) => addFilter(dash, f),
        hint: "Drop a field to filter the view by it — share a filter (link button) to apply it on every dashboard",
        note: sharedNote(s) },
      { key: "period", icon: "calendar", label: "Date range", count: s.period ? 1 : 0,
        pills: s.period ? [markPill(s.period, () => { s.period = null; commit(dash, s); })] : [],
        onDrop: (f) => setPeriod(dash, f), editor: s.period ? periodEditor(dash, s) : null,
        hint: "Drop a date field to limit the view to a range — and compare it with another period" },
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
    btn.addEventListener("click", () => { openTool = openTool === tool.key ? null : tool.key; choicesFor = null; calcFor = null; formatOpen = false; showMeOpen = false; renderShelves(); });
    btn.addEventListener("dragover", (e) => { if (hasField(e)) { e.preventDefault(); btn.classList.add("is-over"); } });
    btn.addEventListener("dragleave", () => btn.classList.remove("is-over"));
    btn.addEventListener("drop", (e) => {
      btn.classList.remove("is-over");
      const f = readField(e);
      if (f) { e.preventDefault(); openTool = tool.key; choicesFor = null; calcFor = null; tool.onDrop(f); } // set open BEFORE onDrop's commit re-renders
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
    if (tool.editor) panel.append(tool.editor);
    if (tool.note) panel.append(el("span", "ws-shelf__note", tool.note));
    return panel;
  }

  // --- Date range & comparison (P35) ---------------------------------------
  function setPeriod(dash, f) {
    if (f.category !== "temporal") { toast("Date range needs a date or date-time field.", "info"); return; }
    dash.sheet.period = newPeriod(f);
    commit(dash, dash.sheet);
  }
  // The Date range editor: preset (or custom days), comparison (or custom days), and the resolved ranges.
  function periodEditor(dash, s) {
    const p = s.period;
    const set = (patch) => { s.period = { ...p, ...patch }; commit(dash, s); };
    const box = el("div", "ws-period");
    const row = el("div", "ws-period__row");
    row.append(fmtSelect("Range", PRESET_CHOICES, p.preset, (v) => set({ preset: v })));
    if (p.preset === "custom") row.append(dayInput("From", p.from, (v) => set({ from: v })), dayInput("To", p.to, (v) => set({ to: v })));
    row.append(fmtSelect("Compare to", COMPARE_CHOICES, p.compare, (v) => set({ compare: v })));
    if (p.compare === "custom")
      row.append(dayInput("From", p.compareFrom, (v) => set({ compareFrom: v })), dayInput("To", p.compareTo, (v) => set({ compareTo: v })));
    box.append(row);
    const range = resolveRange(p);
    const cmp = compareRange(p, range);
    const summary = !range ? "Pick both days — From on or before To."
      : p.compare === "custom" && !cmp ? `${rangeLabel(range)} · pick both comparison days.`
      : `${rangeLabel(range)}${cmp ? ` vs ${rangeLabel(cmp)}` : ""}`;
    box.append(el("span", `ws-shelf__note${range ? "" : " ws-shelf__note--warn"}`, summary));
    if (cmp && !COMPARE_TYPES.has(s.chartType))
      box.append(el("span", "ws-shelf__note", "The comparison shows on Bar, Line, Area and KPI; this chart uses the range only."));
    return box;
  }
  function dayInput(labelText, value, onChange) {
    const wrap = el("label", "ws-fmt-field");
    wrap.append(el("span", "ws-fmt-label", labelText));
    const inp = el("input", "input ws-fmt-input");
    inp.type = "date";
    inp.value = value ?? "";
    inp.addEventListener("change", () => onChange(inp.value || null));
    wrap.append(inp);
    return wrap;
  }
  // The period's range filter for a plan (its own range, or `range` for the comparison query).
  function periodFilters(sheet, range) {
    const p = sheet.period;
    const r = range ?? resolveRange(p);
    return p && r ? [rangeFilter(p, r, isDateOnlyColumn(p.db, p.table, p.column))] : [];
  }
  // The comparison result for the current view, or null (no comparison / not drawn for this chart / failed).
  // undefined = superseded by a newer query.
  async function fetchCompare(dash, s, ticket) {
    const p = s.period;
    if (!p || !COMPARE_TYPES.has(s.chartType)) return null;
    const range = compareRange(p, resolveRange(p));
    if (!range) return null;
    const plan = buildPlan(s, range);
    if (!plan) return null;
    const key = requestKey("query", plan);
    let result = results.get(dash.id, key);
    if (!result) {
      try { result = await api.query(plan, { signal: ticket.signal }); }
      catch (err) { if (!ticket.isCurrent() || isAbortError(err)) return undefined; toast(`Comparison failed: ${err.message}`, "danger"); return null; }
      if (!ticket.isCurrent()) return undefined;
      results.set(dash.id, key, result);
    }
    return { result, range, name: compareName(p.compare) };
  }
  // The range line for the notice: "1 Sep – 30 Sep 2026 vs 2 Aug – 31 Aug 2026".
  function periodNotice(s, cmp) {
    const range = s.period ? resolveRange(s.period) : null;
    if (!range) return s.period ? "Date range not applied — pick both days." : null;
    return `${rangeLabel(range)}${cmp ? ` vs ${rangeLabel(cmp.range)}` : ""}`;
  }

  // Wire a zone as a field-only drop target (no pill reorder). Shared by the tool panel.
  function wireFieldDrop(zone, onDrop) {
    zone.addEventListener("dragover", (e) => { if (hasField(e)) { e.preventDefault(); zone.classList.add("is-over"); } });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => { zone.classList.remove("is-over"); const f = readField(e); if (f) { e.preventDefault(); onDrop(f); } });
  }
  // A marks-encoding pill: table.column + a remove button, tinted as a marks pill.
  function markPill(f, remove) {
    const p = pill(nameOf(f), remove);
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
          commitQuiet(dash, s);
        }, 1500);
        commit(dash, s);
      });
      wrap.append(play);
    }
    return wrap;
  }
  // Every edit goes through commit() → dashboard:changed → renderShelves + runChart. P23: each commit also
  // records the previous committed sheet for undo (edits mutate the sheet in place, so the "before" is
  // the snapshot taken at the last commit). commitQuiet skips the history (Pages autoplay).
  const commit = (dash, sheet) => {
    const before = lastSnap.get(dash.id);
    if (before) history.record(dash.id, before);
    lastSnap.set(dash.id, structuredClone(sheet));
    updateSheet(dash.id, sheet);
  };
  const commitQuiet = (dash, sheet) => { lastSnap.set(dash.id, structuredClone(sheet)); updateSheet(dash.id, sheet); };

  // --- chart ---------------------------------------------------------------
  async function runChart() {
    const dash = activeDashboard();
    if (!dash) return;
    const ticket = gate.begin(); // aborts any in-flight query for the previous state
    disposeChart(); // tear down any live ECharts instance before we repaint the chart pane
    chartEl.onscroll = null; // only the Table view loads on scroll (runTable sets it)
    setStatusBar(null, null);
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
    const key = requestKey("query", plan);
    if (s.chartType === "table") { await runTable(dash, s, plan, key, ticket, filterNote); return; }
    const fresh = freshNext; freshNext = false;
    const result = await fetchCached(dash, ticket, key, (signal) => api.query(fresh ? { ...plan, fresh: true } : plan, { signal }));
    if (!result) return;
    const cmp = await fetchCompare(dash, s, ticket);
    if (cmp === undefined) return; // superseded while the comparison ran
    try {
      renderChart(s, result, cmp);
      setStatusBar(s, result);
      // An "Other" mark already says how much is past the limit, so no truncation line on top of it.
      const shownOther = result.other && OTHER_TYPES.has(s.chartType);
      setNotice(joinNotices(filterNote, speedNotice(result), sharedNote(s), periodNotice(s, cmp), extraNotice, shownOther ? null : truncationNotice({ truncated: result.truncated, chartType: s.chartType, limit: plan.limit }), bucketNotice(result.bucket)));
    } catch (err) {
      console.error(err);
      chartEl.replaceChildren(warn("This view couldn't be drawn — try another chart type or remove a field."));
    }
  }

  // Table view: the first page (cached like any result), then each further page as the pane scrolls near
  // its end. Every page is the same ordered query with a growing OFFSET, so they line up exactly; the
  // crosstab is redrawn from all loaded rows (a pivot row split across two pages fills in).
  async function runTable(dash, s, plan, key, ticket, filterNote) {
    const reuse = tablePager && tablePager.dashId === dash.id && tablePager.key === key ? tablePager : null;
    if (tablePager && !reuse) tablePager.ctl?.abort();
    const first = await fetchCached(dash, ticket, key, (signal) => api.query(plan, { signal }));
    if (!first) return;
    tablePager = reuse ?? { dashId: dash.id, key, plan, rows: first.rows, total: first.total ?? first.rows.length, loading: false, ctl: null, first };
    const draw = () => {
      const top = chartEl.scrollTop;
      try { renderChart(s, { ...tablePager.first, rows: tablePager.rows, partial: tablePager.rows.length < tablePager.total }); setStatusBar(s, { ...tablePager.first, rows: tablePager.rows }); }
      catch (err) { console.error(err); chartEl.replaceChildren(warn("This view couldn't be drawn — try another chart type or remove a field.")); }
      chartEl.scrollTop = top;
      setNotice(joinNotices(filterNote, periodNotice(s, null), extraNotice, tableProgress(tablePager.rows.length, tablePager.total)));
    };
    draw();
    const pager = tablePager;
    const more = async () => {
      if (pager !== tablePager || pager.loading || !needsNextPage(chartEl, pager.rows.length, pager.total)) return;
      pager.loading = true;
      pager.ctl = new AbortController();
      try {
        const page = await api.query({ ...pager.plan, offset: pager.rows.length, withTotal: false }, { signal: pager.ctl.signal });
        if (pager !== tablePager) return;
        pager.rows = pager.rows.concat(page.rows);
        if (!page.rows.length) pager.total = pager.rows.length; // the data shrank under us — stop asking
        draw();
      } catch (err) {
        if (!isAbortError(err) && pager === tablePager) toast(err.message, "danger");
        pager.total = pager.rows.length; // don't retry in a loop; Refresh starts over
      } finally {
        pager.loading = false;
      }
      if (pager === tablePager) more(); // a tall pane may need another page straight away
    };
    chartEl.onscroll = more;
    more();
  }

  // P33: say when a result is approximate or came from the server's cache.
  function speedNotice(result) {
    const parts = [];
    if (result.approx) parts.push(`Approximate${result.approx.distinct ? " — distinct counts estimated" : ""}${result.approx.sample ? `${result.approx.distinct ? ";" : " —"} a ${Math.round(result.approx.sample * 100)}% sample, scaled up` : ""}`);
    if (result.cached) parts.push("From the server cache (under a minute old) — Refresh re-runs it");
    return parts.join(" · ") || null;
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
    if (cached) { markFresh(false); return cached; }
    chartEl.replaceChildren(loadingView());
    try {
      const result = await run(ticket.signal);
      if (!ticket.isCurrent()) return null;
      results.set(dash.id, key, result);
      markFresh(true);
      return result;
    } catch (err) {
      if (!ticket.isCurrent() || isAbortError(err)) return null;
      chartEl.replaceChildren(warn(err.message));
      return null;
    }
  }

  // P33: "Loading…" with a Cancel button — it aborts the request (and the server stops the ClickHouse
  // query when the browser goes away), leaving a note to run it again.
  function loadingView() {
    const box = el("div", "ws-loading");
    box.append(el("span", null, "Loading…"));
    const cancel = makeButton("Cancel", "btn ws-loading__cancel");
    cancel.addEventListener("click", () => {
      gate.cancel();
      chartEl.replaceChildren(hint("Query cancelled — Refresh runs it again."));
      setNotice(null);
    });
    box.append(cancel);
    return box;
  }

  // A result straight from ClickHouse animates in (ECharts' entrance, or a fade for the table/KPI);
  // a re-render from the cache (format tweaks, theme flip) repaints without motion.
  function markFresh(fresh) {
    animateNextChart(fresh);
    chartEl.classList.toggle("is-fresh", fresh);
  }

  // The notice line at the top of the chart card (e.g. "Showing the top 50 — more exist").
  function setNotice(text) {
    if (!noticeEl) return;
    noticeEl.replaceChildren(...(text ? [icon("info", { size: 14 }), el("span", null, text)] : []));
    toggle(noticeEl, Boolean(text));
  }

  // P12 histogram / box plot: single-table distribution charts. Histogram buckets one numeric column;
  // a box plot summarises one numeric measure, optionally grouped by one same-table dimension. They
  // use their own endpoints (a bucketing / quantile query shape), so they read fields directly rather
  // than through buildPlan. All fields must live on ONE table (the endpoints don't join).
  async function runStatChart(dash, s, ticket, filterNote = null) {
    const allFields = [...s.columns, ...s.rows];
    const numeric = allFields.find((f) => f.category === "numeric");
    if (!numeric) {
      chartEl.replaceChildren(hint(statFieldHint(s.chartType)));
      return;
    }
    const { db, table } = numeric;
    // Only same-table, usable filters apply (the single-table endpoints take in/between too);
    // the rest are counted and reported in the notice.
    const { apply: filters, ignored } = statFilters(s.filters.map(pv), db, table, toFilter);
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
      const req = { dimension: dim ? dim.column : null, measure: numeric.column, filters, limit: s.format?.topN ?? LIMITS.rows };
      const result = await fetchCached(dash, ticket, requestKey("boxplot", { db, table, req }),
        (signal) => api.boxplot(db, table, req, { signal }));
      if (!result) return;
      if (!result.groups?.length) { chartEl.replaceChildren(hint("No data for this field.")); setNotice(joinNotices(filterNote, ignoredNote)); return; }
      chartEl.replaceChildren();
      renderSeriesChart(chartEl, { type: "boxplot", boxes: result.groups, format: s.format ?? defaultFormat() });
      setNotice(joinNotices(filterNote, ignoredNote, truncationNotice({ truncated: result.truncated, chartType: "boxplot", limit: req.limit })));
    }
  }

  function buildPlan(sheet, periodRange) {
    // Fields split by shelf AND type. Categorical pills are dimensions: Rows-shelf ones become the
    // crosstab's left stub, Columns-shelf ones the top header. Numeric pills are measures (the cell
    // values); we send them column-shelf-first then row-shelf-first so the result's measure order
    // lines up with measureAxis() at render time (the shelf decides where the measure band sits).
    // P26: a date pill's part rides along (auto = left to the chart-wide Group dates).
    const toDim = (f) => ({ db: f.db, table: f.table, column: f.column,
      ...(f.category === "temporal" && f.datePart && f.datePart !== "auto" ? { datePart: f.datePart } : {}) });
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
    const rangeFilters = periodFilters(sheet, periodRange); // P35 — like a filter, it may bring its table in
    rangeFilters.forEach(add);
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
    // P40 shared filters: applied when their table is already in the query (never forcing a join).
    const shared = sharedFilters.map(pv).filter((f) => checkFilter(f).state === "ok" && involved.includes(keyOf(f.db, f.table))).map(toFilter).filter(Boolean);
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
      filters: [...sheet.filters.map(pv).filter((f) => checkFilter(f).state === "ok").map(toFilter).filter(Boolean), ...selFilters, ...shared, ...drillPathFilters(sheet), ...pageFilters, ...rangeFilters],
      // Top-N (P10) caps a chart's groups (server sorts, then limits; "All" = the 5,000 cap) — plus the
      // "Other" mark and date grouping; the table pages instead (scale-model.js).
      ...scalePlan(sheet.chartType, { ...sheet.format, topN: effectiveTopN(sheet.format, parameters, LIMITS.rows) }, rowDimensions.length + columnDimensions.length),
      ...(sheet.format?.approximate ? { approximate: true } : {}), // P33
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
          joins.push({ left: col(edge.from), right: col(edge.to), ...(edge.type === "left" ? { type: "left" } : {}) }); // P31
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
      g.get(a.key).push({ from: a, to: b, type });
    };
    let type = "inner";
    for (const rel of relationships.values()) {
      const fe = entities.get(rel.from.entityId), te = entities.get(rel.to.entityId);
      if (!fe || !te) continue;
      const a = { key: keyOf(fe.db, fe.table), db: fe.db, table: fe.table, column: rel.from.column };
      const b = { key: keyOf(te.db, te.table), db: te.db, table: te.table, column: rel.to.column };
      if (a.key === b.key) continue;
      type = rel.joinType === "left" ? "left" : "inner";
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
  function renderChart(sheet, result, cmp = null) {
    chartEl.replaceChildren();
    extraNotice = null;
    // Date-grouped key: its labels are bucket starts, not values a filter could match — no click-to-filter.
    bucketedKey = result.bucket ? result.bucket.key : null;
    // "Other": the server's aggregate of every group past the limit, drawn as one last mark.
    if (result.other && OTHER_TYPES.has(sheet.chartType)) result = { ...result, rows: withOther(result.rows, result.other) };
    // P26: date-part keys read as "Mar 2024" / "Q1" / "Mon"; like a date-grouped axis, they aren't click-filterable.
    const parts = planDims(sheet).keyOrder.map((f) => f?.datePart ?? null);
    result = labelParts(result, parts);
    if (cmp) cmp = { ...cmp, result: labelParts(cmp.result, parts) };
    if (isGroupingPart(parts[0])) bucketedKey = 0;
    // P28: display names on axes, legends and headers (the query used the real columns).
    result = aliasNames(sheet, result);
    // P27: quick table calculations replace their measure's values (over the rows on hand).
    const calcs = planMeasures(sheet).map((e) => (e.role === "shelf" ? e.field.tableCalc ?? null : null));
    const applied = applyTableCalcs(result, calcs, result.rowDimensions.length, result.columnDimensions.length);
    result = applied.result;
    calcPercent = applied.percent;
    if (cmp) cmp = { ...cmp, result: applyTableCalcs(cmp.result, calcs, result.rowDimensions.length, result.columnDimensions.length).result };
    if (calcs.some(isCalc) && (result.truncated || result.partial))
      extraNotice = "Table calculations use only the rows shown — more exist.";
    const { rowDimensions, columnDimensions, measures, rows } = result;
    if (!rows.length) { chartEl.append(hint("No data for these fields.")); return; }
    // P10 formatters: measure values + date-like dimension labels, from the sheet's format config.
    let format = sheet.format ?? defaultFormat(); // let: a percent table calculation adds a "%" suffix
    const fmtVal = makeValueFormatter(format);
    const fmtCat = makeCategoryFormatter(format);
    const type = sheet.chartType;
    // Min/Max of a text or date field comes back as text — only Table, Text and KPI can show that.
    if (!TEXT_VALUE_TYPES.has(type) && rows.some((r) => r.values.some((v) => typeof v === "string"))) {
      chartEl.replaceChildren(hint(TEXT_VALUE_HINT));
      return;
    }
    // Table + P19 Text mark both render as the crosstab text grid (values written into cells).
    if (type === "table" || type === "text") { chartEl.append(crosstabTable(sheet, result, fmtVal, fmtCat, result.partial)); return; }

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
        chartEl.append(hint(COLOR_SPLIT_HINT));
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
    // P27: a chart whose measures are all percentage calculations reads its values with "%".
    if (seriesIdx.length && seriesIdx.every((mi) => calcPercent.has(mi))) format = { ...format, suffix: "%" };
    // P35: the comparison range's values, lined up with these rows — by position when the first key is
    // the range's own date field (day 1 with day 1), else by the same group keys.
    const byPosition = Boolean(sheet.period) && sameField(planDims(sheet).keyOrder[0] ?? {}, sheet.period);
    const aligned = cmp ? alignCompare(rowsOrdered, cmp.result.rows, byPosition) : null;

    // P12 heatmap/treemap reuse this multi-dimension result but pivot it differently.
    if (type === "heatmap") { renderHeatmap(result, format, fmtCat, fmtVal); return; }
    if (type === "treemap") { renderTreemap(result, format, fmtCat); return; }
    if (P36_TYPES.has(type)) { renderP36(type, rowsOrdered, categories, series, seriesNames, format, fmtCat); return; }

    // KPI: explicit type, or a plain series chart with no dimensions (one value per measure).
    if (type === "kpi" || (dimCount === 0 && (type === "bar" || type === "stacked" || type === "line" || type === "area"))) {
      const prev = cmp && dimCount === 0 ? seriesIdx.map((mi) => cmp.result.rows[0]?.values[mi] ?? null) : null;
      chartEl.append(kpiView(seriesNames, categories, series, dimCount, fmtVal, { prev, name: cmp?.name, format }));
      return;
    }
    // P18 mark channels: Size (bubble), continuous Colour (gradient), field-driven Label + custom
    // Tooltip. All read columns already in `result`; missing/unsupported mappings degrade to a note.
    const marks = marksChannels(sheet, result, mplan, sizeIdx, colorMeasureIdx, fmtVal, fmtCat, rowsOrdered);
    if (marks.note) chartEl.append(hint(marks.note)); // a Marks hint sits above the chart, never blocks it
    // P15 click-to-filter: marks map 1:1 to result rows here, so a click's dataIndex → rowsOrdered[i].keys[0]
    // (the primary dimension's raw value).
    const onSelect = selectHandler(sheet, primaryDim(sheet), type, rowsOrdered.map((r) => (r.isOther ? null : r.keys[0])));
    const otherIndex = rowsOrdered.findIndex((r) => r.isOther);
    // P29: on a pie / donut the legend lists the primary dimension's members; elsewhere it names measures
    // (highlight only — a measure isn't a member to keep or exclude).
    const legendSpec = (type === "pie" || type === "donut")
      ? legendHandler(sheet, primaryDim(sheet), new Map(rowsOrdered.map((r, i) => [categories[i], r.isOther ? undefined : r.keys[0]])))
      : legendHandler(sheet, null, new Map());
    const compareSeries = aligned && (type === "bar" || type === "line" || type === "area")
      ? seriesIdx.map((mi) => ({ name: `${measures[mi]} (${cmp.name})`, data: aligned.map((r) => (r ? r.values[mi] : null)), compare: true }))
      : [];
    // P21 analytics on the first measure: reference line, band, trend (+ forecast categories appended).
    let catsOut = categories, seriesOut = [...series, ...compareSeries], analytics = null;
    const A = sheet.analytics;
    if (A && ANALYTICS_TYPES.has(type) && series.length) {
      const vals = series[0].data;
      const refKind = A.ref?.kind ?? "none";
      const rv = refKind === "none" ? null : refValue(refKind, vals, A.ref.value);
      const fc = type === "line" || type === "area" ? A.forecast ?? 0 : 0;
      const t = (A.trend && A.trend !== "none") || fc ? trendSeries(A.trend ?? "none", vals, fc) : null;
      const trendLabel = TREND_CHOICES.find(([v]) => v === (A.trend && A.trend !== "none" ? A.trend : "linear"))[1].toLowerCase();
      analytics = {
        ref: rv == null ? null : { name: refKind === "constant" ? "Reference" : REF_CHOICES.find(([v]) => v === refKind)[1], value: rv },
        band: A.band ? { from: A.band.from, to: A.band.to } : null,
        trend: t ? { name: `Trend (${trendLabel}${fc ? ` + ${fc} forecast` : ""}) R² ${t.r2.toFixed(2)}`, short: `Trend · R² ${t.r2.toFixed(2)}`, data: t.data } : null,
      };
      if (t && t.extra) {
        catsOut = [...categories, ...Array.from({ length: t.extra }, (_, i) => `Forecast +${i + 1}`)];
        seriesOut = seriesOut.map((sr) => ({ ...sr, data: [...sr.data, ...new Array(t.extra).fill(null)] }));
      }
      if ((t || rv != null) && (result.truncated || result.partial)) extraNotice = joinNotices(extraNotice, "Analytics use only the rows shown — more exist.");
    }
    renderSeriesChart(chartEl, { type, symbol: SCATTER_TYPES.has(type) ? scatterSymbol(type) : undefined, categories: catsOut, series: seriesOut, format, onSelect, orientation: chartOrientation(sheet), otherIndex, analytics, ...legendSpec, ...marks.spec });
  }

  // P36: waterfall / funnel / gauge / bullet / Sankey / small multiples, from the rows already fetched.
  function renderP36(type, rows, categories, series, seriesNames, format, fmtCat) {
    const label = (k) => (k == null ? "—" : fmtCat(k));
    const target = format.target ?? null;
    if (type === "gauge") {
      renderSeriesChart(chartEl, { type, value: series[0].data[0], name: seriesNames[0], target, format });
      return;
    }
    if (type === "bullet") {
      if (target == null) { chartEl.append(hint("Bullet compares each value with a target — set Target in Format.")); return; }
      const cats = categories.some((x) => x) ? categories : [seriesNames[0]]; // no dimension → one bar named after the measure
      renderSeriesChart(chartEl, { type, categories: cats, values: series[0].data, target, name: seriesNames[0], format });
      return;
    }
    if (type === "sankey") {
      // Bipartite links, side-prefixed so a member on both sides stays two nodes; non-positive flows skipped.
      const links = [];
      for (const r of rows) {
        const v = Number(r.values[0]);
        if (Number.isFinite(v) && v > 0) links.push({ source: `s:${label(r.keys[0])}`, target: `t:${label(r.keys[1])}`, value: v });
      }
      if (!links.length) { chartEl.append(hint("No positive values to draw as flows.")); return; }
      renderSeriesChart(chartEl, { type, links, format });
      return;
    }
    if (type === "multiples") {
      // x categories = the second key in first-seen order; one panel per first-key member (result order,
      // capped), each holding one array per measure. `series[si].data` is aligned with `rows`.
      const xCats = [], xIndex = new Map(), panels = new Map();
      for (const r of rows) {
        const x = label(r.keys[1]);
        if (!xIndex.has(x)) { xIndex.set(x, xCats.length); xCats.push(x); }
      }
      rows.forEach((r, ri) => {
        const name = label(r.keys[0]);
        if (!panels.has(name)) {
          if (panels.size >= MAX_PANELS) return;
          panels.set(name, { name, series: seriesNames.map(() => new Array(xCats.length).fill(null)) });
        }
        const p = panels.get(name), xi = xIndex.get(label(r.keys[1]));
        seriesNames.forEach((_, si) => { p.series[si][xi] = series[si].data[ri]; });
      });
      const distinct = new Set(rows.map((r) => label(r.keys[0]))).size;
      extraNotice = distinct > MAX_PANELS ? `Showing the first ${MAX_PANELS} of ${distinct} panels — filter or lower Top-N to see others.` : null;
      renderSeriesChart(chartEl, { type, panels: [...panels.values()], xCats, seriesNames, format });
      return;
    }
    // waterfall / funnel: one measure over the flattened categories.
    renderSeriesChart(chartEl, { type, categories, series: [series[0]], format });
  }

  // P29 legend interaction: { onLegend, focus } for renderSeriesChart. A click highlights that item (a
  // second click clears it); when the legend lists a dimension's members (`field` + `rawByName`), it
  // also selects the member, so the selection bar offers Keep only / Exclude (the click-to-filter path).
  function legendHandler(sheet, field, rawByName) {
    const dash = activeDashboard();
    return {
      focus: legendFocus,
      onLegend: (name) => {
        const again = legendFocus === name;
        legendFocus = again ? null : name;
        const raw = rawByName.get(name);
        if (field && dash && raw !== undefined && raw !== null && bucketedKey === null) {
          if (again) sheet.selection = null;
          else {
            const fmtCat = makeCategoryFormatter(sheet.format ?? defaultFormat());
            sheet.selection = { db: field.db, table: field.table, column: field.column, value: raw,
              label: `${nameOf(field)} = ${fmtCat(raw)}`, action: null };
          }
          commit(dash, sheet);
        } else {
          focusSeries(legendFocus, sheet.chartType);
        }
      },
    };
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
    // P29: legend items are Shape members.
    const byName = new Map([...groupsMap.entries()].map(([gk, g]) => [g.name, JSON.parse(gk)[0]]));
    renderSeriesChart(chartEl, {
      ...legendHandler(sheet, marksOf(sheet).shape, byName),
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
    if (!dimField || !CLICK_TYPES.has(type) || bucketedKey === 0) return undefined;
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
    // P29: each legend item is a Colour member — clicking it highlights that series and selects the member.
    const byName = new Map(series.map((sr, i) => [sr.name, colorVals[i]]));
    const legend = sheet ? legendHandler(sheet, sheet.color?.[0], byName) : {};
    renderSeriesChart(chartEl, { type, categories, series, format, onSelect, orientation, ...legend });
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
  function kpiView(measures, categories, series, dimCount, fmtVal, card = {}) {
    const wrap = el("div", "ws-kpi-row");
    const f = card.format ?? {};
    measures.forEach((name, i) => {
      const data = series[i].data;
      const tile = el("div", "ws-kpi");
      if (dimCount === 0) {
        tile.append(el("div", "widget__kpi-num", fmtVal(data[0])));
        tile.append(el("div", "widget__kpi-sub", name));
        // P35 scorecard: change vs the comparison range — arrow + signed % + tone (never colour alone).
        if (card.prev) {
          const ch = changeOf(data[0], card.prev[i]);
          const tone = toneOf(ch.dir, f.downIsGood);
          const line = el("div", `ws-kpi__change ws-kpi__change--${tone}`);
          line.append(el("span", "ws-kpi__arrow", ch.dir === "up" ? "▲" : ch.dir === "down" ? "▼" : "■"),
            el("span", null, ` ${pctText(ch.pct)} vs ${card.name}`));
          line.title = `${card.name}: ${fmtVal(card.prev[i])}`;
          line.setAttribute("aria-label", `${ch.dir === "flat" ? "No change" : ch.dir === "up" ? "Up" : "Down"} ${pctText(ch.pct)} versus ${card.name} (${fmtVal(card.prev[i])})${tone === "neutral" ? "" : `, ${tone}`}`);
          tile.append(line);
        }
        // Target (first measure): progress bar + "82% of 10,000".
        const goal = i === 0 ? targetProgress(data[0], f.target) : null;
        if (goal) {
          const bar = el("div", `ws-kpi__target${goal.met ? " is-met" : ""}`);
          const fill = el("span", "ws-kpi__target-fill");
          fill.style.width = `${Math.min(100, Math.max(0, goal.pct)).toFixed(1)}%`;
          bar.append(fill);
          bar.setAttribute("role", "img");
          bar.setAttribute("aria-label", `${goal.pct.toFixed(0)}% of target ${fmtVal(f.target)}`);
          tile.append(bar, el("div", "widget__kpi-sub", `${goal.met ? "✓ " : ""}${goal.pct.toFixed(0)}% of ${fmtVal(f.target)}`));
        }
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
  function crosstabTable(sheet, result, fmtVal, fmtCat, partial = false) {
    const { rowDimensions, columnDimensions, measures, rows } = result;
    const cf = conditionalFor(sheet, measures, rows); // P37: per measure index, or null
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
    // P21 totals: a grand-total column (when Columns has dimensions), a grand-total row (when Rows has),
    // and a subtotal after each first-level Rows group — each combined by the measure's own aggregation.
    const tot = sheet.analytics?.totals ?? {};
    const mplanT = planMeasures(sheet);
    const aggOfMi = (mi) => (isCalc(mplanT[mi]?.field?.tableCalc) ? null : mplanT[mi]?.agg ?? (mplanT.length ? "sum" : "count"));
    const total = (mi, rts, cts) => {
      const agg = aggOfMi(mi);
      if (!agg) return null;
      const vals = [];
      for (const rt of rts) for (const ct of cts) vals.push(cellValue(rt, ct, mi));
      return combine(agg, vals);
    };
    const totalCol = Boolean(tot.grand) && cd > 0;
    const totalMis = measureOnLeft ? [null] : measures.map((_, mi) => mi); // total columns: one per measure (on top) or one
    const showVal = (mi, v) => (calcPercent.has(mi) ? (v == null ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`) : fmtVal(v));

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
      if (totalCol) {
        if (measureOnLeft) { if (tl === 0) { const th = el("th", "num xt-total", "Total"); th.rowSpan = Math.max(1, topLevels); tr.append(th); } }
        else if (tl === 0 && topLevels > 1) { const th = el("th", "xt-colhdr xt-total", "Total"); th.colSpan = measures.length; th.rowSpan = topLevels - 1; tr.append(th); }
        else if (tl === topLevels - 1) for (const mi of totalMis) tr.append(el("th", "num xt-meas xt-total", topLevels > 1 ? measures[mi] : `Total ${measures[mi]}`));
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
        const text = calcPercent.has(mi) ? (v == null ? "—" : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`) : fmtVal(v);
        tr.append(cf[mi] ? formattedCell(v, text, cf[mi]) : el("td", "num", text));
      }
      if (totalCol) for (const tmi of totalMis) {
        const mi = tmi ?? leftLeaf.mi;
        tr.append(el("td", "num xt-total", showVal(mi, total(mi, [leftLeaf.tuple], colTuples))));
      }
      tbody.append(tr);
      // Subtotal after the last row of each first-level group (measures on top, ≥ 2 Rows dimensions).
      const next = leftLeaves[ri + 1];
      if (tot.sub && rd >= 2 && !measureOnLeft && (!next || tupleKey([next.tuple[0]]) !== tupleKey([leftLeaf.tuple[0]]))) {
        const group = rowTuples.filter((t) => tupleKey([t[0]]) === tupleKey([leftLeaf.tuple[0]]));
        tbody.append(totalRow(`Subtotal · ${dimLabel(leftLeaf.tuple[0])}`, group, null, "xt-subtotal"));
      }
    });
    // Grand-total row(s): one, or one per measure when measures run down the left.
    if (tot.grand && rd > 0) {
      if (measureOnLeft) measures.forEach((name, mi) => tbody.append(totalRow("Grand total", rowTuples, mi, "xt-grand", name)));
      else tbody.append(totalRow("Grand total", rowTuples, null, "xt-grand"));
    }
    table.append(tbody);
    function totalRow(label, rts, onlyMi, cls, measureName) {
      const tr = el("tr", `xt-total ${cls}`);
      const th = el("th", "xt-rowhdr xt-total", label);
      th.colSpan = rd;
      tr.append(th);
      if (measureOnLeft) tr.append(el("th", "xt-rowhdr xt-meas xt-total", measureName ?? ""));
      for (const topLeaf of topLeaves) {
        const mi = onlyMi ?? topLeaf.mi ?? 0;
        tr.append(el("td", "num xt-total", showVal(mi, total(mi, rts, [topLeaf.tuple]))));
      }
      if (totalCol) for (const tmi of totalMis) { const mi = tmi ?? onlyMi ?? 0; tr.append(el("td", "num xt-total", showVal(mi, total(mi, rts, colTuples)))); }
      return tr;
    }

    const legend = conditionalLegend(cf, measures, fmtVal, partial ? rows.length : 0);
    if (bothMeasures || legend) {
      const wrap = el("div", "xt-wrap");
      if (bothMeasures) wrap.append(warn("Measures are on both shelves — showing them across the top. Put all measures on one shelf for a clean crosstab."));
      if (legend) wrap.append(legend);
      wrap.append(table);
      return wrap;
    }
    return table;
  }

  // --- conditional formatting (P37) ----------------------------------------
  // Per result measure: its setting, value extent over the loaded rows, and token palette — or null.
  function conditionalFor(sheet, measures, rows) {
    const all = sheet.format?.conditional ?? {};
    const mplan = planMeasures(sheet);
    let palette = null;
    return measures.map((name, mi) => {
      const cfg = all[measureKey(mplan[mi])];
      if (!isActive(cfg)) return null;
      palette ??= cfPalette();
      return { cfg, name, ext: extentOf(rows.map((r) => r.values[mi])), palette };
    });
  }
  // Scale colours from the chart tokens: sequential surface → blue; diverging orange ← surface → blue.
  function cfPalette() {
    const cs = getComputedStyle(document.documentElement);
    const t = (n, fb) => cs.getPropertyValue(n).trim() || fb;
    return { surface: t("--surface", "#ffffff"), high: t("--chart-cat-1", "#2a78d6"), low: t("--chart-cat-6", "#eb6834"),
      inks: [t("--ink", "#1c1719"), t("--surface", "#ffffff"), "#000000", "#ffffff"] };
  }
  // One formatted cell: a rule's tone + icon wins; otherwise a scale tint (with a contrast-picked ink)
  // or a data bar behind the number.
  function formattedCell(v, text, { cfg, ext, palette }) {
    const td = el("td", "num xt-cf");
    const rule = matchRule(v, cfg.rules);
    const num = el("span", "xt-cf__num", text);
    if (rule) {
      td.classList.add(`xt-rule--${rule.tone}`);
      const ic = iconSpan("xt-cf__icon", TONE_ICON[rule.tone]);
      ic.setAttribute("aria-hidden", "true");
      td.title = `${CF_TONE_CHOICES.find(([k]) => k === rule.tone)[1]}: ${rule.op} ${rule.value}`;
      td.append(ic);
    } else if (cfg.mode === "scale") {
      const c = scaleColors(v, ext, cfg, palette);
      if (c) { td.style.background = c.bg; td.style.color = c.ink; }
    }
    if (!rule && cfg.mode === "bars") {
      const g = barGeometry(v, ext);
      if (g && g.width > 0) {
        const bar = el("span", `xt-bar${g.neg ? " xt-bar--neg" : ""}`);
        bar.style.left = `${g.left.toFixed(2)}%`;
        bar.style.width = `${g.width.toFixed(2)}%`;
        bar.setAttribute("aria-hidden", "true");
        td.append(bar);
      }
    }
    td.append(num);
    return td;
  }
  // A small key above the table: each scale's low / (mid) / high, each rule with its icon; and, while the
  // table is still loading pages, that the scales cover only the loaded rows.
  function conditionalLegend(cf, measures, fmtVal, loadedRows) {
    const items = [];
    cf.forEach((c, mi) => {
      if (!c) return;
      const name = measures[mi];
      if (c.cfg.mode === "scale" && c.ext) {
        const item = el("span", "xt-legend__item");
        const div = c.cfg.scale === "diverging";
        const lowEnd = div ? c.palette.low : c.palette.surface;
        const strip = el("span", "xt-legend__scale");
        strip.style.background = div
          ? `linear-gradient(to right, ${lowEnd}, ${c.palette.surface}, ${c.palette.high})`
          : `linear-gradient(to right, ${c.palette.surface}, ${c.palette.high})`;
        strip.setAttribute("aria-hidden", "true");
        item.append(el("span", "xt-legend__name", `${name}:`), el("span", null, fmtVal(c.ext.min)), strip, el("span", null, fmtVal(c.ext.max)));
        if (div) item.append(el("span", "xt-legend__note", `(centre ${fmtVal(midpointOf(c.ext, c.cfg.mid))})`));
        item.setAttribute("aria-label", `${name} colour scale from ${fmtVal(c.ext.min)} to ${fmtVal(c.ext.max)}${div ? `, centred on ${fmtVal(midpointOf(c.ext, c.cfg.mid))}` : ""}`);
        items.push(item);
      } else if (c.cfg.mode === "bars") {
        items.push(el("span", "xt-legend__item", `${name}: data bars (from zero)`));
      }
      for (const r of c.cfg.rules ?? []) {
        const item = el("span", `xt-legend__item xt-legend__rule xt-rule--${r.tone}`);
        item.append(iconSpan("xt-cf__icon", TONE_ICON[r.tone]), el("span", null, `${name} ${CF_OP_CHOICES.find(([k]) => k === r.op)[1]} ${fmtVal(r.value)}`));
        items.push(item);
      }
    });
    if (!items.length) return null;
    const box = el("div", "xt-legend");
    box.append(...items);
    if (loadedRows) box.append(el("span", "xt-legend__note", `Scales and bars use the ${loadedRows.toLocaleString("en-US")} rows loaded so far.`));
    return box;
  }

  // The Format card's editor: pick a measure, then its scale / bars and rules.
  function conditionalEditor(dash, s) {
    const f = s.format;
    const mplan = planMeasures(s);
    const box = el("div", "ws-cf");
    box.append(el("span", "ws-fmt-label ws-cf__title", "Conditional formatting"));
    if (!mplan.length) { box.append(el("span", "ws-shelf__note", "Add a measure to format its cells.")); return box; }
    const opts = mplan.map((e) => [measureKey(e), `${e.agg} ${e.field.column}`]);
    if (!opts.some(([k]) => k === cfMeasure)) cfMeasure = opts[0][0];
    const all = f.conditional ?? {};
    const cfg = { ...emptyRule(), ...(all[cfMeasure] ?? {}) };
    const save = (patch) => {
      const next = { ...cfg, ...patch };
      const conditional = { ...all };
      if (isActive(next) || next.mid != null) conditional[cfMeasure] = next; else delete conditional[cfMeasure];
      s.format = { ...f, conditional };
      commit(dash, s);
    };
    const row = el("div", "ws-cf__row");
    row.append(fmtSelect("Measure", opts, cfMeasure, (v) => { cfMeasure = v; renderShelves(); }));
    row.append(fmtSelect("Cells", CF_MODE_CHOICES, cfg.mode, (v) => save({ mode: v })));
    if (cfg.mode === "scale") {
      row.append(fmtSelect("Scale", CF_SCALE_CHOICES, cfg.scale, (v) => save({ scale: v })));
      if (cfg.scale === "diverging")
        row.append(fmtNumber("Midpoint", cfg.mid, "auto", (v) => save({ mid: v })));
    }
    box.append(row);
    cfg.rules.forEach((r, i) => {
      const rr = el("div", "ws-cf__row ws-cf__rule");
      const setRule = (patch) => save({ rules: cfg.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
      rr.append(fmtSelect(`Rule ${i + 1}: value`, CF_OP_CHOICES, r.op, (v) => setRule({ op: v })),
        fmtNumber("", r.value, "number", (v) => { if (v != null) setRule({ value: v }); }),
        fmtSelect("show as", CF_TONE_CHOICES, r.tone, (v) => setRule({ tone: v })));
      const del = iconButton("close", `Remove rule ${i + 1}`);
      del.addEventListener("click", () => save({ rules: cfg.rules.filter((_, j) => j !== i) }));
      rr.append(del);
      box.append(rr);
    });
    if (cfg.rules.length < CF_MAX_RULES) {
      const add = makeButton("+ Add rule", "btn ws-cf__add");
      add.addEventListener("click", () => save({ rules: [...cfg.rules, { op: ">", value: 0, tone: "good" }] }));
      box.append(add);
    }
    return box;
  }
  // P39: the sheet's link action — a label and an https:// template with {value}. Blank template = none.
  function linkActionEditor(dash, s) {
    const a = s.urlAction ?? { label: "", template: "" };
    const box = el("div", "ws-cf ws-link");
    box.append(el("span", "ws-fmt-label ws-cf__title", "Link action"));
    const row = el("div", "ws-cf__row");
    const labelF = fmtText("Label", a.label || null, (v) => {
      if (!s.urlAction) return; // a label alone does nothing until there is a link
      s.urlAction = { ...s.urlAction, label: (v ?? "").slice(0, MAX_LABEL) || "Open link" }; commit(dash, s);
    });
    labelF.querySelector("input").maxLength = MAX_LABEL;
    labelF.querySelector("input").placeholder = "Open link";
    const tplF = fmtText("Link", a.template || null, (v) => {
      if (v == null) { s.urlAction = null; commit(dash, s); return; }
      const err = templateError(v);
      if (err) { fieldError(tplF.querySelector("input"), err); return; }
      s.urlAction = { label: s.urlAction?.label || labelF.querySelector("input").value.trim() || "Open link", template: v };
      commit(dash, s);
    });
    const tplIn = tplF.querySelector("input");
    tplIn.maxLength = MAX_TEMPLATE; tplIn.placeholder = "https://example.com/item/{value}"; tplIn.classList.add("ws-link__tpl");
    tplIn.inputMode = "url"; tplIn.spellcheck = false;
    row.append(labelF, tplF);
    box.append(row, el("span", "ws-shelf__note", "Click a mark, then use the link on the selection bar. {value} becomes the clicked value; only https:// links open, in a new tab."));
    return box;
  }

  // A number field for the Format card: blank → null; a non-number toasts and keeps the old value.
  function fmtNumber(labelText, value, placeholder, onChange) {
    const wrap = el("label", "ws-fmt-field");
    if (labelText) wrap.append(el("span", "ws-fmt-label", labelText));
    const inp = el("input", "input ws-fmt-input ws-cf__num");
    inp.type = "text"; inp.inputMode = "decimal";
    inp.value = value == null ? "" : String(value);
    inp.placeholder = placeholder;
    if (!labelText) inp.setAttribute("aria-label", "Threshold");
    inp.addEventListener("change", () => {
      const raw = inp.value.trim();
      if (!raw) { onChange(null); return; }
      const r = number(raw);
      if (!r.ok) { toast(r.error, "danger"); inp.value = value == null ? "" : String(value); return; }
      onChange(r.value);
    });
    wrap.append(inp);
    return wrap;
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
