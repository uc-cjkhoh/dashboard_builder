// Workbook save/load format — pure, DOM-free (unit-tested under tests/js/).
// A workbook is the whole builder state: the Data Source (tables + positions + join keys +
// relationships), every worksheet and every dashboard (its widgets on the board grid), in tab-strip order.
// It never contains the connection or a password — a workbook is reopened against whatever server the
// session is connected to. Format v2 holds `worksheets`, `dashboards`, optional `stories` and `tabs`; the v1 reader
// (migrateV1: v1 `dashboards` were worksheets) stays for good — old files and old autosaves must open.
import { percentileError } from "../Dashboard/analytics-model.js";
import { cleanHaving, checkHaving } from "../Dashboard/having-model.js";
import { emptySheet, defaultFormat } from "../Core/store.js";
import { LIMITS, text, isFraction } from "../Core/validate.js";
import { aggsFor } from "../Dashboard/filter-rules.js";
import { CASTS } from "../Dashboard/cast-model.js";
import { ZOOM_MIN, ZOOM_MAX } from "../Canvas/canvas-zoom.js";
import { cleanMemberAliases } from "../Dashboard/member-labels.js";
import { cleanTheme, DEFAULT_THEME } from "../Core/theme-model.js";
import { normalizeJoinType, relEnds, applyAggregate } from "../Relations/relation-rules.js";
import { cleanAction, cleanParamAction } from "../Dashboard/action-model.js";
import { cleanMemberColors } from "../Dashboard/colour-model.js";
import { cleanTableCols } from "../Dashboard/table-columns-model.js";
import { cleanCollapsed } from "../Dashboard/collapse-model.js";
import { checkTooltipText } from "../Dashboard/tooltip-model.js";
import { cleanListHeight } from "../Canvas/card-height.js";
import { checkTooltipStyle } from "../Dashboard/tooltip-style.js";
import { checkTooltipFormats } from "../Dashboard/tooltip-formats.js";
import { markerSizeError, markBorderError, storedBorder } from "../Dashboard/mark-style-model.js";
import { linePatternError } from "../Dashboard/line-style-model.js";
import { lineMarkersError } from "../Dashboard/line-marker-model.js";
import { showTooltipsError, tooltipButtonsError, tooltipModeError } from "../Dashboard/tooltip-behaviour-model.js";
import { cleanSizeScale } from "../Dashboard/size-scale-model.js";
import { markOpacityError } from "../Dashboard/mark-opacity-model.js";
import { pageSpeedError } from "../Dashboard/pages-speed-model.js";
import { shapeBinsError, cleanMemberShapes } from "../Dashboard/shape-model.js";
import { labelMarksError, labelPositionError, labelOverlapError } from "../Dashboard/label-marks-model.js";
import { cleanColourList } from "../Dashboard/colour-fields-model.js";
import { RAMP_CHOICES, SCALE_CHOICES, DIV_PAIR_CHOICES, colourCentreError, colourRangeError, colourStepsError } from "../Dashboard/colour-scale-model.js";
import { cleanParameter, MAX_PARAMS } from "../Core/parameters-model.js";
import { cleanHierarchies, hierarchyTableKey } from "../Dashboard/hierarchy-model.js";
import { cleanSource, wireSource, cleanCustomSql } from "../Core/source-model.js";
import { cleanCalculations } from "../Calc/calc-workbook.js";
import { cleanWidgets, savedWidgets } from "../Board/board-model.js";
import { cleanNotes, savedNotes } from "../Board/board-notes.js";
import { cleanSize, savedSize, cleanRange, savedRange } from "../Board/board-size.js";
import { cleanGroupSlot, cleanGroupCollapsed } from "../Tabs/tab-groups-model.js";
import { cleanSteps, savedSteps } from "../Story/story-model.js";
import { CALC_AGGS } from "../Calc/calc-pill.js";
import {
  CHART_TYPE_IDS, CATEGORIES, FILTER_OPS, NUMBER_FORMATS, DATE_FORMATS, LEGENDS, TOP_N, MAX_DECIMALS, DATE_BUCKETS, LINE_STYLES, HEATMAP_SHAPES, GANTT_LENGTHS, SECONDARY_TYPES, MARK_BORDER_COLOURS, MARKER_SHAPES, MAX_TARGET_MEASURE, TABLE_ALIGNS, BACKGROUNDS, TABLE_DENSITIES, TABLE_SHADES, FONTS,
  PERIOD_PRESETS, PERIOD_COMPARES, DATE_PARTS, DATE_LABELS, TABLE_CALCS, CALC_ALONG, FIT_MODES, REF_KINDS, TRENDS, FORECASTS, CF_MODES, CF_SCALES, CF_OPS, CF_TONES, CF_MAX_RULES, CF_MAX_MEASURES,
} from "../Core/sheet-schema.js";

export const WORKBOOK_FORMAT = "dashboard-builder-workbook";
export const WORKBOOK_VERSION = 2;
const CARDINALITIES = new Set(["1:1", "1:N", "N:1", "N:M"]);
const NOT_A_WORKBOOK = "This file is not a Dashboard Builder workbook.";

/** Builder state → a plain JSON-safe object. DOM nodes, fetched columns and lazily-loaded page
 *  members are left out (they are re-fetched on open). `tabs` is the store's ordered list (worksheet and dashboard
 *  tabs); `active` is the store's activeView. */
export function serializeWorkbook({ entities, relationships, tabs, active, theme, sharedFilters = [], fieldMeta = new Map(), parameters = [], calculations = [], nextCalcId, hierarchies = [], view = null }) {
  const worksheets = [], dashboards = [], storyTabs = [], order = [];
  const wsIndex = new Map(), dbIndex = new Map(), stIndex = new Map(); // tab id → index in the saved list
  for (const t of tabs) {
    if (t.kind === "story") { stIndex.set(t.id, storyTabs.length); order.push({ kind: "story", index: storyTabs.length }); storyTabs.push(t); }
    else if (t.kind === "dashboard") { dbIndex.set(t.id, dashboards.length); order.push({ kind: "dashboard", index: dashboards.length }); dashboards.push(t); }
    else { wsIndex.set(t.id, worksheets.length); order.push({ kind: "worksheet", index: worksheets.length }); worksheets.push(t); }
  }
  const activeIndex = active?.kind === "worksheet" ? wsIndex.get(active.id) : active?.kind === "dashboard" ? dbIndex.get(active.id) : active?.kind === "story" ? stIndex.get(active.id) : undefined;
  return {
    format: WORKBOOK_FORMAT,
    version: WORKBOOK_VERSION,
    savedAt: new Date().toISOString(),
    entities: [...entities.values()].map((e) => ({
      id: e.id, db: e.db, table: e.table, x: Math.round(e.x), y: Math.round(e.y),
      // Join keys are the columns the relationships use (kept in the file so older builds still open it).
      joinKeys: [...new Set([...relationships.values()].flatMap(relEnds).filter((end) => end.entityId === e.id).map((end) => end.column))],
      ...(e.source ? { source: wireSource(e.source) } : {}), // a union / unpivot entity (its `table` is the source's name)
      ...(e.customSql ? { customSql: e.customSql } : {}), // a table card reading the user's own SELECT (D105)
      ...(e.customSql && e.customSqlMysql ? { customSqlMysql: e.customSqlMysql } : {}), // the MySQL text it was written as, shown when the card is edited again (D106)
      ...(e.listHeight ? { listHeight: e.listHeight } : {}), // the column list's height, when an edge drag set one (Canvas/card-height.js)
    })),
    relationships: [...relationships.values()].map((r) => ({
      from: { entityId: r.from.entityId, column: r.from.column },
      to: { entityId: r.to.entityId, column: r.to.column },
      cardinality: r.cardinality,
      joinType: normalizeJoinType(r.joinType),
      joinFixed: r.joinFixed === true,
      ...(r.pairs?.length ? { pairs: r.pairs.map((p) => ({ from: p.from, to: p.to })) } : {}), // a compound key's extra pairs (optional; absent in older files)
      ...(r.aggregateFirst === true ? { aggregateFirst: true, ...(r.filterDirection === "single" ? { filterDirection: "single" } : {}) } : {}), // aggregate each table to the key before joining (optional)
    })),
    worksheets: worksheets.map((d) => ({ name: d.name, sheet: savedSheet(d.sheet) })),
    dashboards: dashboards.map((d) => ({ name: d.name, widgets: savedWidgets(d.widgets, wsIndex, dbIndex), ...savedSize(d.size), ...savedRange(d.range), ...savedNotes(d.notes), ...(d.groupSlot ? { groupSlot: d.groupSlot } : {}), ...(d.collapsed ? { collapsed: true } : {}) })), // size, groupSlot, collapsed: optional (absent = automatic / unset / open)
    ...(storyTabs.length ? { stories: storyTabs.map((s) => ({ name: s.name, steps: savedSteps(s.steps, wsIndex, dbIndex) })) } : {}), // (optional; absent in older files)
    tabs: order, // the strip's order
    ...(view ? { view: { zoom: Math.round(view.zoom * 1000) / 1000, pan: { x: Math.round(view.pan.x), y: Math.round(view.pan.y) } } } : {}), // the Data Source's zoom and pan (optional; absent = fit every card on open)
    active: activeIndex !== undefined ? { kind: active.kind, index: activeIndex } : null, // null = the Data Source view
    theme: theme ? { accent: theme.accent, palette: theme.palette, ...(theme.surface && theme.surface !== "default" ? { surface: theme.surface } : {}) } : { ...DEFAULT_THEME },
    sharedFilters: structuredClone(sharedFilters),
    fields: Object.fromEntries(fieldMeta),
    parameters: structuredClone(parameters),
    ...(hierarchies.length ? { hierarchies: structuredClone(hierarchies) } : {}), // (optional; absent in older files)
    calculations: calculations.map((c) => ({ id: c.id, name: c.name, formula: c.formula, ...(c.group ? { group: structuredClone(c.group) } : {}) })), // Plan B (no parsed tree); a group field saves its definition
    // The next calculation number, so a deleted highest id is never handed out again (absent when there never were any).
    ...(calculations.length || nextCalcId ? { nextCalcId: Math.max(Number.isInteger(nextCalcId) ? nextCalcId : 0, ...calculations.map((c) => Number(String(c.id).slice(4)) + 1)) } : {}),
  };
}

