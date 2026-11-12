// Shared builder state + event bus (frontend-patterns.md).
//
// Two distinct things:
//   • The DATA MODEL — the tables dragged onto the canvas as entity views, plus the logical
//     relationships between them. There is exactly ONE model, shared across all tabs.
//   • TABS — one ordered list of two kinds, each built FROM the model's tables:
//       worksheet: { id: "ws#N", kind: "worksheet", name, sheet }          (the editor; one chart / table)
//       dashboard: { id: "db#N", kind: "dashboard", name, widgets: [ … ], size }  (a board of worksheet / text / image / spacer / nav widgets; size = null (automatic) or { width, height } px)
//     A widget is { id: "w#N", kind: "sheet", sheetId, x, y, w, h }, { id, kind: "text", heading, body, x, y, w, h }, { id, kind: "image", alt, src (a raster data URL), x, y, w, h }, { id, kind: "spacer", x, y, w, h } or { id, kind: "nav", label, tip, target (a tab id | null), x, y, w, h }
//     (Board/board-model.js owns the geometry rules).
//       story: { id: "st#N", kind: "story", name, steps: [{ caption, target: <a worksheet or dashboard tab id> }] }  (Story/story-model.js)
// The tab strip shows the model ("Data Source") alongside the tabs; `activeView` tracks which is on screen:
//   { kind: "model" } | { kind: "worksheet", id } | { kind: "dashboard", id } | { kind: "story", id }
// The workbook (Workbook/) saves all of it in the browser; there is no server-side state (decision O1).
//
// entities:      id -> { id, db, table, x, y, columns, el }   (the shared model)
// relationships: id -> { id, from:{entityId,column}, to:{entityId,column}, cardinality }
// bus events:    entity:moved / entity:removed / rel:changed  (model),
//                view:changed / tabs:changed                                    (the strip + active view),
//                worksheet:changed {id}  (a worksheet's sheet was replaced),
//                dashboard:changed {id}  (a dashboard's widgets changed: layout, text, add, remove),
//                story:changed {id}  (a story's steps changed)
import { renameInFormulas } from "../Calc/calc-workbook.js";
import { renameParamInFormulas } from "../Calc/calc-params.js";
import { copyName, copySheet, canDuplicate } from "../Tabs/duplicate-model.js";
import { LIMITS } from "./validate.js";
import { dropParamRefs } from "./parameters-model.js";
import { clearNavTarget } from "../Board/nav-model.js";
import { removeSheetWidgets, defaultTabName } from "../Board/board-model.js";
import { dropTarget } from "../Story/story-model.js";

export const bus = new EventTarget();

// Workbook theme: { accent: preset id | "#rrggbb", palette } (Core/theme-model.js). Applied to the
// :root tokens by Core/theme.js on "theme:changed"; saved with the workbook.
let theme = { accent: "signal", palette: "default" };

// Shared filters: filter objects (same shape as sheet.filters) that every worksheet applies where
// their table is in its view. Workbook-level; edited from any worksheet's Filters tool.
export const sharedFilters = [];
export function setSharedFilters(list) { sharedFilters.splice(0, sharedFilters.length, ...list); }

// Field settings, per workbook: "db.table.column" → { alias?, agg?, hidden? }. The alias is display
// only (the SQL keeps the real, catalog-validated column); `agg` is the default aggregation when the field
// becomes a measure; `hidden` leaves it out of the field pane.
export const fieldMeta = new Map();
export const fieldKey = (f) => `${f.db}.${f.table}.${f.column}`;
export const metaOf = (f) => (f ? fieldMeta.get(fieldKey(f)) : undefined) ?? {};
/** Display name: the alias, else table.column. */
export const nameOf = (f) => (typeof f?.calc === "string"
  ? calculations.find((c) => c.id === f.calc)?.name ?? f.column // a calculated field: the live name
  : metaOf(f).alias || `${f.table}.${f.column}`);
export function setFieldMeta(f, patch) {
  const k = fieldKey(f);
  const next = { ...(fieldMeta.get(k) ?? {}), ...patch };
  for (const p of Object.keys(next)) if (next[p] === undefined || next[p] === null || next[p] === "" || next[p] === false) delete next[p];
  if (Object.keys(next).length) fieldMeta.set(k, next); else fieldMeta.delete(k);
  emit("fields:changed");
}
export function setAllFieldMeta(obj) {
  fieldMeta.clear();
  for (const [k, v] of Object.entries(obj ?? {})) fieldMeta.set(k, v);
  emit("fields:changed");
}

