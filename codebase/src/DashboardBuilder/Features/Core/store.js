// Shared builder state + event bus (frontend-patterns.md).
//
// Two distinct things:
//   • The DATA MODEL — the tables dragged onto the canvas as entity views, plus the logical
//     relationships between them. There is exactly ONE model, shared across all tabs.
//   • TABS — one ordered list of two kinds, each built FROM the model's tables:
//       worksheet: { id: "ws#N", kind: "worksheet", name, sheet }          (the editor; one chart / table)
//       dashboard: { id: "db#N", kind: "dashboard", name, widgets: [ … ], size }  (a board of worksheet / text widgets; size = null (automatic) or { width, height } px)
//     A widget is { id: "w#N", kind: "sheet", sheetId, x, y, w, h } or { id, kind: "text", heading, body, x, y, w, h }
//     (Board/board-model.js owns the geometry rules).
// The tab strip shows the model ("Data Model") alongside the tabs; `activeView` tracks which is on screen:
//   { kind: "model" } | { kind: "worksheet", id } | { kind: "dashboard", id }
// The workbook (Workbook/) saves all of it in the browser; there is no server-side state (decision O1).
//
// entities:      id -> { id, db, table, x, y, columns, joinKeys:Set, el }   (the shared model)
// relationships: id -> { id, from:{entityId,column}, to:{entityId,column}, cardinality }
// bus events:    entity:moved / entity:removed / joinkey:changed / rel:changed  (model),
//                view:changed / tabs:changed                                    (the strip + active view),
//                worksheet:changed {id}  (a worksheet's sheet was replaced),
//                dashboard:changed {id}  (a dashboard's widgets changed: layout, text, add, remove)
import { renameInFormulas } from "../Calc/calc-workbook.js";
import { renameParamInFormulas } from "../Calc/calc-params.js";
import { copyName, copySheet, canDuplicate } from "../Tabs/duplicate-model.js";
import { LIMITS } from "./validate.js";
import { removeSheetWidgets, defaultTabName } from "../Board/board-model.js";

export const bus = new EventTarget();

// P41 workbook theme: { accent: preset id | "#rrggbb", palette } (Core/theme-model.js). Applied to the
// :root tokens by Core/theme.js on "theme:changed"; saved with the workbook.
let theme = { accent: "crimson", palette: "default" };

// P40 shared filters: filter objects (same shape as sheet.filters) that every worksheet applies where
// their table is in its view. Workbook-level; edited from any worksheet's Filters tool.
export const sharedFilters = [];
export function setSharedFilters(list) { sharedFilters.splice(0, sharedFilters.length, ...list); }

// P28 field settings, per workbook: "db.table.column" → { alias?, agg?, hidden? }. The alias is display
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

// P32 parameters: workbook-level named, typed values (Core/parameters-model.js).
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
  if (i >= 0) { parameters.splice(i, 1); emit("parameters:changed"); }
}

// T03-29 named hierarchies: workbook-level { id, name, levels: [{ db, table, column }] } (Dashboard/hierarchy-model.js).
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

// Calculated fields (Plan B): workbook-level { id, name, formula } (Calc/calc-workbook.js). A rename rewrites [Old] in other formulas (B3).
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

// P39 bookmarks: named snapshots of one worksheet's view (its sheet, incl. selection / drill / page /
// format) plus the shared filters at the time. { id, name, worksheetId, worksheetName, sheet, sharedFilters, savedAt }
export const bookmarks = [];
let bookmarkSeq = 0;
export function addBookmark(b) {
  bookmarkSeq += 1;
  bookmarks.push({ ...b, id: `bm#${bookmarkSeq}` });
  emit("bookmarks:changed");
}
export function removeBookmark(id) {
  const i = bookmarks.findIndex((b) => b.id === id);
  if (i >= 0) { bookmarks.splice(i, 1); emit("bookmarks:changed"); }
}
export function setBookmarks(list) {
  bookmarks.splice(0, bookmarks.length, ...list.map((b) => ({ ...b, id: `bm#${++bookmarkSeq}` })));
  emit("bookmarks:changed");
}
export const currentTheme = () => theme;
export function setTheme(next) { theme = { ...next }; emit("theme:changed"); }