function savedSheet(sheet) {
  const copy = structuredClone(sheet);
  if (copy.pages) { delete copy.pages.members; delete copy.pages.loadError; delete copy.pages.more; } // re-fetched from the bounded distinct query
  return copy;
}

/** A v1 file read as v2: every v1 `dashboards[i]` (one worksheet each) becomes `worksheets[i]`, there are no dashboards, the tab
 *  order is the worksheet order (left unset: the reader derives it), `active` carries over as a
 *  worksheet index. Pure and tolerant — malformed parts pass through so the v2 reader reports them. */
export function migrateV1(raw) {
  const { dashboards, active, bookmarks: _dropped, ...rest } = raw;
  return {
    ...rest, version: 2, worksheets: dashboards, tabs: undefined,
    active: Number.isInteger(active) ? { kind: "worksheet", index: active } : active,
  };
}

/** JSON text → a validated workbook `{ entities, relationships, worksheets, dashboards, tabs, active, … issues }` (`tabs` / `active`
 *  point into the cleaned `worksheets` / `dashboards` lists). v1 files are migrated first. Throws an
 *  Error with a user-facing message for anything that isn't a workbook this build can open.
 *  Malformed parts are dropped or reset, and each one is reported in `issues` (never silent). */
export function parseWorkbook(source) {
  let raw;
  try { raw = JSON.parse(source); } catch { throw new Error(NOT_A_WORKBOOK); }
  if (!raw || typeof raw !== "object" || raw.format !== WORKBOOK_FORMAT) throw new Error(NOT_A_WORKBOOK);
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1)
    throw new Error("This workbook file has no valid version number.");
  if (raw.version > WORKBOOK_VERSION)
    throw new Error("This workbook was saved by a newer version of Dashboard Builder.");
  if (raw.version === 1) raw = migrateV1(raw);

  const issues = [];

  // entities: keep the first of each id and of each db.table; report the rest
  const seenIds = new Set(), seenTables = new Set();
  let skipped = 0;
  const entities = [];
  if (raw.entities !== undefined && !Array.isArray(raw.entities)) issues.push("The tables weren't a list — none were opened.");
  const entList = Array.isArray(raw.entities) ? raw.entities.slice() : [];
  if (entList.length > LIMITS.entities) {
    issues.push(`Only the first ${LIMITS.entities} tables were opened.`);
    entList.length = LIMITS.entities;
  }
  for (const e of entList) {
    if (!(e && isStr(e.id) && isStr(e.db) && isStr(e.table))) { skipped++; continue; }
    if (seenIds.has(e.id)) { issues.push(`Skipped a table with a duplicate id (${e.id}).`); continue; }
    if (seenTables.has(`${e.db}.${e.table}`)) { issues.push(`Skipped a second copy of ${e.db}.${e.table}.`); continue; }
    seenIds.add(e.id); seenTables.add(`${e.db}.${e.table}`);
    const coord = (v) => {
      if (Number.isFinite(v) && v >= 0) return v;
      issues.push(`${e.db}.${e.table}: its position was invalid — reset.`); return 0;
    };
    const keys = Array.isArray(e.joinKeys) ? e.joinKeys : [];
    if (e.joinKeys !== undefined && !Array.isArray(e.joinKeys)) issues.push(`${e.db}.${e.table}: its join keys weren't a list — cleared.`);
    if (keys.some((k) => !isStr(k))) issues.push(`${e.db}.${e.table}: dropped a join key that wasn't a column name.`);
    const entity = { id: e.id, db: e.db, table: e.table, x: coord(e.x), y: coord(e.y), joinKeys: keys.filter(isStr) };
    if (e.source !== undefined) { // a saved union / unpivot: re-checked against the same rules; a bad one skips the whole entity
      const source = cleanSource(e.source, e.db, e.table);
      if (source) { entity.source = source; entity.joinKeys = []; } else { issues.push(`${e.db}.${e.table}: its union or unpivot definition wasn't valid — skipped.`); continue; }
    }
    if (e.customSql !== undefined && !entity.source) { // a saved custom SQL: text of an allowed length, or dropped with a note (the card falls back to its table)
      const sql = cleanCustomSql(e.customSql);
      if (sql) { entity.customSql = sql; const my = cleanCustomSql(e.customSqlMysql); if (my) entity.customSqlMysql = my; } // a bad MySQL text is simply dropped: the ClickHouse query is what runs
      else issues.push(`${e.db}.${e.table}: its custom SQL wasn't valid — the card reads the table again.`);
    }
    if (e.listHeight !== undefined) { const h = cleanListHeight(e.listHeight); if (h) entity.listHeight = h; else issues.push(`${e.db}.${e.table}: its list height was invalid — reset.`); }
    entities.push(entity);
  }
  if (skipped) issues.push(`Skipped ${skipped} table(s) with missing details.`);
  const ids = new Set(entities.map((e) => e.id));
  const sourceIds = new Set(entities.filter((e) => e.source).map((e) => e.id));
  const endpoint = (p) => p && ids.has(p.entityId) && isStr(p.column);

  if (raw.relationships !== undefined && !Array.isArray(raw.relationships)) issues.push("The relationships weren't a list — none were opened.");
  const relList = Array.isArray(raw.relationships) ? raw.relationships.slice() : [];
  if (relList.length > LIMITS.relationships) {
    issues.push(`Only the first ${LIMITS.relationships} relationships were opened.`);
    relList.length = LIMITS.relationships;
  }
  const toSource = (r) => r && (sourceIds.has(r.from?.entityId) || sourceIds.has(r.to?.entityId));
  const droppedForSource = relList.filter((r) => toSource(r) && endpoint(r.from) && endpoint(r.to) && CARDINALITIES.has(r.cardinality)).length;
  if (droppedForSource) issues.push(`Dropped ${droppedForSource} relationship(s) that ended at a union or unpivot — a union or unpivot takes no relationship yet.`);
  const relationships = relList
    .filter((r) => r && !toSource(r) && endpoint(r.from) && endpoint(r.to) && CARDINALITIES.has(r.cardinality))
    .map((r) => ({
      from: { entityId: r.from.entityId, column: r.from.column },
      to: { entityId: r.to.entityId, column: r.to.column },
      cardinality: r.cardinality,
      joinType: normalizeJoinType(r.joinType), // anything unknown reads as inner
      joinFixed: r.joinFixed === true, // old files: false (a left keeps the base side)
      pairs: r.pairs, // raw; checked below once the columns in use are known
      ...applyAggregate({}, { aggregate: r.aggregateFirst === true, direction: r.filterDirection }), // a non-boolean flag or unknown direction reads as the plain join
    }));
  // A column is in at most one relationship: the first one that uses it is kept.
  const used = new Set();
  const colKey = (end) => `${end.entityId}\u0000${end.column}`;
  const kept = relationships.filter((r) => {
    if (used.has(colKey(r.from)) || used.has(colKey(r.to))) return false;
    used.add(colKey(r.from)); used.add(colKey(r.to));
    return true;
  });
  // A compound key's extra pairs: names only, at most LIMITS.joinExtraPairs, none reusing a column of any relationship (or of an earlier pair).
  let badPairs = 0;
  for (const r of kept) {
    const rawPairs = r.pairs; delete r.pairs;
    if (!Array.isArray(rawPairs)) { if (rawPairs !== undefined) badPairs++; continue; }
    const good = [];
    for (const p of rawPairs) {
      const ok = p && isStr(p.from) && isStr(p.to) && p.from && p.to && good.length < LIMITS.joinExtraPairs
        && !used.has(colKey({ entityId: r.from.entityId, column: p.from })) && !used.has(colKey({ entityId: r.to.entityId, column: p.to }));
      if (!ok) { badPairs++; continue; }
      used.add(colKey({ entityId: r.from.entityId, column: p.from })); used.add(colKey({ entityId: r.to.entityId, column: p.to }));
      good.push({ from: p.from, to: p.to });
    }
    if (good.length) r.pairs = good;
  }
  if (badPairs) issues.push(`Skipped ${badPairs} extra key pair(s) that were malformed, past the limit of ${LIMITS.joinExtraPairs}, or reused a column already in a relationship.`);
  const reused = relationships.length - kept.length;
  if (reused > 0) issues.push(`Skipped ${reused} relationship(s) that reused a column already in another relationship — a column can be in only one.`);
  relationships.length = 0; relationships.push(...kept);
  const droppedRels = relList.length - relationships.length - reused;
  if (droppedRels > 0) issues.push(`Skipped ${droppedRels} relationship(s) that referenced missing tables or had an unknown cardinality.`);

  const wsAll = objectList(raw.worksheets, "worksheet", issues);
  const dbAll = objectList(raw.dashboards, "dashboard", issues);
  const stAll = raw.stories === undefined ? [] : objectList(raw.stories, "story", issues);

  // The strip order: the saved `tabs` entries that point at something, then any worksheet / dashboard it left out. Past 50, dropped.
  const order = [], seenTab = new Set();
  const inRange = (t) => t && Number.isInteger(t.index) && t.index >= 0 && (t.kind === "worksheet" ? t.index < wsAll.length : t.kind === "dashboard" ? t.index < dbAll.length : t.kind === "story" && t.index < stAll.length);
  if (raw.tabs !== undefined && !Array.isArray(raw.tabs)) issues.push("The tab order wasn't a list — the tabs were opened in their saved order.");
  if (Array.isArray(raw.tabs)) {
    for (const t of raw.tabs) {
      if (!inRange(t) || seenTab.has(`${t.kind}:${t.index}`)) { issues.push("Skipped an entry in the tab order that points at nothing."); continue; }
      seenTab.add(`${t.kind}:${t.index}`); order.push({ kind: t.kind, index: t.index });
    }
  }
  const unlisted = [...wsAll.map((_, index) => ({ kind: "worksheet", index })), ...dbAll.map((_, index) => ({ kind: "dashboard", index })), ...stAll.map((_, index) => ({ kind: "story", index }))]
    .filter((t) => !seenTab.has(`${t.kind}:${t.index}`));
  if (Array.isArray(raw.tabs) && unlisted.length) issues.push(`${unlisted.length} tab(s) were missing from the tab order — added at the end.`);
  order.push(...unlisted);
  if (order.length > LIMITS.tabs) {
    issues.push(`Only the first ${LIMITS.tabs} tabs were opened.`);
    order.length = LIMITS.tabs;
  }

  const tabName = (d, base) => {
    const r = d.name == null || typeof d.name === "string"
      ? text(d.name, { label: "Tab name", max: LIMITS.tabName, required: true })
      : { ok: false, error: `The ${base.toLowerCase()} name must be text.` };
    if (r.ok) return r.value;
    issues.push(`A ${base.toLowerCase()} name was reset to "${base}": ${r.error}`);
    return base;
  };
  const worksheets = [], dashboards = [], stories = [], tabs = [];
  const wsMap = new Map(), dbMap = new Map(), stMap = new Map(); // saved index → index in the cleaned list
  for (const t of order) {
    if (t.kind === "worksheet") {
      const d = wsAll[t.index], name = tabName(d, "Worksheet");
      wsMap.set(t.index, worksheets.length); tabs.push({ kind: "worksheet", index: worksheets.length });
      worksheets.push({ name, sheet: sanitizeSheet(d.sheet, `Sheet "${name}"`, issues) });
    } else if (t.kind === "story") {
      stMap.set(t.index, stories.length); tabs.push({ kind: "story", index: stories.length });
      stories.push({ name: tabName(stAll[t.index], "Story"), steps: stAll[t.index].steps });
    } else {
      dbMap.set(t.index, dashboards.length); tabs.push({ kind: "dashboard", index: dashboards.length });
      dashboards.push({ name: tabName(dbAll[t.index], "Dashboard"), widgets: dbAll[t.index].widgets, size: dbAll[t.index].size, range: dbAll[t.index].range, notes: dbAll[t.index].notes, groupSlot: dbAll[t.index].groupSlot, collapsed: dbAll[t.index].collapsed });
    }
  }
  // A widget's worksheet is read through the map, so one cut by the 50-tab cap is "missing" like any other dangling index.
  const budget = { left: LIMITS.imagesTotal }; // the workbook-wide picture budget, shared by every dashboard
  dashboards.forEach((d, ownIndex) => {
    const remapped = Array.isArray(d.widgets)
      ? d.widgets.map((w) => (w && typeof w === "object" && w.kind === "sheet" ? { ...w, sheet: wsMap.get(w.sheet) }
        : w && typeof w === "object" && w.kind === "nav" && w.target && typeof w.target === "object" ? { ...w, target: { kind: w.target.kind, index: (w.target.kind === "worksheet" ? wsMap : w.target.kind === "dashboard" ? dbMap : new Map()).get(w.target.index) } } : w))
      : d.widgets;
    d.widgets = cleanWidgets(remapped, { worksheetCount: worksheets.length, dashboardCount: dashboards.length, ownDashboard: ownIndex, where: `Dashboard "${d.name}"`, budget }, issues);
    d.size = cleanSize(d.size, `Dashboard "${d.name}"`, issues);
    d.range = cleanRange(d.range, `Dashboard "${d.name}"`, issues);
    d.notes = cleanNotes(d.notes, `Dashboard "${d.name}"`, issues);
    d.groupSlot = cleanGroupSlot(d.groupSlot, `Dashboard "${d.name}"`, issues);
    d.collapsed = cleanGroupCollapsed(d.collapsed, `Dashboard "${d.name}"`, issues);
    if (d.size && d.range) { issues.push(`Dashboard "${d.name}": the saved size range was ignored (a fixed size wins).`); d.range = null; }
  });

  // A step's tab is read through the maps, so one cut by the 50-tab cap is "missing" like any other dangling index.
  for (const s of stories) {
    const remapped = Array.isArray(s.steps)
      ? s.steps.map((x) => (x && typeof x === "object" && x.target && typeof x.target === "object" ? { ...x, target: { kind: x.target.kind, index: (x.target.kind === "worksheet" ? wsMap : x.target.kind === "dashboard" ? dbMap : new Map()).get(x.target.index) } } : x))
      : s.steps;
    s.steps = cleanSteps(remapped, { worksheetCount: worksheets.length, dashboardCount: dashboards.length, where: `Story "${s.name}"` }, issues);
  }

  let active = null;
  if (raw.active != null) {
    const a = raw.active, map = a && typeof a === "object" ? (a.kind === "worksheet" ? wsMap : a.kind === "dashboard" ? dbMap : a.kind === "story" ? stMap : null) : null;
    const index = map && Number.isInteger(a.index) ? map.get(a.index) : undefined;
    if (index !== undefined) active = { kind: a.kind, index };
    else issues.push("The saved active tab was invalid — the data source view was opened.");
  }
  const theme = cleanTheme(raw.theme, issues); // absent (older workbooks) = the default theme
  const sharedFilters = cleanFilters(raw.sharedFilters, "Shared filters", issues, LIMITS.sharedFilters, { calc: false });
  const fields = cleanFieldMeta(raw.fields, issues);
  const parameters = cleanParameters(raw.parameters, issues);
  const hierarchies = cleanHierarchies(raw.hierarchies, issues, { tables: new Set(entities.map((e) => hierarchyTableKey(e.db, e.table))) });
  // A filter or Top N that points at a parameter the workbook doesn't have falls back to its own value.
  const paramIds = new Set(parameters.map((p) => p.id));
  for (const d of worksheets) unlinkParams(d.sheet, paramIds, `Sheet "${d.name}"`, issues);
  for (const f of sharedFilters) if (f.param && !paramIds.has(f.param)) { delete f.param; issues.push("A shared filter's parameter is missing — unlinked."); }
  const calculations = cleanCalculations(raw.calculations, issues); // Plan B
  const calcIds = new Set(calculations.map((c) => c.id));
  for (const d of worksheets) dropMissingCalcs(d.sheet, calcIds, `Sheet "${d.name}"`, issues);
  const sharedKept = dropMissingTopCalcs(sharedFilters, calcIds, "Shared filters", issues);
  sharedFilters.splice(0, sharedFilters.length, ...sharedKept);
  let nextCalcId;
  if (raw.nextCalcId !== undefined) {
    if (Number.isInteger(raw.nextCalcId) && raw.nextCalcId >= 1 && raw.nextCalcId <= 999999) nextCalcId = raw.nextCalcId;
    else issues.push("The saved next calculation number was invalid — ignored.");
  }
  const view = cleanView(raw.view, issues);
  return { entities, relationships, worksheets, dashboards, stories, tabs, active, view, theme, sharedFilters, fields, parameters, hierarchies, calculations, nextCalcId, issues: [...new Set(issues)] };
}