// Parameters: workbook-level named, typed values (Core/parameters-model.js).
export const parameters = [];
let paramSeq = 0;
export function setParameters(list) {
  parameters.splice(0, parameters.length, ...list);
  for (const p of list) { const n = Number(String(p.id).slice(3)); if (n > paramSeq) paramSeq = n; }
  emit("parameters:changed");
}
export function addParameter(p) { paramSeq += 1; const np = { ...p, id: `prm${paramSeq}` }; parameters.push(np); emit("parameters:changed"); return np; }
export function updateParameter(id, patch) {
  const p = parameters.find((x) => x.id === id);
  if (!p) return;
  const old = p.name;
  Object.assign(p, patch);
  if (patch.name !== undefined && patch.name !== old) { // [@Old] in formulas follows the rename
    renameParamInFormulas(calculations, old, p.name).forEach((r, i) => { calculations[i].formula = r.formula; });
  }
  emit("parameters:changed");
}
export function removeParameter(id) {
  const i = parameters.findIndex((x) => x.id === id);
  if (i < 0) return;
  parameters.splice(i, 1);
  for (const t of worksheets()) dropParamRefs(t.sheet, id);
  for (const f of sharedFilters) if (f.param === id) delete f.param; // before the event, so the views redraw without it
  emit("parameters:changed");
}

// Named hierarchies: workbook-level { id, name, levels: [{ db, table, column }] } (Dashboard/hierarchy-model.js).
// Applying one to a sheet copies its levels into sheet.drill, so renaming or deleting one never touches a sheet.
export const hierarchies = [];
let hierSeq = 0;
export function setHierarchies(list) {
  hierarchies.splice(0, hierarchies.length, ...list);
  for (const h of list) { const n = Number(String(h.id).slice(4)); if (n > hierSeq) hierSeq = n; } // no counter is saved: sheets copy levels, not ids, so a reused id can't bind to anything
  emit("hierarchies:changed");
}
export function addHierarchy(h) { hierSeq += 1; const nh = { id: `hier${hierSeq}`, name: h.name, levels: structuredClone(h.levels) }; hierarchies.push(nh); emit("hierarchies:changed"); return nh; }
export function updateHierarchy(id, patch) {
  const h = hierarchies.find((x) => x.id === id);
  if (!h) return;
  if (patch.name !== undefined) h.name = patch.name;
  if (patch.levels !== undefined) h.levels = structuredClone(patch.levels);
  emit("hierarchies:changed");
}
export function removeHierarchy(id) {
  const i = hierarchies.findIndex((x) => x.id === id);
  if (i >= 0) { hierarchies.splice(i, 1); emit("hierarchies:changed"); }
}

// Calculated fields: workbook-level { id, name, formula } (Calc/calc-workbook.js). A rename rewrites [Old] in other formulas.
export const calculations = [];
let calcSeq = 0;
/** `nextId` (saved with the workbook) keeps an id from being reused after the highest one was deleted. */
export function setCalculations(list, nextId) {
  calculations.splice(0, calculations.length, ...list);
  for (const c of list) { const n = Number(String(c.id).slice(4)); if (n > calcSeq) calcSeq = n; }
  if (Number.isInteger(nextId) && nextId - 1 > calcSeq) calcSeq = nextId - 1;
  emit("calculations:changed");
}
/** The number the next new calculation gets (saved so a deleted id is never reused). */
export const nextCalcId = () => calcSeq + 1;
export function addCalculation({ name, formula, group }) { calcSeq += 1; const c = { id: `calc${calcSeq}`, name, formula, ...(group ? { group } : {}) }; calculations.push(c); emit("calculations:changed"); return c; }
export function updateCalculation(id, patch) {
  const c = calculations.find((x) => x.id === id);
  if (!c) return;
  const old = c.name;
  Object.assign(c, patch);
  if (patch.name !== undefined && patch.name !== old) {
    renameInFormulas(calculations, old, c.name).forEach((r, i) => { if (calculations[i] !== c) calculations[i].formula = r.formula; });
  }
  emit("calculations:changed");
}
export function removeCalculation(id) {
  const i = calculations.findIndex((x) => x.id === id);
  if (i >= 0) { calculations.splice(i, 1); emit("calculations:changed"); }
}