// The shared data model.
export const entities = new Map();
export const relationships = new Map();

// The ordered tab list + which view is active.
export const tabs = [];
let activeView = { kind: "model" };   // { kind: "model" } | { kind: "worksheet", id } | { kind: "dashboard", id }
let wsSeq = 0, dbSeq = 0, widgetSeq = 0;

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export const worksheets = () => tabs.filter((t) => t.kind === "worksheet");
export const dashboards = () => tabs.filter((t) => t.kind === "dashboard");
export const tabById = (id) => tabs.find((t) => t.id === id) ?? null;
export const worksheetById = (id) => { const t = tabById(id); return t?.kind === "worksheet" ? t : null; };

export const isModelActive = () => activeView.kind === "model";
export const isWorksheetActive = () => activeView.kind === "worksheet";
export const isDashboardActive = () => activeView.kind === "dashboard";
export const activeWorksheet = () => (activeView.kind === "worksheet" ? worksheetById(activeView.id) : null);
export const activeDashboard = () => (activeView.kind === "dashboard" ? tabById(activeView.id) : null);
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
// `color` (P7 marks) holds at most one dimension: a Tableau-style Color encoding that splits the
// chart into one coloured series per distinct value — an extra group-by the client pivots into
// series (bar/stacked/line/area) or renders as a free extra crosstab header level (table).
// `sort` is { by: <field id>, dir: 'asc'|'desc' } or null (default: ascending by the first field).
// `format` (P10) is per-chart presentation, applied without touching the query — see defaultFormat().
// `selection` (P15 click-to-filter) is the transient mark selection: click a chart mark to select its
// primary-dimension value. `{ db, table, column, value, label, action }` where `action` is null (just a
// visible selection), "keep" (filter the sheet to that value) or "exclude" (filter it out) — applied as
// a bound-parameter filter. This is the machinery cross-widget filtering (P24) will reuse.
// `drill` (P16 hierarchical drill-down) declares an ordered hierarchy over columns of ONE table and
// tracks the current descent. `null`, or:
//   { levels: [{db, table, column, category}], depth, path: [{column, value, label}] }
// `levels` are the ordered drill columns (year → quarter → month), all from the same table; `depth` is
// the 0-based level currently shown; `path` pins each ancestor's chosen value (length === depth) as a
// bound-parameter filter, so drilling stays on the read-only, bound-param query path (D6/D16).
// `marks` (P18 Marks card) holds the per-mark encodings beyond the P7 Color shelf — see defaultMarks().
// `pages` (P20 Pages shelf) steps/animates the view through one dimension's members, one at a time:
//   { db, table, column, category, index, members? }  — `index` is the current member; `members` is the
// bounded distinct-values list once loaded. Each page filters the view to `members[index]` via a
// bound-parameter `=` filter (the P14 path), so paging stays read-only and injection-safe (D6).
export const emptySheet = () => ({
  columns: [], rows: [], color: [], filters: [], chartType: "bar", sort: null,
  selection: null, drill: null, marks: defaultMarks(), pages: null, format: defaultFormat(),
  // P35: a date range on one date field + an optional comparison range (Dashboard/period-model.js).
  // null | { db, table, column, category, preset, from, to, compare, compareFrom, compareTo }
  period: null,
  memberColors: {}, // T01-20: { [table.column]: { [member]: "#rrggbb" } } (Dashboard/colour-model.js)
  tooltipText: null, // T01-19: tooltip template with <Field> placeholders (Dashboard/tooltip-model.js); null = automatic
  title: null, caption: null, showTitle: true, showFilterCards: true, // P30 filter cards above the chart
  analytics: null, // P21: { ref, band, trend, forecast, totals } (Dashboard/analytics-model.js); null = none // P23: null = the tab name / an automatic summary
  urlAction: null, // P39: { label, template } — "Open <label>" on the selection chip (Dashboard/action-model.js)
});

