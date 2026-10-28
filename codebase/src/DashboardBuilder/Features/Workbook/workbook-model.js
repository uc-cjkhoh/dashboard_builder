// Workbook save/load format — pure, DOM-free (unit-tested under tests/js/).
// A workbook is the whole builder state: the Data Model (tables + positions + join keys +
// relationships) and every dashboard's worksheet. It never contains the connection or a password —
// a workbook is reopened against whatever server the session is connected to.
import { emptySheet, defaultFormat } from "../Core/store.js";
import { LIMITS, text } from "../Core/validate.js";
import { aggsFor } from "../Dashboard/filter-rules.js";
import { CASTS } from "../Dashboard/cast-model.js";
import { cleanTheme, DEFAULT_THEME } from "../Core/theme-model.js";
import { cleanAction } from "../Dashboard/action-model.js";
import { cleanMemberColors } from "../Dashboard/colour-model.js";
import { checkTooltipText } from "../Dashboard/tooltip-model.js";
import { cleanParameter, MAX_PARAMS } from "../Core/parameters-model.js";
import { cleanCalculations } from "../Calc/calc-workbook.js";
import { CALC_AGGS } from "../Calc/calc-pill.js";
import {
  CHART_TYPE_IDS, CATEGORIES, FILTER_OPS, NUMBER_FORMATS, DATE_FORMATS, LEGENDS, TOP_N, MAX_DECIMALS, DATE_BUCKETS,
  PERIOD_PRESETS, PERIOD_COMPARES, DATE_PARTS, TABLE_CALCS, CALC_ALONG, FIT_MODES, REF_KINDS, TRENDS, FORECASTS, CF_MODES, CF_SCALES, CF_OPS, CF_TONES, CF_MAX_RULES, CF_MAX_MEASURES,
} from "../Core/sheet-schema.js";

export const WORKBOOK_FORMAT = "dashboard-builder-workbook";
export const WORKBOOK_VERSION = 1;
const CARDINALITIES = new Set(["1:1", "1:N", "N:1", "N:M"]);
const NOT_A_WORKBOOK = "This file is not a Dashboard Builder workbook.";

/** Builder state → a plain JSON-safe object. DOM nodes, fetched columns and lazily-loaded page
 *  members are left out (they are re-fetched on open). */
export function serializeWorkbook({ entities, relationships, dashboards, active, theme, sharedFilters = [], bookmarks = [], fieldMeta = new Map(), parameters = [], calculations = [], nextCalcId }) {
  const activeIndex = active?.kind === "dashboard" ? dashboards.findIndex((d) => d.id === active.id) : -1;
  return {
    format: WORKBOOK_FORMAT,
    version: WORKBOOK_VERSION,
    savedAt: new Date().toISOString(),
    entities: [...entities.values()].map((e) => ({
      id: e.id, db: e.db, table: e.table, x: Math.round(e.x), y: Math.round(e.y),
      // Keys a just-opened workbook is still waiting to tick (columns loading, or a table that
      // failed to load) are kept, so saving early never loses them.
      joinKeys: [...new Set([...e.joinKeys, ...(e.pendingKeys ?? [])])],
    })),
    relationships: [...relationships.values()].map((r) => ({
      from: { entityId: r.from.entityId, column: r.from.column },
      to: { entityId: r.to.entityId, column: r.to.column },
      cardinality: r.cardinality,
      joinType: r.joinType === "left" ? "left" : "inner", // P31
    })),
    dashboards: dashboards.map((d) => ({ name: d.name, sheet: savedSheet(d.sheet) })),
    active: activeIndex >= 0 ? activeIndex : null,
    theme: theme ? { accent: theme.accent, palette: theme.palette } : { ...DEFAULT_THEME },
    sharedFilters: structuredClone(sharedFilters),
    fields: Object.fromEntries(fieldMeta), // P28
    parameters: structuredClone(parameters), // P32
    calculations: calculations.map((c) => ({ id: c.id, name: c.name, formula: c.formula })), // Plan B (no parsed tree)
    // The next calculation number, so a deleted highest id is never handed out again (absent when there never were any).
    ...(calculations.length || nextCalcId ? { nextCalcId: Math.max(Number.isInteger(nextCalcId) ? nextCalcId : 0, ...calculations.map((c) => Number(String(c.id).slice(4)) + 1)) } : {}),
    // P39: each bookmark points at its dashboard by index (null when that dashboard was closed).
    bookmarks: bookmarks.map((b) => {
      const i = dashboards.findIndex((d) => d.id === b.dashId);
      return { name: b.name, dashboard: i >= 0 ? i : null, dashName: b.dashName, sheet: savedSheet(b.sheet),
        sharedFilters: structuredClone(b.sharedFilters ?? []), savedAt: b.savedAt };
    }),
  };
}