export const currentTheme = () => theme;
export function setTheme(next) { theme = { ...next }; emit("theme:changed"); }

// The shared data source.
export const entities = new Map();
export const relationships = new Map();

// The ordered tab list + which view is active.
export const tabs = [];
let activeView = { kind: "model" };   // { kind: "model" } | { kind: "worksheet", id } | { kind: "dashboard", id } | { kind: "story", id }
let wsSeq = 0, dbSeq = 0, stSeq = 0, widgetSeq = 0;

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export const worksheets = () => tabs.filter((t) => t.kind === "worksheet");
export const dashboards = () => tabs.filter((t) => t.kind === "dashboard");
export const stories = () => tabs.filter((t) => t.kind === "story");
export const tabById = (id) => tabs.find((t) => t.id === id) ?? null;
export const worksheetById = (id) => { const t = tabById(id); return t?.kind === "worksheet" ? t : null; };

export const isModelActive = () => activeView.kind === "model";
export const isWorksheetActive = () => activeView.kind === "worksheet";
export const isDashboardActive = () => activeView.kind === "dashboard";
export const isStoryActive = () => activeView.kind === "story";
export const activeWorksheet = () => (activeView.kind === "worksheet" ? worksheetById(activeView.id) : null);
export const activeDashboard = () => (activeView.kind === "dashboard" ? tabById(activeView.id) : null);
export const activeStory = () => (activeView.kind === "story" ? tabById(activeView.id) : null);
/** The workbook's saved `active` view, as a copy. */
export const currentView = () => ({ ...activeView });

export function showModel() {
  if (activeView.kind === "model") return;
  activeView = { kind: "model" };
  emit("view:changed");
  emit("tabs:changed");
}

// A blank worksheet. Columns and Rows are each an ordered list of field pills (Tableau-style):
// a categorical field is a dimension (group-by), a numeric field is a measure (aggregated), and the
// shelf it sits on only controls chart layout — so both shelves accept both kinds. Each pill is
// { db, table, column, category, agg? } where `agg` is present only for numeric (measure) fields.
// `color` holds at most one dimension: a Tableau-style Color encoding that splits the
// chart into one coloured series per distinct value — an extra group-by the client pivots into
// series (bar/stacked/line/area) or renders as a free extra crosstab header level (table).
// `sort` is { by: <field id>, dir: 'asc'|'desc' } or null (default: ascending by the first field).
// `format` is per-chart presentation, applied without touching the query — see defaultFormat().
// `selection` (click-to-filter) is the transient mark selection: click a chart mark to select its
// primary-dimension value. `{ db, table, column, value, label, action }` where `action` is null (just a
// visible selection), "keep" (filter the sheet to that value) or "exclude" (filter it out) — applied as
// a bound-parameter filter. This is the machinery cross-widget filtering will reuse.
// `drill` (hierarchical drill-down) declares an ordered hierarchy over columns of ONE table and
// tracks the current descent. `null`, or:
//   { levels: [{db, table, column, category}], depth, path: [{column, value, label}] }
// `levels` are the ordered drill columns (year → quarter → month), all from the same table; `depth` is
// the 0-based level currently shown; `path` pins each ancestor's chosen value (length === depth) as a
// bound-parameter filter, so drilling stays on the read-only, bound-param query path (D6/D16).
// `marks` (Marks card) holds the per-mark encodings beyond the Color shelf — see defaultMarks().
// `pages` (Pages shelf) steps/animates the view through one dimension's members, one at a time:
//   { db, table, column, category, index, members? }  — `index` is the current member; `members` is the
// bounded distinct-values list once loaded. Each page filters the view to `members[index]` via a
// bound-parameter `=` filter (the path), so paging stays read-only and injection-safe (D6).
export const emptySheet = () => ({
  columns: [], rows: [], color: [], filters: [], chartType: "bar", sort: null,
  selection: null, drill: null, marks: defaultMarks(), pages: null, format: defaultFormat(),
  // A date range on one date field + an optional comparison range (Dashboard/period-model.js).
  // null | { db, table, column, category, preset, from, to, compare, compareFrom, compareTo }
  period: null,
  memberColors: {}, // { [table.column]: { [member]: "#rrggbb" } } (Dashboard/colour-model.js)
  // tooltipStyle (tooltip modal): per-line { size, bold, italic, color } aligned to tooltipText's lines (Dashboard/tooltip-style.js); the key exists only once a line is styled
  // tooltipFormats: { [field name]: { number?, decimals?, date? } } per-field tooltip formats (Dashboard/tooltip-formats.js); the key exists only once a field is formatted
  tooltipText: null, // tooltip template with <Field> placeholders (Dashboard/tooltip-model.js); null = automatic
  title: null, caption: null, showTitle: true, showFilterCards: true, // title / caption: null = the tab name / an automatic summary; filter cards above the chart
  // collapsed: crosstab headers shown collapsed { rows: [key…], cols: [key…] } (Dashboard/collapse-model.js); the key exists only once a header is collapsed
  analytics: null, // { ref, band, trend, forecast, totals } (Dashboard/analytics-model.js); null = none
  paramAction: null, // { param: id } — "Set <parameter>" on the selection chip (Dashboard/action-model.js)
  urlAction: null, // { label, template } — "Open <label>" on the selection chip (Dashboard/action-model.js)
});