const MAX_PAN = 1e6; // model px; far past any real canvas, so a corrupt number cannot park the view in space

/** The saved Data Source view `{ zoom, pan: { x, y } }`, or null: absent means fit on open; a malformed one is reported and dropped whole (a half-read view could hide every card). */
function cleanView(v, issues) {
  if (v === undefined || v === null) return null;
  const fin = (n) => typeof n === "number" && Number.isFinite(n);
  const ok = v && typeof v === "object" && !Array.isArray(v) && fin(v.zoom) && v.zoom >= ZOOM_MIN && v.zoom <= ZOOM_MAX
    && v.pan && typeof v.pan === "object" && fin(v.pan.x) && fin(v.pan.y) && Math.abs(v.pan.x) <= MAX_PAN && Math.abs(v.pan.y) <= MAX_PAN;
  if (!ok) { issues.push("The saved Data Source view (zoom and position) was invalid — the cards are fitted to the window instead."); return null; }
  return { zoom: v.zoom, pan: { x: v.pan.x, y: v.pan.y } };
}

/** A saved list of tab objects; a non-list is reported, and entries that aren't objects are skipped (and reported). */
function objectList(v, noun, issues) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { issues.push(`The ${noun}s weren't a list — none were opened.`); return []; }
  const list = v.filter((d) => d && typeof d === "object");
  if (list.length < v.length) issues.push(`Skipped ${v.length - list.length} entry(ies) that were not a ${noun}.`);
  return list;
}