function savedSheet(sheet) {
  const copy = structuredClone(sheet);
  if (copy.pages) { delete copy.pages.members; delete copy.pages.loadError; delete copy.pages.more; } // re-fetched from the bounded distinct query
  return copy;
}

/** JSON text → a validated workbook `{ entities, relationships, dashboards, active, issues }`. Throws an
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
    entities.push({ id: e.id, db: e.db, table: e.table, x: coord(e.x), y: coord(e.y), joinKeys: keys.filter(isStr) });
  }
  if (skipped) issues.push(`Skipped ${skipped} table(s) with missing details.`);
  const ids = new Set(entities.map((e) => e.id));
  const endpoint = (p) => p && ids.has(p.entityId) && isStr(p.column);

  if (raw.relationships !== undefined && !Array.isArray(raw.relationships)) issues.push("The relationships weren't a list — none were opened.");
  const relList = Array.isArray(raw.relationships) ? raw.relationships.slice() : [];
  if (relList.length > LIMITS.relationships) {
    issues.push(`Only the first ${LIMITS.relationships} relationships were opened.`);
    relList.length = LIMITS.relationships;
  }
  const relationships = relList
    .filter((r) => r && endpoint(r.from) && endpoint(r.to) && CARDINALITIES.has(r.cardinality))
    .map((r) => ({
      from: { entityId: r.from.entityId, column: r.from.column },
      to: { entityId: r.to.entityId, column: r.to.column },
      cardinality: r.cardinality,
      joinType: r.joinType === "left" ? "left" : "inner", // P31 — anything else reads as inner
    }));
  const droppedRels = relList.length - relationships.length;
  if (droppedRels > 0) issues.push(`Skipped ${droppedRels} relationship(s) that referenced missing tables or had an unknown cardinality.`);

  if (raw.dashboards !== undefined && !Array.isArray(raw.dashboards)) issues.push("The dashboards weren't a list — none were opened.");
  const allDash = Array.isArray(raw.dashboards) ? raw.dashboards : [];
  const list = allDash.filter((d) => d && typeof d === "object");
  if (list.length < allDash.length) issues.push(`Skipped ${allDash.length - list.length} entry(ies) that were not a dashboard.`);
  if (list.length > LIMITS.dashboards) {
    issues.push(`Only the first ${LIMITS.dashboards} dashboards were opened.`);
    list.length = LIMITS.dashboards;
  }
  const dashboards = list.map((d) => {
    const r = d.name == null || typeof d.name === "string"
      ? text(d.name, { label: "Tab name", max: LIMITS.tabName, required: true })
      : { ok: false, error: "The dashboard name must be text." };
    let name = "Dashboard";
    if (r.ok) name = r.value;
    else issues.push(`A dashboard name was reset to "Dashboard": ${r.error}`);
    return { name, sheet: sanitizeSheet(d.sheet, `Sheet "${name}"`, issues) };
  });

  if (raw.active != null && !(Number.isInteger(raw.active) && raw.active >= 0 && raw.active < dashboards.length))
    issues.push("The saved active dashboard was invalid — the data model view was opened.");
  const active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < dashboards.length ? raw.active : null;
  const theme = cleanTheme(raw.theme, issues); // P41 — absent (older workbooks) = the default theme
  const sharedFilters = cleanFilters(raw.sharedFilters, "Shared filters", issues, LIMITS.sharedFilters); // P40
  const bookmarks = cleanBookmarks(raw.bookmarks, dashboards.length, issues); // P39
  const fields = cleanFieldMeta(raw.fields, issues); // P28
  const parameters = cleanParameters(raw.parameters, issues); // P32
  // A filter or Top N that points at a parameter the workbook doesn't have falls back to its own value.
  const paramIds = new Set(parameters.map((p) => p.id));
  for (const d of dashboards) unlinkParams(d.sheet, paramIds, `Sheet "${d.name}"`, issues);
  for (const f of sharedFilters) if (f.param && !paramIds.has(f.param)) { delete f.param; issues.push("A shared filter's parameter is missing — unlinked."); }
  const calculations = cleanCalculations(raw.calculations, issues); // Plan B
  const calcIds = new Set(calculations.map((c) => c.id));
  for (const d of dashboards) dropMissingCalcs(d.sheet, calcIds, `Sheet "${d.name}"`, issues);
  for (const b of bookmarks) {
    dropMissingCalcs(b.sheet, calcIds, `Bookmark "${b.name}"`, issues);
    b.sharedFilters = dropMissingTopCalcs(b.sharedFilters, calcIds, `Bookmark "${b.name}" shared filters`, issues);
  }
  const sharedKept = dropMissingTopCalcs(sharedFilters, calcIds, "Shared filters", issues);
  sharedFilters.splice(0, sharedFilters.length, ...sharedKept);
  let nextCalcId;
  if (raw.nextCalcId !== undefined) {
    if (Number.isInteger(raw.nextCalcId) && raw.nextCalcId >= 1 && raw.nextCalcId <= 999999) nextCalcId = raw.nextCalcId;
    else issues.push("The saved next calculation number was invalid — ignored.");
  }
  return { entities, relationships, dashboards, active, theme, sharedFilters, bookmarks, fields, parameters, calculations, nextCalcId, issues: [...new Set(issues)] };
}

const isStr = (v) => typeof v === "string" && v.length > 0;
const defAgg = (p) => (p.category === "numeric" ? "sum" : "count");

// `needCategory: false` is for filters: workbooks from older builds saved filters without a category,
// and the worksheet backfills it from the column catalog at runtime.
function cleanPill(raw, where, issues, needCategory = true) {
  // A calculated field (E7/B1) is identified by `calc`; its db/table/column are only a fallback label.
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
  if (isCalc) delete p.datePart; // E12: a calculated dimension is never date-grouped
  if (p.role !== undefined && p.role !== "dimension" && p.role !== "measure") {
    issues.push(`${where}: ${p.table}.${p.column} had an unknown role "${p.role}" — cleared.`); delete p.role;
  }
  if (isCalc && p.agg !== undefined && !CALC_AGGS.includes(p.agg)) {
    issues.push(`${where}: ${p.column} can't use "${p.agg}" — reset to sum.`); p.agg = "sum";
  } else if (!isCalc && p.agg !== undefined && p.category !== undefined && !aggsFor(p.category).includes(p.agg)) {
    issues.push(`${where}: ${p.table}.${p.column} can't use "${p.agg}" — reset to ${defAgg(p)}.`); p.agg = defAgg(p);
  }
  // P27 table calculation: a known type, direction and window (2–30).
  if (p.tableCalc !== undefined) {
    const c = p.tableCalc;
    const ok = c && typeof c === "object" && TABLE_CALCS.has(c.type) && CALC_ALONG.has(c.along ?? "auto")
      && (c.window === undefined || (Number.isInteger(c.window) && c.window >= 2 && c.window <= 30));
    if (!ok) { issues.push(`${where}: the table calculation on ${p.table}.${p.column} was invalid — removed.`); delete p.tableCalc; }
    else p.tableCalc = { type: c.type, along: c.along ?? "auto", ...(c.window !== undefined ? { window: c.window } : {}) };
  }
  // P26 date part: a known part on a date field only.
  if (p.datePart !== undefined && (!DATE_PARTS.has(p.datePart) || p.category !== "temporal")) {
    issues.push(`${where}: ${p.table}.${p.column} had an unusable date part "${p.datePart}" — reset to Auto.`); delete p.datePart;
  }
  // P40 field choices: a list of whole fields (db / table / column / category), ≤ 8, the shown one included.
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
// Filters (a sheet's, or the workbook's shared ones — P40): pills with a known op and text value(s).
export function cleanFilters(list, where, issues, max) {
  return cleanPills(list, where, issues, max, false).filter((f) => {
    if (f.calc !== undefined) { issues.push(`${where}: a calculated field can't be used as a filter — removed.`); return false; } // E12
    const multi = f.op === "in" || f.op === "notin" || f.op === "between";
    if (FILTER_OPS.has(f.op) && !multi && f.value !== undefined && f.value !== null && typeof f.value !== "string") {
      issues.push(`${where}: the value of the filter on ${f.table}.${f.column} wasn't text — reset to empty.`); f.value = "";
    }
    // P30: a top-N filter must name its ranking measure.
    // A ranking by a calculation names it by id (db / table are empty); its agg, when present, is a row-level one.
    const calcTop = f.topBy && typeof f.topBy.calc === "string" && /^calc\d{1,6}$/.test(f.topBy.calc) && (f.topBy.agg === undefined || CALC_AGGS.includes(f.topBy.agg));
    const okTop = f.op !== "top" || calcTop || (f.topBy && typeof f.topBy.calc !== "string" && isStr(f.topBy.db) && isStr(f.topBy.table) && isStr(f.topBy.column) && aggsFor("numeric").includes(f.topBy.agg ?? "sum"));
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
      ? { db: s.pages.db, table: s.pages.table, column: s.pages.column, category: s.pages.category, index: s.pages.index }
      : (issues.push(`${where}: pages cleared.`), null);
  sheet.format = cleanFormat(s.format, where, issues);
  sheet.period = cleanPeriod(s.period, where, issues);
  sheet.urlAction = cleanAction(s.urlAction, where, issues); // P39
  // P23 title / caption: text (≤ 80 / ≤ 300) or null for the automatic one; showTitle a boolean.
  for (const [k, max] of [["title", 80], ["caption", 300]]) {
    const v = s[k];
    if (v == null) sheet[k] = null;
    else { const r = typeof v === "string" ? text(v, { label: k, max, required: true }) : { ok: false }; sheet[k] = r.ok ? r.value : null; if (!r.ok) issues.push(`${where}: the ${k} was invalid — reset.`); }
  }
  { // T01-19 tooltip template: trimmed text ≤ LIMITS.tooltipText, or null for the automatic tooltip
    const r = checkTooltipText(s.tooltipText);
    sheet.tooltipText = r.ok ? r.value : null;
    if (!r.ok) issues.push(`${where}: the tooltip text was invalid — reset.`);
  }
  sheet.memberColors = cleanMemberColors(s.memberColors, where, issues); // T01-20
  sheet.showFilterCards = s.showFilterCards !== false; // P30
  sheet.analytics = cleanAnalytics(s.analytics, where, issues); // P21
  sheet.showTitle = s.showTitle === undefined ? true : s.showTitle === true || (s.showTitle !== false && (issues.push(`${where}: showTitle must be on or off — reset.`), true));
  return sheet;
}

// P37 conditional formatting: per measure key, a known mode / scale, a numeric midpoint and ≤ 5 rules
// (known op + tone, numeric value). Anything else is dropped and reported, never coerced.
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
    const rules = cfg.rules.slice(0, CF_MAX_RULES).filter((r) => r && CF_OPS.has(r.op) && CF_TONES.has(r.tone) && num(r.value));
    if (rules.length < Math.min(cfg.rules.length, CF_MAX_RULES) || cfg.rules.length > CF_MAX_RULES)
      issues.push(`${w}: some conditional-formatting rules for "${key.slice(0, 60)}" were dropped.`);
    out[key] = { mode: cfg.mode, scale: cfg.scale, mid: cfg.mid ?? null, rules: rules.map((r) => ({ op: r.op, value: r.value, tone: r.tone })) };
  }
  if (Object.keys(c).length > CF_MAX_MEASURES) issues.push(`${w}: only the first ${CF_MAX_MEASURES} conditional formats were kept.`);
  return out;
}

// P21 analytics: known reference kind (a constant needs a number), a band of two numbers, a known trend,
// forecast 0 / 3 / 6 / 12, totals booleans. Anything else → that part reset, reported.
function cleanAnalytics(a, where, issues) {
  if (a == null) return null;
  if (typeof a !== "object") { issues.push(`${where}: analytics cleared.`); return null; }
  const fin = (v) => typeof v === "number" && Number.isFinite(v);
  const out = { ref: { kind: "none" }, band: null, trend: "none", forecast: 0, totals: { grand: false, sub: false } };
  let bad = false;
  if (a.ref && REF_KINDS.has(a.ref.kind) && (a.ref.kind !== "constant" || fin(a.ref.value))) out.ref = { kind: a.ref.kind, ...(a.ref.kind === "constant" ? { value: a.ref.value } : {}) };
  else if (a.ref != null) bad = true;
  if (a.band != null) { if (fin(a.band.from) && fin(a.band.to)) out.band = { from: Math.min(a.band.from, a.band.to), to: Math.max(a.band.from, a.band.to) }; else bad = true; }
  if (a.trend !== undefined) { if (TRENDS.has(a.trend)) out.trend = a.trend; else bad = true; }
  if (a.forecast !== undefined) { if (FORECASTS.has(a.forecast)) out.forecast = a.forecast; else bad = true; }
  if (a.totals != null) { out.totals = { grand: a.totals.grand === true, sub: a.totals.sub === true }; }
  if (bad) issues.push(`${where}: part of the analytics settings was invalid — reset.`);
  return out;
}

// P32 parameters: ≤ 20, each checked (cleanParameter); duplicate ids keep the first.
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
// A Top-N filter ranked by a calculation that isn't in the workbook is removed (shared filters and bookmarks' too).
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
  if (sheet.format?.topNParam && !ids.has(sheet.format.topNParam)) { delete sheet.format.topNParam; issues.push(`${where}: Top N's parameter is missing — unlinked.`); }
}

// P28 field settings: keys "db.table.column"; alias 1–60 characters, a known aggregation, hidden true, a known cast (T02-34).
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
    if (v.cast !== undefined) { if (CASTS.includes(v.cast)) m.cast = v.cast; else bad++; } // T02-34
    if (v.hidden !== undefined) { if (v.hidden === true) m.hidden = true; else if (v.hidden !== false) bad++; }
    if (Object.keys(m).length) out[k] = m;
  }
  if (bad) issues.push(`${bad} field setting(s) were invalid and were dropped.`);
  return out;
}

// P39 bookmarks: a name, a sheet (validated like any sheet, but its click selection is part of the
// view, so a well-formed one is kept), shared filters, and a dashboard index (null if out of range).
function cleanBookmarks(list, dashCount, issues) {
  if (list == null) return [];
  if (!Array.isArray(list)) { issues.push("The bookmarks weren't a list — none were opened."); return []; }
  if (list.length > LIMITS.bookmarks) issues.push(`Only the first ${LIMITS.bookmarks} bookmarks were opened.`);
  const out = [];
  for (const b of list.slice(0, LIMITS.bookmarks)) {
    const name = b && typeof b === "object" ? text(b.name, { label: "Bookmark name", max: LIMITS.tabName, required: true }) : { ok: false };
    if (!name.ok || !b.sheet || typeof b.sheet !== "object") { issues.push("Skipped a bookmark with no name or view."); continue; }
    const where = `Bookmark "${name.value}"`;
    const sheet = sanitizeSheet(b.sheet, where, issues);
    const sel = b.sheet.selection;
    if (sel && isStr(sel.db) && isStr(sel.table) && isStr(sel.column) && (typeof sel.value === "string" || typeof sel.value === "number")
      && (sel.action == null || sel.action === "keep" || sel.action === "exclude"))
      sheet.selection = { db: sel.db, table: sel.table, column: sel.column, value: sel.value, label: String(sel.label ?? ""), action: sel.action ?? null };
    const dashboard = Number.isInteger(b.dashboard) && b.dashboard >= 0 && b.dashboard < dashCount ? b.dashboard : null;
    out.push({ name: name.value, dashboard, dashName: typeof b.dashName === "string" && b.dashName.trim() ? b.dashName.trim().slice(0, LIMITS.tabName) : name.value,
      sheet, sharedFilters: cleanFilters(b.sharedFilters, `${where} shared filters`, issues, LIMITS.sharedFilters),
      savedAt: typeof b.savedAt === "string" ? b.savedAt : null });
  }
  return out;
}

// P35 period: a temporal field + a known preset / comparison; custom days must be YYYY-MM-DD.
function cleanPeriod(p, where, issues) {
  if (p == null) return null;
  const day = (v) => (v == null ? null : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  if (typeof p === "object" && p.calc !== undefined) { issues.push(`${where}: a calculated field can't be used as the date range — removed.`); return null; }
  const field = typeof p === "object" ? cleanPill(p, `${where} period`, issues) : null;
  const days = ["from", "to", "compareFrom", "compareTo"].map((k) => day(p?.[k]));
  if (!field || p.category !== "temporal" || !PERIOD_PRESETS.has(p.preset) || !PERIOD_COMPARES.has(p.compare) || days.includes(undefined)) {
    issues.push(`${where}: date range cleared.`);
    return null;
  }
  const [from, to, compareFrom, compareTo] = days;
  return { db: p.db, table: p.table, column: p.column, category: "temporal", preset: p.preset, from, to,
    compare: p.compare, compareFrom, compareTo };
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
  return { levels, depth: d.depth, path: d.path.map((x) => ({ column: x.column, value: x.value ?? null, label: String(x.label ?? "") })) };
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
  if (typeof f.topNParam === "string" && /^prm\d{1,6}$/.test(f.topNParam)) out.topNParam = f.topNParam; // P32 (checked against the workbook's parameters later)
  out.topN = f.topN == null ? null : TOP_N.has(f.topN) ? f.topN : (issues.push(`${w}: Top N "${f.topN}" — reset to All.`), null);
  out.conditional = cleanConditional(f.conditional, w, issues);
  out.fit = oneOf(FIT_MODES, f.fit, base.fit, w, "fit", issues); // P23
  out.target = f.target == null ? null : typeof f.target === "number" && Number.isFinite(f.target) ? f.target
    : (issues.push(`${w}: target "${f.target}" — cleared.`), null);
  for (const k of ["dataLabels", "colorByDimension", "paletteReverse", "downIsGood", "approximate"]) {
    if (f[k] === undefined || typeof f[k] === "boolean") out[k] = f[k] ?? base[k];
    else issues.push(`${w}: ${k} must be on or off — reset.`);
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
export function storageKey(view) {
  if (!view?.connected) return null;
  return `dashboardbuilder.workbook.v${WORKBOOK_VERSION}|${view.host}|${view.port}|${view.user}`;
}