// Marks card: a cluster of encoding targets that map a field onto a mark property. All stay on
// the existing bounded aggregate/join query — Size/Detail add a measure/group-by exactly like the
// Color shelf; Label/Tooltip read a field already (or newly, if numeric) in the query.
//   size:    one numeric field → mark size (bubble scatter). { db, table, column, category, agg }
//   label:   one field → text drawn on each mark (a dimension already grouped, or a numeric measure)
//   detail:  dimensions that add group-by granularity with NO visual channel (more marks, same encodings)
//   tooltip: extra fields listed in a custom mark tooltip
//   shape: one dimension → distinct point shapes on a scatter, with a shape legend
//   path: one field → orders the vertices of a line/area mark (connected order, not category order)
//   angle: a measure driving a radial mark's angle — pie already maps its measure to angle
// The Colour shelf (sheet.color) gains a CONTINUOUS mode: a numeric field there → a sequential
// token-derived gradient (visualMap) instead of discrete series (see colorMode() in dashboards.js).
export const defaultMarks = () => ({ size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null });

// Per-worksheet formatting. Presentation only; defaults leave prior behaviour unchanged.
//  numberFormat: "auto" | "compact" | "currency" | "percent"  — how measure values read
//  decimals:     null (auto) | 0..3                            — fixed fraction digits
//  dateFormat:   "auto" | "date" | "month" | "year" | "datetime" — reformat date-like dimension labels
//  topN:         null (All — up to 5,000) | number             — cap categories in a chart (query LIMIT)
//  dateBucket:   "auto" | "exact" | "hour" … "year"            — group a chart's date/time axis by a calendar grain
//  legend:       "auto" | "hidden" | "top" | "bottom" | "left" | "right"
//  dataLabels:   show value labels on marks
//  colorByDimension: colour a single-measure bar chart's bars by their category
//  xTitle/yTitle: axis titles (null = none)
//  lineStyle / heatmapShape / targetMeasure / syncAxes / secondaryType / markerSize / markBorder: see the defaults below
//  ganttLength:  "length" | "end" — a Gantt's second measure (absent = length; kept off the defaults so older files round-trip unchanged)
//  target:       null | number — a KPI scorecard's goal; downIsGood: a fall shows as good
//  conditional:  { [measureKey]: { mode, scale, mid, rules } } — Table / Text cell formatting
export const defaultFormat = () => ({
  numberFormat: "auto",
  decimals: null,
  currencySymbol: "$",
  dateFormat: "auto",
  topN: null,
  dateBucket: "auto",
  legend: "auto",
  dataLabels: false,
  colorByDimension: false,
  paletteReverse: false, // reverse the categorical order and the continuous ramp
  colorRamp: "brand", // brand | blue | green | amber | violet — scatter / heatmap continuous colour
  colorMin: null, // pinned low end of the continuous colour scale (null = the data's)
  colorMax: null, // pinned high end
  colorScale: "sequential", // sequential | diverging — scatter / heatmap continuous colour
  colorPair: "default", // default | amber-violet | green-violet — the diverging scale's two hues (Dashboard/colour-scale-model.js)
  colorCentre: null, // the diverging scale's centre value (null = 0 when the data straddles it, else the middle)
  colorSteps: 0, // 0 = continuous gradient; 2–9 = that many discrete colour steps (scatter / heatmap)
  xTitle: null,
  yTitle: null,
  target: null,
  downIsGood: false,
  conditional: {},
  fit: "standard", // standard | width | height | entire
  lineStyle: "straight", // straight | step | jump (line / area / combo)
  heatmapShape: "square", // square | circle
  targetMeasure: null, // bullet target = this shelf measure (index ≥ 1), else Format → Target
  dualAxis: false, // a line / area chart draws its 2nd+ measures on a right axis
  syncAxes: false, // a combo's two value axes share one range
  secondaryType: "line", // right-axis marks of a combo: line | bar | area
  markerSize: null, // null (automatic) | whole px 4–40 — scatter / line markers, circle heatmap
  markBorder: "none", // none | thin | thick — bars, scatter points, heatmap cells, pie, treemap, funnel
  markerShape: "circle", // circle | square | diamond | triangle — line / area / combo markers
  font: "default", // default | serif | mono — the family of the worksheet's chart and table text
  tableAlign: "auto", // auto | left | center | right — a table's value cells
  tableDensity: "standard", // standard | compact | roomy — a table's row height
  tableShade: "none", // none | banded | header | both — a table's shading
  approximate: false, // estimate distinct counts / read a 10% sample where the table allows
});