const isStr = (v) => typeof v === "string" && v.length > 0;
const defAgg = (p) => (p.category === "numeric" ? "sum" : "count");

// `needCategory: false` is for filters: workbooks from older builds saved filters without a category,
// and the worksheet backfills it from the column catalog at runtime.
function cleanPill(raw, where, issues, needCategory = true) {
  // A calculated field is identified by `calc`; its db/table/column are only a fallback label.
  if (raw && typeof raw === "object" && raw.calc !== undefined) {
    if (!/^calc\d{1,6}$/.test(raw.calc ?? "") || !CATEGORIES.has(raw.category)) { issues.push(`${where}: skipped a field with missing details.`); return null; }
    raw = { ...raw, db: typeof raw.db === "string" ? raw.db : "", table: typeof raw.table === "string" ? raw.table : "", column: typeof raw.column === "string" ? raw.column : "" };
    delete raw.choices; // field choices are whole table fields; a calculated field has none
  }
  const catOk = raw && (raw.category === undefined && !needCategory ? true : CATEGORIES.has(raw.category));
  const isCalc = raw && typeof raw === "object" && raw.calc !== undefined;
  if (!raw || typeof raw !== "object" || (!isCalc && (!isStr(raw.db) || !isStr(raw.table) || !isStr(raw.column))) || !catOk) {
    issues.push(`${where}: skipped a field with missing details.`); return null;
  }
  const p = { ...raw };
  if (isCalc) { delete p.datePart; delete p.dateLabels; } // a calculated dimension is never date-grouped
  if (p.role !== undefined && p.role !== "dimension" && p.role !== "measure") {
    issues.push(`${where}: ${p.table}.${p.column} had an unknown role "${p.role}" — cleared.`); delete p.role;
  }
  if (isCalc && p.agg !== undefined && !CALC_AGGS.includes(p.agg)) {
    issues.push(`${where}: ${p.column} can't use "${p.agg}" — reset to sum.`); p.agg = "sum";
  } else if (!isCalc && p.agg !== undefined && p.category !== undefined && !aggsFor(p.category).includes(p.agg)) {
    issues.push(`${where}: ${p.table}.${p.column} can't use "${p.agg}" — reset to ${defAgg(p)}.`); p.agg = defAgg(p);
  }
  // A percentile pill carries its fraction `p` (0..1); any other aggregation carries none.
  if (p.agg === "percentile" && !isFraction(p.p)) {
    issues.push(`${where}: ${p.table}.${p.column} had a percentile with no valid 0–100 percent — reset to ${defAgg(p)}.`); p.agg = defAgg(p);
  }
  if (p.agg !== "percentile") delete p.p;
  // A filter on the aggregated measure: a valid comparison with a plain number, else dropped and reported.
  if (p.having !== undefined) {
    const h = cleanHaving(p.having);
    if (h) p.having = h;
    else if (checkHaving(p.having).state === "empty") delete p.having; // an operator with no number yet filters nothing
    else { issues.push(`${where}: the measure filter on ${p.table}.${p.column} was invalid — removed.`); delete p.having; }
  }
  // Table calculation: a known type, direction and window (2–30).
  if (p.tableCalc !== undefined) {
    const c = p.tableCalc;
    const ok = c && typeof c === "object" && TABLE_CALCS.has(c.type) && CALC_ALONG.has(c.along ?? "auto")
      && (c.order === undefined || (c.type === "rank" && (c.order === "asc" || c.order === "desc")))
      && (c.ties === undefined || (c.type === "rank" && ["competition", "dense", "unique"].includes(c.ties)))
      && (c.window === undefined || (Number.isInteger(c.window) && c.window >= 2 && c.window <= 30))
      && (c.along !== "custom" || (c.using === undefined || (Array.isArray(c.using) && c.using.length <= 16 && new Set(c.using).size === c.using.length && c.using.every((d) => Number.isInteger(d) && d >= 0 && d < 16))));
    if (!ok) { issues.push(`${where}: the table calculation on ${p.table}.${p.column} was invalid — removed.`); delete p.tableCalc; }
    else p.tableCalc = { type: c.type, along: c.along ?? "auto", ...(c.window !== undefined ? { window: c.window } : {}), ...(c.type === "moving" && /^prm\d{1,6}$/.test(c.windowParam ?? "") ? { windowParam: c.windowParam } : {}), ...(c.order ? { order: c.order } : {}), ...(c.ties ? { ties: c.ties } : {}), ...(c.along === "custom" && c.using?.length ? { using: [...c.using] } : {}) };
  }
  // Date part: a known part on a date field only.
  if (p.datePart !== undefined && (!DATE_PARTS.has(p.datePart) || p.category !== "temporal")) {
    issues.push(`${where}: ${p.table}.${p.column} had an unusable date part "${p.datePart}" — reset to Auto.`); delete p.datePart;
  }
  // Date labels: show all / thin out the axis labels, on a date field only.
  if (p.dateLabels !== undefined && (!DATE_LABELS.has(p.dateLabels) || p.category !== "temporal")) {
    issues.push(`${where}: ${p.table}.${p.column} had unusable date labels "${p.dateLabels}" — reset to thin out.`); delete p.dateLabels;
  }
  // Field choices: a list of whole fields (db / table / column / category), ≤ 8, the shown one included.
  if (p.choices !== undefined) {
    const ok = Array.isArray(p.choices) ? p.choices.filter((c) => c && isStr(c.db) && isStr(c.table) && isStr(c.column) && CATEGORIES.has(c.category))
      .slice(0, LIMITS.fieldChoices).map((c) => ({ db: c.db, table: c.table, column: c.column, category: c.category })) : [];
    if (!Array.isArray(p.choices) || ok.length !== p.choices.length) issues.push(`${where}: some field choices for ${p.table}.${p.column} were dropped.`);
    if (!ok.some((c) => c.db === p.db && c.table === p.table && c.column === p.column))
      ok.unshift({ db: p.db, table: p.table, column: p.column, category: p.category });
    if (ok.length >= 2) p.choices = ok.slice(0, LIMITS.fieldChoices); else delete p.choices;
  }
  return p;
}
// Filters (a sheet's, or the workbook's shared ones): pills with a known op and text value(s).
export function cleanFilters(list, where, issues, max, { calc = true } = {}) {
  return cleanPills(list, where, issues, max, false).filter((f) => {
    // A sheet's filter may be on a calculated field (never a Top-N); a shared one may not (it must apply to every dashboard's own tables).
    if (f.calc !== undefined && (!calc || (f.op === "top" || f.op === "relative"))) { issues.push(`${where}: a calculated field can't be used ${calc ? "in a Top-N or relative-date filter" : "as a shared filter"} — removed.`); return false; }
    const multi = f.op === "in" || f.op === "notin" || f.op === "between";
    if (FILTER_OPS.has(f.op) && !multi && f.value !== undefined && f.value !== null && typeof f.value !== "string") {
      issues.push(`${where}: the value of the filter on ${f.table}.${f.column} wasn't text — reset to empty.`); f.value = "";
    }
    // A top-N filter must name its ranking measure.
    // A ranking by a calculation names it by id (db / table are empty); its agg, when present, is a row-level one.
    const calcTop = f.topBy && typeof f.topBy.calc === "string" && /^calc\d{1,6}$/.test(f.topBy.calc) && (f.topBy.agg === undefined || CALC_AGGS.includes(f.topBy.agg));
    const okTop = f.op !== "top" || calcTop || (f.topBy && typeof f.topBy.calc !== "string" && isStr(f.topBy.db) && isStr(f.topBy.table) && isStr(f.topBy.column) && aggsFor("numeric").includes(f.topBy.agg ?? "sum") && (f.topBy.agg !== "percentile" || isFraction(f.topBy.p)));
    const okShape = okTop && FILTER_OPS.has(f.op) && (multi ? Array.isArray(f.values) && f.values.every((v) => typeof v === "string") : true);
    if (!okShape) issues.push(`${where}: skipped a filter on ${f.table}.${f.column} with an unknown operator or value.`);
    return okShape;
  });
}
function cleanPills(list, where, issues, max = LIMITS.pillsPerShelf, needCategory = true) {
  if (list == null) return [];
  if (!Array.isArray(list)) { issues.push(`${where}: not a list — cleared.`); return []; }
  const out = list.map((p) => cleanPill(p, where, issues, needCategory)).filter(Boolean);
  if (out.length > max) { issues.push(`${where}: only the first ${max} fields were kept.`); out.length = max; }
  return out;
}
const oneOf = (set, v, fallback, where, what, issues) => {
  if (v === undefined || set.has(v)) return v ?? fallback;
  issues.push(`${where}: unknown ${what} "${v}" — reset.`); return fallback;
};