// Marks card (P18): a cluster of encoding targets that map a field onto a mark property. All stay on
// the existing bounded aggregate/join query — Size/Detail add a measure/group-by exactly like the P7
// Color shelf; Label/Tooltip read a field already (or newly, if numeric) in the query.
//   size:    one numeric field → mark size (bubble scatter). { db, table, column, category, agg }
//   label:   one field → text drawn on each mark (a dimension already grouped, or a numeric measure)
//   detail:  dimensions that add group-by granularity with NO visual channel (more marks, same encodings)
//   tooltip: extra fields listed in a custom mark tooltip
//   shape:   (P19) one dimension → distinct point shapes on a scatter, with a shape legend
//   path:    (P19) one field → orders the vertices of a line/area mark (connected order, not category order)
//   angle:   (P19) a measure driving a radial mark's angle — pie already maps its measure to angle
// The Colour shelf (sheet.color) gains a CONTINUOUS mode in P18: a numeric field there → a sequential
// token-derived gradient (visualMap) instead of discrete series (see colorMode() in dashboards.js).
export const defaultMarks = () => ({ size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null });

// Per-worksheet formatting (P10). Presentation only; defaults leave prior behaviour unchanged.
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
//  target:       null | number — a KPI scorecard's goal (P35); downIsGood: a fall shows as good
//  conditional:  { [measureKey]: { mode, scale, mid, rules } } — Table / Text cell formatting (P37)
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
  paletteReverse: false, // T03-33: reverse the categorical order and the continuous ramp
  colorRamp: "brand", // T03-19: brand | blue | green | amber | violet — scatter / heatmap continuous colour
  colorMin: null, // T03-19: pinned low end of the continuous colour scale (null = the data's)
  colorMax: null, // T03-19: pinned high end
  xTitle: null,
  yTitle: null,
  target: null,
  downIsGood: false,
  conditional: {},
  fit: "standard", // P23: standard | width | height | entire
  lineStyle: "straight", // T03-05: straight | step | jump (line / area / combo)
  heatmapShape: "square", // T03-10: square | circle
  targetMeasure: null, // T03-12: bullet target = this shelf measure (index ≥ 1), else Format → Target
  syncAxes: false, // T03-16: a combo's two value axes share one range
  secondaryType: "line", // T03-17: right-axis marks of a combo: line | bar | area
  markerSize: null, // T01-22: null (automatic) | whole px 4–40 — scatter / line markers, circle heatmap
  markBorder: "none", // T03-34: none | thin | thick — bars, scatter points, heatmap cells, pie, treemap, funnel
  markerShape: "circle", // circle | square | diamond | triangle — line / area / combo markers
  tableAlign: "auto", // T01-23: auto | left | center | right — a table's value cells
  tableDensity: "standard", // T01-23: standard | compact | roomy — a table's row height
  tableShade: "none", // T01-23: none | banded | header | both — a table's shading
  approximate: false, // P33: estimate distinct counts / read a 10% sample where the table allows
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
  const tab = { id: `db#${dbSeq}`, kind: "dashboard", name: name || defaultTabName("dashboard", tabs.map((t) => t.name)), widgets: [], size: null };
  tabs.push(tab);
  switchTab(tab.id);
  emit("tabs:changed");
  return tab;
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

/** Close a tab. Closing a worksheet also removes its widgets from every dashboard (each notified); closing a dashboard touches no worksheet. */
export function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const closing = tabs[idx];
  const wasActive = activeView.kind !== "model" && activeView.id === id;
  tabs.splice(idx, 1);
  if (closing.kind === "worksheet") {
    for (const d of dashboards()) {
      const kept = removeSheetWidgets(d.widgets, id);
      if (kept !== d.widgets) { d.widgets = kept; emit("dashboard:changed", { id: d.id }); }
    }
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