/** The tab limit's message (LIMITS.tabs covers both kinds); null while there is room. */
export const tabLimitError = () => (tabs.length >= LIMITS.tabs ? `A workbook holds at most ${LIMITS.tabs} tabs — close one first.` : null);

/** A new, blank worksheet tab (activated), named "Worksheet N" unless `name` is given. Null at the tab limit. */
export function createWorksheet(name) {
  if (tabLimitError()) return null;
  wsSeq += 1;
  const tab = { id: `ws#${wsSeq}`, kind: "worksheet", name: name || defaultTabName("worksheet", tabs.map((t) => t.name)), sheet: emptySheet() };
  tabs.push(tab);
  switchTab(tab.id);
  emit("tabs:changed");
  return tab;
}

/** A new, empty dashboard tab (activated), named "Dashboard N" unless `name` is given. Null at the tab limit. */
export function createDashboard(name) {
  if (tabLimitError()) return null;
  dbSeq += 1;
  const tab = { id: `db#${dbSeq}`, kind: "dashboard", name: name || defaultTabName("dashboard", tabs.map((t) => t.name)), widgets: [], size: null, notes: "" };
  tabs.push(tab);
  switchTab(tab.id);
  emit("tabs:changed");
  return tab;
}

/** A new, empty story tab (activated), named "Story N" unless `name` is given. Null at the tab limit. */
export function createStory(name) {
  if (tabLimitError()) return null;
  stSeq += 1;
  const tab = { id: `st#${stSeq}`, kind: "story", name: name || defaultTabName("story", tabs.map((t) => t.name)), steps: [] };
  tabs.push(tab);
  switchTab(tab.id);
  emit("tabs:changed");
  return tab;
}

/** Replace a story's steps (add, remove, reorder, caption) + notify. The caller validates with Story/story-model.js. */
export function setSteps(storyId, steps) {
  const tab = tabById(storyId);
  if (!tab || tab.kind !== "story") return;
  tab.steps = steps;
  emit("story:changed", { id: storyId });
}

/** Duplicate a worksheet: a deep copy named "<name> copy", inserted after the source and activated. Returns { ok, tab? | error }. */
export function duplicateWorksheet(id) {
  const idx = tabs.findIndex((t) => t.id === id && t.kind === "worksheet");
  if (idx < 0) return { ok: false, error: "That worksheet no longer exists." };
  const limit = canDuplicate(tabs.length, LIMITS.tabs);
  if (!limit.ok) return limit;
  wsSeq += 1;
  const tab = { id: `ws#${wsSeq}`, kind: "worksheet", name: copyName(tabs[idx].name, tabs.map((t) => t.name), LIMITS.tabName), sheet: copySheet(tabs[idx].sheet) };
  tabs.splice(idx + 1, 0, tab);
  switchTab(tab.id);
  emit("tabs:changed");
  return { ok: true, tab };
}