/** A saved worksheet validated field by field over today's defaults. Anything invalid is dropped or
 *  reset and described in `issues`. */
export function sanitizeSheet(saved, where, issues) {
  const base = emptySheet();
  if (saved != null && (typeof saved !== "object" || Array.isArray(saved))) issues.push(`${where}: its settings weren't an object — reset to defaults.`);
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const sheet = { ...base };
  sheet.chartType = s.chartType === undefined ? base.chartType : CHART_TYPE_IDS.has(s.chartType) ? s.chartType
    : (issues.push(`${where}: unknown chart type "${s.chartType}" — reset to Bar.`), "bar");
  for (const k of ["columns", "rows", "color"]) sheet[k] = cleanPills(s[k], `${where} ${k}`, issues);
  { const c = cleanColourList(sheet.color); sheet.color = c.list; c.issues.forEach((m) => issues.push(`${where}: ${m}`)); } // Colour: one measure, or up to 3 fields
  sheet.filters = cleanFilters(s.filters, `${where} filters`, issues, LIMITS.filters);
  if (s.marks != null && (typeof s.marks !== "object" || Array.isArray(s.marks))) issues.push(`${where}: marks weren't an object — reset.`);
  const m = s.marks && typeof s.marks === "object" && !Array.isArray(s.marks) ? s.marks : {};
  sheet.marks = { ...base.marks };
  for (const k of ["size", "label", "shape", "path", "angle"]) sheet.marks[k] = m[k] == null ? null : cleanPill(m[k], `${where} ${k}`, issues);
  for (const k of ["detail", "tooltip"]) sheet.marks[k] = cleanPills(m[k], `${where} ${k}`, issues);
  sheet.sort = s.sort == null ? null : isStr(s.sort.by) && (s.sort.dir === "asc" || s.sort.dir === "desc") ? { by: s.sort.by, dir: s.sort.dir }
    : (issues.push(`${where}: sort cleared.`), null);
  sheet.selection = null; // transient click selection — never restored
  sheet.drill = cleanDrill(s.drill, where, issues);
  sheet.pages = s.pages == null ? null
    : s.pages.calc !== undefined ? (issues.push(`${where}: a calculated field can't be used for pages — removed.`), null)
    : cleanPill(s.pages, `${where} pages`, issues) && Number.isInteger(s.pages.index) && s.pages.index >= 0
      ? { db: s.pages.db, table: s.pages.table, column: s.pages.column, category: s.pages.category, index: s.pages.index, ...cleanPagesSpeed(s.pages.speed, where, issues) }
      : (issues.push(`${where}: pages cleared.`), null);
  sheet.format = cleanFormat(s.format, where, issues);
  sheet.period = cleanPeriod(s.period, where, issues);
  sheet.urlAction = cleanAction(s.urlAction, where, issues);
  sheet.paramAction = cleanParamAction(s.paramAction, where, issues);
  // Title / caption: text (≤ 80 / ≤ 300) or null for the automatic one; showTitle a boolean.
  for (const [k, max] of [["title", 80], ["caption", 300]]) {
    const v = s[k];
    if (v == null) sheet[k] = null;
    else { const r = typeof v === "string" ? text(v, { label: k, max, required: true }) : { ok: false }; sheet[k] = r.ok ? r.value : null; if (!r.ok) issues.push(`${where}: the ${k} was invalid — reset.`); }
  }
  { // tooltip template: trimmed text ≤ LIMITS.tooltipText, or null for the automatic tooltip
    const r = checkTooltipText(s.tooltipText);
    sheet.tooltipText = r.ok ? r.value : null;
    if (!r.ok) issues.push(`${where}: the tooltip text was invalid — reset.`);
  }
  { // tooltip modal line styles: dropped (with an issue) when invalid, and meaningless without a template
    const r = checkTooltipStyle(s.tooltipStyle);
    if (r.ok && sheet.tooltipText && r.value) sheet.tooltipStyle = r.value;
    if (!r.ok) issues.push(`${where}: the tooltip style was invalid — reset.`);
  }
  { // per-field tooltip number / date formats: dropped (with an issue) when invalid, and meaningless without a template
    const r = checkTooltipFormats(s.tooltipFormats);
    if (r.ok && sheet.tooltipText && r.value) sheet.tooltipFormats = r.value;
    if (!r.ok) issues.push(`${where}: the tooltip field formats were invalid — reset.`);
  }
  sheet.memberColors = cleanMemberColors(s.memberColors, where, issues);
  { const shapes = cleanMemberShapes(s.memberShapes, where, issues); if (shapes) sheet.memberShapes = shapes; } // Edit member shapes: the key exists only once a member has one, so older files round-trip unchanged
  sheet.showFilterCards = s.showFilterCards !== false;
  sheet.analytics = cleanAnalytics(s.analytics, where, issues);
  { const c = cleanCollapsed(s.collapsed, where, issues); if (c) sheet.collapsed = c; }
  sheet.showTitle = s.showTitle === undefined ? true : s.showTitle === true || (s.showTitle !== false && (issues.push(`${where}: showTitle must be on or off — reset.`), true));
  return sheet;
}

// Conditional formatting: per measure key, a known mode / scale, a numeric midpoint, ≤ 5 rules (known op + tone, numeric value)
// and an optional `totals: true` (Include totals). Anything else is dropped and reported, never coerced.
function cleanConditional(c, w, issues) {
  if (c == null) return {};
  if (typeof c !== "object" || Array.isArray(c)) { issues.push(`${w}: conditional formatting cleared.`); return {}; }
  const out = {};
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  for (const [key, cfg] of Object.entries(c).slice(0, CF_MAX_MEASURES)) {
    if (!isStr(key) || key.length > 400 || !cfg || typeof cfg !== "object" || !CF_MODES.has(cfg.mode) || !CF_SCALES.has(cfg.scale)
      || !(cfg.mid == null || num(cfg.mid)) || !Array.isArray(cfg.rules)) {
      issues.push(`${w}: conditional formatting for "${String(key).slice(0, 60)}" cleared.`);
      continue;
    }
    const rules = cfg.rules.slice(0, CF_MAX_RULES).filter((r) => r && CF_OPS.has(r.op) && CF_TONES.has(r.tone) && (r.value === null || num(r.value)));
    if (rules.length < Math.min(cfg.rules.length, CF_MAX_RULES) || cfg.rules.length > CF_MAX_RULES)
      issues.push(`${w}: some conditional-formatting rules for "${key.slice(0, 60)}" were dropped.`);
    out[key] = { mode: cfg.mode, scale: cfg.scale, mid: cfg.mid ?? null, rules: rules.map((r) => ({ op: r.op, value: r.value, tone: r.tone })) };
    if (cfg.totals === true) { // Include totals: stored only while on, and only where the measure draws something (the editor never stores an inert flag)
      if (out[key].mode !== "none" || out[key].rules.length) out[key].totals = true;
      else issues.push(`${w}: "Include totals" for "${key.slice(0, 60)}" has nothing to colour — dropped.`);
    }
    else if (cfg.totals !== undefined && cfg.totals !== false) issues.push(`${w}: "Include totals" for "${key.slice(0, 60)}" must be on or off — dropped.`);
  }
  if (Object.keys(c).length > CF_MAX_MEASURES) issues.push(`${w}: only the first ${CF_MAX_MEASURES} conditional formats were kept.`);
  return out;
}

