// Shared builder state + event bus (frontend-patterns.md).
//
// Two distinct things (corrected in the dashboards rework):
//   • The DATA MODEL — the tables dragged onto the canvas as entity views, plus the logical
//     relationships between them. There is exactly ONE model, shared across all dashboards.
//   • DASHBOARDS — subtabs, each built FROM the model's tables by adding widgets. Each dashboard
//     owns its own widgets.
// The tab strip shows the model ("Data Model") alongside the dashboard subtabs; `activeView`
// tracks which is on screen. v1 is in-memory only (decision O1).
//
// entities:      id -> { id, db, table, x, y, columns, joinKeys:Set, el }   (the shared model)
// relationships: id -> { id, from:{entityId,column}, to:{entityId,column}, cardinality }
// dashboards:    [ { id, name, widgets: [ { id, kind, db, table, title } ] } ]
// bus events:    entity:moved / entity:removed / joinkey:changed / rel:changed  (model),
//                view:changed / tabs:changed / dashboard:changed {id}          (views)
export const bus = new EventTarget();

// P41 workbook theme: { accent: preset id | "#rrggbb", palette } (Core/theme-model.js). Applied to the
// :root tokens by Core/theme.js on "theme:changed"; saved with the workbook.
let theme = { accent: "crimson", palette: "default" };

// P40 shared filters: filter objects (same shape as sheet.filters) that every dashboard applies where
// their table is in its view. Workbook-level; edited from any dashboard's Filters tool.
export const sharedFilters = [];
export function setSharedFilters(list) { sharedFilters.splice(0, sharedFilters.length, ...list); }

// P28 field settings, per workbook: "db.table.column" → { alias?, agg?, hidden? }. The alias is display
// only (the SQL keeps the real, catalog-validated column); `agg` is the default aggregation when the field
// becomes a measure; `hidden` leaves it out of the field pane.
export const fieldMeta = new Map();
export const fieldKey = (f) => `${f.db}.${f.table}.${f.column}`;
export const metaOf = (f) => (f ? fieldMeta.get(fieldKey(f)) : undefined) ?? {};
/** Display name: the alias, else table.column. */
export const nameOf = (f) => metaOf(f).alias || `${f.table}.${f.column}`;
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
  if (p) { Object.assign(p, patch); emit("parameters:changed"); }
}
export function removeParameter(id) {
  const i = parameters.findIndex((x) => x.id === id);
  if (i >= 0) { parameters.splice(i, 1); emit("parameters:changed"); }
}

// P39 bookmarks: named snapshots of one dashboard's view (its sheet, incl. selection / drill / page /
// format) plus the shared filters at the time. { id, name, dashId, dashName, sheet, sharedFilters, savedAt }
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

// Dashboards + which view is active.
export const dashboards = [];
let activeView = { kind: "model" };   // { kind: "model" } | { kind: "dashboard", id }
let dashSeq = 0;

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export const isModelActive = () => activeView.kind === "model";
export const activeDashboardId = () => (activeView.kind === "dashboard" ? activeView.id : null);
export const activeDashboard = () =>
  activeView.kind === "dashboard" ? dashboards.find((d) => d.id === activeView.id) ?? null : null;

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
  xTitle: null,
  yTitle: null,
  target: null,
  downIsGood: false,
  conditional: {},
  fit: "standard", // P23: standard | width | height | entire
  approximate: false, // P33: estimate distinct counts / read a 10% sample where the table allows
});

export function createDashboard(name) {
  dashSeq += 1;
  // All new dashboards share the same default name (the id stays unique). Each is a worksheet.
  const dash = { id: `dash#${dashSeq}`, name: name || "Dashboard", sheet: emptySheet() };
  dashboards.push(dash);
  switchDashboard(dash.id);
  emit("tabs:changed");
  return dash;
}

/** Persist a worksheet's shelves + notify the view. */
export function updateSheet(dashId, sheet) {
  const dash = dashboards.find((d) => d.id === dashId);
  if (!dash) return;
  dash.sheet = sheet;
  emit("dashboard:changed", { id: dashId });
}

/** A dashboard has content if any shelf holds a field. */
export function dashboardHasContent(id) {
  const s = dashboards.find((d) => d.id === id)?.sheet;
  const m = s?.marks;
  const hasMarks = Boolean(m && (m.size || m.label || (m.detail?.length ?? 0) > 0 || (m.tooltip?.length ?? 0) > 0 || m.shape || m.path || m.angle));
  return Boolean(s && ((s.columns?.length ?? 0) > 0 || (s.rows?.length ?? 0) > 0 || (s.color?.length ?? 0) > 0 || (s.filters?.length ?? 0) > 0 || ((s.drill?.levels?.length ?? 0) > 0) || hasMarks || s.pages || s.period));
}

export function switchDashboard(id) {
  const dash = dashboards.find((d) => d.id === id);
  if (!dash) return;
  activeView = { kind: "dashboard", id };
  emit("view:changed");
  emit("tabs:changed");
}

export function renameDashboard(id, name) {
  const dash = dashboards.find((d) => d.id === id);
  if (dash && name) { dash.name = name; emit("tabs:changed"); }
}

export function closeDashboard(id) {
  const idx = dashboards.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const wasActive = activeDashboardId() === id;
  dashboards.splice(idx, 1);
  if (wasActive) {
    const next = dashboards[Math.min(idx, dashboards.length - 1)];
    activeView = next ? { kind: "dashboard", id: next.id } : { kind: "model" };
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