/** Persist a worksheet's shelves + notify the view. */
export function updateSheet(worksheetId, sheet) {
  const tab = worksheetById(worksheetId);
  if (!tab) return;
  tab.sheet = sheet;
  emit("worksheet:changed", { id: worksheetId });
}

/** The id the next new widget gets ("w#N"); unique across the session. */
export function nextWidgetId() { widgetSeq += 1; return `w#${widgetSeq}`; }

/** Replace a dashboard's widgets (layout, text edit, add, remove) + notify. The caller validates with Board/board-model.js. */
export function setWidgets(dashboardId, widgets) {
  const tab = tabById(dashboardId);
  if (!tab || tab.kind !== "dashboard") return;
  tab.widgets = widgets;
  emit("dashboard:changed", { id: dashboardId });
}

/** Set a dashboard's size: null = automatic, or { width, height } in pixels (validated by the caller: Board/board-size.js). */
export function setDashboardSize(dashboardId, size) {
  const tab = tabById(dashboardId);
  if (!tab || tab.kind !== "dashboard") return;
  tab.size = size ? { width: size.width, height: size.height } : null;
  emit("dashboard:changed", { id: dashboardId });
}

/** An Automatic dashboard's size range ({ minWidth?, maxWidth?, minHeight?, maxHeight? } or null); the caller has checked it with `rangeError`. */
export function setDashboardRange(dashboardId, range) {
  const tab = tabById(dashboardId);
  if (!tab || tab.kind !== "dashboard") return;
  tab.range = range ? { ...range } : null;
  emit("dashboard:changed", { id: dashboardId });
}

/** A dashboard's data note ("" = none); the caller has checked it with `validateNotes` (Board/board-notes.js). */
export function setDashboardNotes(dashboardId, notes) {
  const tab = tabById(dashboardId);
  if (!tab || tab.kind !== "dashboard") return;
  tab.notes = notes;
  emit("dashboard:changed", { id: dashboardId });
}

/** A worksheet has content if any shelf holds a field. */
export function worksheetHasContent(id) {
  const s = worksheetById(id)?.sheet;
  const m = s?.marks;
  const hasMarks = Boolean(m && (m.size || m.label || (m.detail?.length ?? 0) > 0 || (m.tooltip?.length ?? 0) > 0 || m.shape || m.path || m.angle));
  return Boolean(s && ((s.columns?.length ?? 0) > 0 || (s.rows?.length ?? 0) > 0 || (s.color?.length ?? 0) > 0 || (s.filters?.length ?? 0) > 0 || ((s.drill?.levels?.length ?? 0) > 0) || hasMarks || s.pages || s.period));
}

export function switchTab(id) {
  const tab = tabById(id);
  if (!tab) return;
  activeView = { kind: tab.kind, id };
  emit("view:changed");
  emit("tabs:changed");
}

export function renameTab(id, name) {
  const tab = tabById(id);
  if (tab && name) { tab.name = name; emit("tabs:changed"); }
}

/** Close a tab. Closing a worksheet also removes its widgets from every dashboard and its steps from every story (each notified); closing a dashboard or story touches no worksheet. */
export function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const closing = tabs[idx];
  const wasActive = activeView.kind !== "model" && activeView.id === id;
  tabs.splice(idx, 1);
  for (const d of dashboards()) { // a closed worksheet leaves its widgets; a button that went to the closed tab is unlinked
    const kept = clearNavTarget(closing.kind === "worksheet" ? removeSheetWidgets(d.widgets, id) : d.widgets, id);
    if (kept !== d.widgets) { d.widgets = kept; emit("dashboard:changed", { id: d.id }); }
  }
  for (const s of stories()) { // a closed worksheet or dashboard leaves its steps
    const kept = dropTarget(s.steps, id);
    if (kept !== s.steps) { s.steps = kept; emit("story:changed", { id: s.id }); }
  }
  if (wasActive) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activeView = next ? { kind: next.kind, id: next.id } : { kind: "model" };
    emit("view:changed");
  }
  emit("tabs:changed");
}

/** Relationships with an endpoint on the given entity (in the shared model). */
export function relationshipsFor(entityId) {
  return [...relationships.values()].filter(
    (r) => r.from.entityId === entityId || r.to.entityId === entityId,
  );
}