// Analytics: known reference kind (a constant needs a number), a band of two numbers, a known trend,
// forecast 0 / 3 / 6 / 12, totals booleans. Anything else → that part reset, reported.
/** `{ measure }` for a valid non-default shown-measure index (integer 1..19), `{}` for none / 0; calls `reject` for anything else. */
function refMeasure(m, reject) {
  if (m === undefined || m === 0) return {};
  if (Number.isInteger(m) && m > 0 && m < 20) return { measure: m };
  reject();
  return {};
}
function cleanAnalytics(a, where, issues) {
  if (a == null) return null;
  if (typeof a !== "object") { issues.push(`${where}: analytics cleared.`); return null; }
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  const out = { ref: { kind: "none" }, band: null, trend: "none", forecast: 0, totals: { grand: false, sub: false } };
  let bad = false;
  if (a.ref && REF_KINDS.has(a.ref.kind) && (a.ref.kind !== "constant" || fin(a.ref.value))) out.ref = { kind: a.ref.kind, ...refMeasure(a.ref.measure, () => { bad = true; }), ...(a.ref.kind === "constant" ? { value: a.ref.value, ...(/^prm\d{1,6}$/.test(a.ref.param ?? "") ? { param: a.ref.param } : {}) } : {}) };
  else if (a.ref != null) bad = true;
  if (a.band != null && a.band.kind !== undefined) { // only the presets BAND_CHOICES offers
    const b = a.band;
    if (b.kind === "stddev" && (b.k === 1 || b.k === 2)) out.band = { kind: "stddev", k: b.k };
    else if (b.kind === "percentile" && !percentileError(b.lo, b.hi)) out.band = { kind: "percentile", lo: b.lo, hi: b.hi, ...(b.custom === true || !((b.lo === 25 && b.hi === 75) || (b.lo === 10 && b.hi === 90)) ? { custom: true } : {}) };
    else bad = true;
  } else if (a.band != null) {
    const pid = (v) => (/^prm\d{1,6}$/.test(v ?? "") ? v : undefined);
    if (fin(a.band.from) && fin(a.band.to)) {
      const fp = pid(a.band.fromParam), tp = pid(a.band.toParam);
      out.band = fp || tp ? { from: a.band.from, to: a.band.to, ...(fp ? { fromParam: fp } : {}), ...(tp ? { toParam: tp } : {}) } // ends follow parameters: the typed numbers stay in saved order
        : { from: Math.min(a.band.from, a.band.to), to: Math.max(a.band.from, a.band.to) };
    } else bad = true;
  }
  if (a.trendMeasure !== undefined) Object.assign(out, (({ measure }) => (measure ? { trendMeasure: measure } : {}))(refMeasure(a.trendMeasure, () => { bad = true; }))); // the measure the trend / forecast follow (absent = the first)
  if (a.trend !== undefined) { if (TRENDS.has(a.trend)) out.trend = a.trend; else bad = true; }
  if (a.forecast !== undefined) { if (FORECASTS.has(a.forecast)) out.forecast = a.forecast; else bad = true; }
  if (/^prm\d{1,6}$/.test(a.forecastParam ?? "")) out.forecastParam = a.forecastParam; // (checked against the workbook's parameters later)
  if (a.totals != null) { out.totals = { grand: a.totals.grand === true, sub: a.totals.sub === true }; }
  if (bad) issues.push(`${where}: part of the analytics settings was invalid — reset.`);
  return out;
}

// Parameters: ≤ 20, each checked (cleanParameter); duplicate ids keep the first.
function cleanParameters(list, issues) {
  if (list == null) return [];
  if (!Array.isArray(list)) { issues.push("The parameters weren't a list — none were opened."); return []; }
  const seen = new Set(), out = [];
  for (const raw of list.slice(0, MAX_PARAMS)) {
    const p = cleanParameter(raw, issues);
    if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); }
  }
  if (list.length > MAX_PARAMS) issues.push(`Only the first ${MAX_PARAMS} parameters were opened.`);
  return out;
}
// A pill whose calculated field is gone (not in the workbook's list) is removed, on shelves and mark slots.
const topGone = (f, ids) => f?.op === "top" && typeof f.topBy?.calc === "string" && !ids.has(f.topBy.calc);
// A Top-N filter ranked by a calculation that isn't in the workbook is removed (shared filters too).
function dropMissingTopCalcs(list, ids, where, issues) {
  if (!Array.isArray(list) || !list.some((f) => topGone(f, ids))) return list;
  issues.push(`${where}: a calculated field that no longer exists was removed.`);
  return list.filter((f) => !topGone(f, ids));
}
function dropMissingCalcs(sheet, ids, where, issues) {
  const gone = (p) => p && p.calc !== undefined && !ids.has(p.calc);
  const msg = (k) => issues.push(`${where} ${k}: a calculated field that no longer exists was removed.`);
  for (const k of ["columns", "rows", "color"]) if (Array.isArray(sheet[k]) && sheet[k].some(gone)) { sheet[k] = sheet[k].filter((p) => !gone(p)); msg(k); }
  if (Array.isArray(sheet.filters) && sheet.filters.some((p) => gone(p) || topGone(p, ids))) { sheet.filters = sheet.filters.filter((p) => !gone(p) && !topGone(p, ids)); msg("filters"); }
  for (const k of ["size", "label", "shape", "path", "angle"]) if (gone(sheet.marks?.[k])) { sheet.marks[k] = null; msg(k); }
  for (const k of ["detail", "tooltip"]) if (sheet.marks?.[k]?.some?.(gone)) { sheet.marks[k] = sheet.marks[k].filter((p) => !gone(p)); msg(k); }
  if (gone(sheet.pages)) { sheet.pages = null; msg("pages"); }
}
function unlinkParams(sheet, ids, where, issues) {
  for (const f of sheet.filters ?? []) if (f.param && !ids.has(f.param)) { delete f.param; issues.push(`${where}: a filter's parameter is missing — unlinked.`); }
  if (sheet.analytics?.ref?.param && !ids.has(sheet.analytics.ref.param)) { delete sheet.analytics.ref.param; issues.push(`${where}: the reference line's parameter is missing — unlinked.`); }
  if (sheet.analytics?.forecastParam && !ids.has(sheet.analytics.forecastParam)) { delete sheet.analytics.forecastParam; issues.push(`${where}: the forecast's parameter is missing — unlinked.`); }
  for (const f of [...(sheet.rows ?? []), ...(sheet.columns ?? [])]) if (f?.tableCalc?.windowParam && !ids.has(f.tableCalc.windowParam)) { delete f.tableCalc.windowParam; issues.push(`${where}: the moving-average window's parameter is missing — unlinked.`); }
  const band = sheet.analytics?.band;
  for (const k of ["fromParam", "toParam"]) if (band?.[k] && !ids.has(band[k])) { delete band[k]; issues.push(`${where}: a band end's parameter is missing — unlinked.`); }
  if (sheet.paramAction && !ids.has(sheet.paramAction.param)) { sheet.paramAction = null; issues.push(`${where}: the parameter action's parameter is missing — removed.`); }
  if (sheet.format?.topNParam && !ids.has(sheet.format.topNParam)) { delete sheet.format.topNParam; issues.push(`${where}: Top N's parameter is missing — unlinked.`); }
}

// Field settings: keys "db.table.column"; alias 1–60 characters, a known aggregation, hidden true, a known cast.
const AGG_NAMES = new Set(["sum", "avg", "min", "max", "median", "stddev", "variance", "attr", "count", "countDistinct", "countNonNull"]);
function cleanFieldMeta(raw, issues) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) { issues.push("The field settings weren't readable — cleared."); return {}; }
  const out = {};
  let bad = 0;
  for (const [k, v] of Object.entries(raw).slice(0, LIMITS.fieldSettings)) {
    if (!/^[^.]+\.[^.]+\..+$/.test(k) || !v || typeof v !== "object") { bad++; continue; }
    const m = {};
    if (v.alias !== undefined) { const r = text(v.alias, { label: "Field name", max: LIMITS.tabName, required: true }); if (r.ok) m.alias = r.value; else bad++; }
    if (v.agg !== undefined) { if (AGG_NAMES.has(v.agg)) m.agg = v.agg; else bad++; }
    if (v.cast !== undefined) { if (CASTS.includes(v.cast)) m.cast = v.cast; else bad++; }
    if (v.hidden !== undefined) { if (v.hidden === true) m.hidden = true; else if (v.hidden !== false) bad++; }
    if (v.memberAliases !== undefined) { const ma = cleanMemberAliases(v.memberAliases, `Field ${k}`, issues); if (ma) m.memberAliases = ma; }
    if (Object.keys(m).length) out[k] = m;
  }
  if (bad) issues.push(`${bad} field setting(s) were invalid and were dropped.`);
  return out;
}

// Period: a temporal field + a known preset / comparison; custom days must be YYYY-MM-DD.
function cleanPeriod(p, where, issues) {
  if (p == null) return null;
  const day = (v) => (v == null ? null : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  if (typeof p === "object" && p.calc !== undefined) { issues.push(`${where}: a calculated field can't be used as the date range — removed.`); return null; }
  const field = typeof p === "object" ? cleanPill(p, `${where} period`, issues) : null;
  const days = ["from", "to", "compareFrom", "compareTo", "latest"].map((k) => day(p?.[k]));
  if (!field || p.category !== "temporal" || !PERIOD_PRESETS.has(p.preset) || !PERIOD_COMPARES.has(p.compare) || days.includes(undefined)) {
    issues.push(`${where}: date range cleared.`);
    return null;
  }
  const [from, to, compareFrom, compareTo, latest] = days;
  return { db: p.db, table: p.table, column: p.column, category: "temporal", preset: p.preset, from, to,
    compare: p.compare, compareFrom, compareTo, ...(p.anchor === "latest" ? { anchor: "latest", latest } : p.anchor === "today" ? { anchor: "today" } : {}) }; // no anchor = counts from today, as older saves did
}

/** Pages' playback speed: `{ speed }` when a valid non-default name is stored, `{}` when absent or Medium; a bad value is reset to Medium and the file says so. */
function cleanPagesSpeed(v, where, issues) {
  if (v === undefined || v === null || v === "medium") return {};
  if (pageSpeedError(v) === null) return { speed: v };
  issues.push(`${where}: pages speed "${v}" — reset to Medium.`);
  return {};
}
function cleanDrill(d, where, issues) {
  if (d == null) return null;
  if (typeof d !== "object") { issues.push(`${where}: drill cleared.`); return null; }
  let levels = Array.isArray(d.levels) ? d.levels.map((p) => cleanPill(p, `${where} drill`, issues)).filter(Boolean) : [];
  if (levels.some((p) => p.calc !== undefined)) { issues.push(`${where}: a calculated field can't be a drill level — removed.`); levels = levels.filter((p) => p.calc === undefined); }
  if (levels.length > LIMITS.drillLevels) {
    issues.push(`${where}: drill kept the first ${LIMITS.drillLevels} levels.`);
    levels = levels.slice(0, LIMITS.drillLevels);
  }
  const okDepth = Number.isInteger(d.depth) && d.depth >= 0 && d.depth < levels.length;
  const okPath = okDepth && Array.isArray(d.path) && d.path.length === d.depth && d.path.every((x) => x && isStr(x.column));
  if (levels.length < 2 || !okPath) { issues.push(`${where}: drill cleared.`); return null; }
  return { levels, depth: d.depth, path: d.path.map((x) => ({ column: x.column, value: x.value ?? null, label: String(x.label ?? "").slice(0, 300) })) };
}

function cleanFormat(f0, where, issues) {
  const base = defaultFormat();
  const f = f0 && typeof f0 === "object" ? f0 : {};
  const w = `${where} format`;
  const out = { ...base };
  out.numberFormat = oneOf(NUMBER_FORMATS, f.numberFormat, base.numberFormat, w, "number format", issues);
  out.dateFormat = oneOf(DATE_FORMATS, f.dateFormat, base.dateFormat, w, "date format", issues);
  out.legend = oneOf(LEGENDS, f.legend, base.legend, w, "legend position", issues);
  out.dateBucket = oneOf(DATE_BUCKETS, f.dateBucket, base.dateBucket, w, "date grouping", issues);
  out.decimals = f.decimals == null ? null : Number.isInteger(f.decimals) && f.decimals >= 0 && f.decimals <= MAX_DECIMALS ? f.decimals
    : (issues.push(`${w}: decimals "${f.decimals}" — reset to Auto.`), null);
  if (typeof f.topNParam === "string" && /^prm\d{1,6}$/.test(f.topNParam)) out.topNParam = f.topNParam; // (checked against the workbook's parameters later)
  out.topN = f.topN == null ? null : TOP_N.has(f.topN) ? f.topN : (issues.push(`${w}: Top N "${f.topN}" — reset to All.`), null);
  out.conditional = cleanConditional(f.conditional, w, issues);
  out.fit = oneOf(FIT_MODES, f.fit, base.fit, w, "fit", issues);
  out.target = f.target == null ? null : typeof f.target === "number" && Number.isFinite(f.target) ? f.target
    : (issues.push(`${w}: target "${f.target}" — cleared.`), null);
  out.lineStyle = oneOf(LINE_STYLES, f.lineStyle, base.lineStyle, w, "line style", issues);
  out.heatmapShape = oneOf(HEATMAP_SHAPES, f.heatmapShape, base.heatmapShape, w, "heatmap shape", issues);
  if (f.ganttLength !== undefined) out.ganttLength = oneOf(GANTT_LENGTHS, f.ganttLength, "length", w, "Gantt length", issues); // absent (older files) reads Length; kept off defaultFormat
  out.secondaryType = oneOf(SECONDARY_TYPES, f.secondaryType, base.secondaryType, w, "right-axis marks", issues);
  out.markerShape = oneOf(MARKER_SHAPES, f.markerShape, base.markerShape, w, "marker shape", issues);
  if (f.markBorder === undefined) out.markBorder = base.markBorder;
  else if (markBorderError(f.markBorder) === null) out.markBorder = storedBorder(f.markBorder); // "none" or px; an older file's thin / medium / thick become 1 / 2 / 3
  else { issues.push(`${w}: border thickness "${f.markBorder}" — reset to none.`); out.markBorder = base.markBorder; }
  if (f.markBorderColor !== undefined) out.markBorderColor = oneOf(MARK_BORDER_COLOURS, f.markBorderColor, "muted", w, "border colour", issues); // absent (older files) reads Muted; kept off defaultFormat
  out.font = oneOf(FONTS, f.font, base.font, w, "font", issues);
  if (f.background !== undefined) out.background = oneOf(BACKGROUNDS, f.background, "none", w, "background", issues); // absent (older files) reads None; kept off defaultFormat so a sheet without one round-trips unchanged
  out.tableAlign = oneOf(TABLE_ALIGNS, f.tableAlign, base.tableAlign, w, "table alignment", issues);
  out.tableDensity = oneOf(TABLE_DENSITIES, f.tableDensity, base.tableDensity, w, "row height", issues);
  out.tableShade = oneOf(TABLE_SHADES, f.tableShade, base.tableShade, w, "table shading", issues);
  if (f.sizeScale !== undefined) { const r = cleanSizeScale(f.sizeScale); r.issues.forEach((m) => issues.push(`${w}: ${m.replace(/^(the )?/, "Size: ")}`)); if (r.value) out.sizeScale = r.value; } // Edit Sizes: absent (older files, the default) stays off defaultFormat so a sheet round-trips unchanged
  if (f.markOpacity !== undefined && f.markOpacity !== null) { // Format → Opacity: absent (older files, the default) stays off defaultFormat; a bad value is reset (never clamped)
    if (markOpacityError(f.markOpacity) === null) out.markOpacity = f.markOpacity;
    else issues.push(`${w}: opacity "${f.markOpacity}" — reset to 100 %.`);
  }
  if (f.labelOverlap !== undefined && f.labelOverlap !== null) { // Label flyout → Allow labels to overlap: absent or on (the default) stays off defaultFormat; only off is kept
    if (labelOverlapError(f.labelOverlap) === null) { if (f.labelOverlap === false) out.labelOverlap = false; }
    else issues.push(`${w}: allow labels to overlap "${f.labelOverlap}" — reset to on.`);
  }
  if (f.shapeBins !== undefined && f.shapeBins !== null) { // Format → Shape bins: absent (older files, the default 5) stays off defaultFormat; a bad value is reset (never clamped)
    if (shapeBinsError(f.shapeBins) === null) out.shapeBins = f.shapeBins;
    else issues.push(`${w}: shape bins "${f.shapeBins}" — reset to 5.`);
  }
  if (f.labelMarks !== undefined && f.labelMarks !== null) { // Format → Label marks: absent (older files, All) stays off defaultFormat; a bad value is reset (never clamped)
    if (labelMarksError(f.labelMarks) === null && f.labelMarks !== "all") out.labelMarks = f.labelMarks;
    else if (labelMarksError(f.labelMarks) !== null) issues.push(`${w}: label marks "${f.labelMarks}" — reset to All.`);
  }
  if (f.labelPosition !== undefined && f.labelPosition !== null) { // Format → Label position: absent (older files, Automatic) stays off defaultFormat; a bad value is reset (never clamped)
    if (labelPositionError(f.labelPosition) === null) { if (f.labelPosition !== "auto") out.labelPosition = f.labelPosition; }
    else issues.push(`${w}: label position "${f.labelPosition}" — reset to Automatic.`);
  }
  if (f.linePattern !== undefined && f.linePattern !== null) { // Format → Line pattern: absent (older files, Solid) stays off defaultFormat; a bad value is reset (never clamped)
    if (linePatternError(f.linePattern) === null) { if (f.linePattern !== "solid") out.linePattern = f.linePattern; }
    else issues.push(`${w}: line pattern "${f.linePattern}" — reset to Solid.`);
  }
  if (f.lineMarkers !== undefined && f.lineMarkers !== null) { // Format → Line markers: absent (older files, Automatic) stays off defaultFormat; a bad value is reset (never clamped)
    if (lineMarkersError(f.lineMarkers) === null) { if (f.lineMarkers !== "auto") out.lineMarkers = f.lineMarkers; }
    else issues.push(`${w}: line markers "${f.lineMarkers}" — reset to Automatic.`);
  }
  if (f.showTooltips !== undefined && f.showTooltips !== null) { // Format → Show tooltips: absent (older files, on) stays off defaultFormat; a bad value is reset (never coerced)
    if (showTooltipsError(f.showTooltips) === null) { if (f.showTooltips === false) out.showTooltips = false; }
    else issues.push(`${w}: show tooltips "${f.showTooltips}" — reset to on.`);
  }
  if (f.tooltipButtons !== undefined && f.tooltipButtons !== null) { // Format → command buttons in the tooltip: absent (older files, off) stays off defaultFormat
    if (tooltipButtonsError(f.tooltipButtons) === null) { if (f.tooltipButtons === true) out.tooltipButtons = true; }
    else issues.push(`${w}: tooltip command buttons "${f.tooltipButtons}" — reset to off.`);
  }
  if (f.tooltipMode !== undefined && f.tooltipMode !== null) { // Format → Responsive / On hover: absent (older files, Responsive) stays off defaultFormat
    if (tooltipModeError(f.tooltipMode) === null) { if (f.tooltipMode !== "responsive") out.tooltipMode = f.tooltipMode; }
    else issues.push(`${w}: tooltip mode "${f.tooltipMode}" — reset to Responsive (the choices are Responsive or On hover).`);
  }
  const tableCols = cleanTableCols(f.tableCols, w, issues); // absent when no column is set (older files, and the default), so a sheet round-trips unchanged
  if (tableCols) out.tableCols = tableCols;
  out.markerSize = f.markerSize == null ? null : markerSizeError(f.markerSize) === null ? f.markerSize
    : (issues.push(`${w}: marker size "${f.markerSize}" — reset to Auto.`), null);
  out.colorRamp = RAMP_CHOICES.some(([v]) => v === f.colorRamp) ? f.colorRamp : f.colorRamp === undefined ? base.colorRamp
    : (issues.push(`${w}: colour ramp "${f.colorRamp}" — reset to Brand.`), base.colorRamp);
  for (const k of ["colorMin", "colorMax"]) out[k] = f[k] == null ? null : Number.isFinite(f[k]) ? f[k] : (issues.push(`${w}: ${k} "${f[k]}" — cleared.`), null);
  if (colourRangeError(out.colorMin, out.colorMax)) { issues.push(`${w}: the colour range minimum was not less than the maximum — cleared.`); out.colorMin = out.colorMax = null; }
  out.colorScale = SCALE_CHOICES.some(([v]) => v === f.colorScale) ? f.colorScale : f.colorScale === undefined ? base.colorScale
    : (issues.push(`${w}: colour scale "${f.colorScale}" — reset to Low → high.`), base.colorScale);
  if (f.colorFullRange !== undefined) { // Use full colour range: absent (older files, the default) stays off defaultFormat; off = the symmetric scale
    if (typeof f.colorFullRange === "boolean") out.colorFullRange = f.colorFullRange;
    else issues.push(`${w}: use full colour range must be on or off — reset.`);
  }
  out.colorPair = DIV_PAIR_CHOICES.some(([v]) => v === f.colorPair) ? f.colorPair : f.colorPair === undefined ? base.colorPair
    : (issues.push(`${w}: diverging colours "${f.colorPair}" — reset to Orange / Blue.`), base.colorPair);
  out.colorSteps = f.colorSteps == null ? base.colorSteps : typeof f.colorSteps === "number" && !colourStepsError(f.colorSteps) ? f.colorSteps
    : (issues.push(`${w}: colour steps "${f.colorSteps}" — reset to Continuous.`), base.colorSteps);
  out.colorCentre = f.colorCentre == null ? null : typeof f.colorCentre === "number" && !colourCentreError(f.colorCentre) ? f.colorCentre : (issues.push(`${w}: colour centre "${f.colorCentre}" — cleared.`), null);
  out.targetMeasure = f.targetMeasure == null ? null : Number.isInteger(f.targetMeasure) && f.targetMeasure >= 1 && f.targetMeasure <= MAX_TARGET_MEASURE ? f.targetMeasure
    : (issues.push(`${w}: target measure "${f.targetMeasure}" — cleared.`), null);
  for (const k of ["dataLabels", "syncAxes", "dualAxis", "downIsGood", "approximate"]) {
    if (f[k] === undefined || typeof f[k] === "boolean") out[k] = f[k] ?? base[k];
    else issues.push(`${w}: ${k} must be on or off — reset.`);
  }
  for (const [k, what] of [["colorByDimension", "Colour by category"], ["paletteReverse", "Reverse palette"]]) { // removed settings: a saved "on" is dropped, and the file says so
    if (f[k] === true) issues.push(`${w}: ${what} no longer exists — dropped (colour a bar by putting its axis field on Color).`);
  }
  if (f.currencySymbol === undefined) out.currencySymbol = base.currencySymbol;
  else if (typeof f.currencySymbol === "string" && f.currencySymbol.length <= 8) out.currencySymbol = f.currencySymbol;
  else issues.push(`${w}: the currency symbol was invalid — reset to ${base.currencySymbol}.`);
  for (const k of ["xTitle", "yTitle"]) {
    const r = f[k] == null ? null : typeof f[k] !== "string" ? { ok: false, error: "Axis title must be text" }
      : text(f[k], { label: "Axis title", max: LIMITS.axisTitle });
    out[k] = r === null ? null : r.ok ? r.value || null : (issues.push(`${w}: ${r.error} — cleared.`), null);
  }
  return out;
}

/** A saved sheet merged over today's defaults, so workbooks from older builds gain new fields. */
export const restoreSheet = (saved) => sanitizeSheet(saved, "Sheet", []);

/** The browser-storage key for the session's server + user, or null while disconnected. */
export function storageKey(view, version = WORKBOOK_VERSION) {
  if (!view?.connected) return null;
  return `dashboardbuilder.workbook.v${version}|${view.host}|${view.port}|${view.user}`;
}

/** The v1 autosave key: read when no v2 entry exists yet (and never deleted or written). */
export const legacyStorageKey = (view) => storageKey(view, 1);

const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** "1 issue" / "3 issues". */
export const issueCount = (n) => plural(n, "issue");
/** The restore toast: tables apart from unions / unpivots; dashboards and stories only when there are some. */
export function restoredSummary(wb) {
  const sources = wb.entities.filter((e) => e.source).length;
  const parts = [plural(wb.entities.length - sources, "table"), ...(sources ? [`${sources} ${sources === 1 ? "union/unpivot" : "unions/unpivots"}`] : []), plural(wb.worksheets.length, "worksheet"),
    ...(wb.dashboards.length ? [plural(wb.dashboards.length, "dashboard")] : []), ...(wb.stories.length ? [plural(wb.stories.length, "story")] : [])];
  return `Restored your last workbook (${parts.join(", ")}).`;
}
