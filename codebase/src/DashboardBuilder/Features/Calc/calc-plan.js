// Calculated fields in the worksheet query plan (pure, DOM-free; tests/js/calc-plan.test.mjs).
// `buildPlan` (Dashboard/sheet-plan.js) calls these to turn pills into wire refs, list the tables a pill reads, and
// refuse (E15) before any query when a calculation can't be computed. ctx = { calcs, catalog }.
import { compileCalculation, calcTables } from "./calc-resolve.js";
import { isCalcPill, pillName, pillSlots } from "./calc-pill.js";
import { STAT_SINGLE_TABLE } from "../Dashboard/show-me-rules.js";

export const STAT_CALC_HINT = "Histogram and box plot don't use calculated fields yet.";
/** Histogram / box plot run single-table endpoints that know nothing of calculations: the hint, or `null`. */
export const statCalcProblem = (sheet) => (STAT_SINGLE_TABLE.has(sheet.chartType)
  && [...(sheet.columns ?? []), ...(sheet.rows ?? [])].some(isCalcPill) ? STAT_CALC_HINT : null);

const find = (f, ctx) => (ctx.calcs ?? []).find((c) => c.id === f.calc);
/** `{ calc, c }` — the stored calculation and its compile, or `null` when the calculation is gone. */
function compiled(f, ctx) {
  const calc = find(f, ctx);
  return calc ? compileCalculation(calc, ctx.calcs, ctx.catalog) : null;
}

/** The group-by ref for a pill (E12: a calculated dimension is never date-grouped). */
export function wireDim(f, ctx) {
  if (isCalcPill(f)) {
    const c = compiled(f, ctx);
    return { db: "", table: "", column: pillName(f, ctx.calcs), ...(c && !c.error ? { calc: c.ast } : {}) };
  }
  return { db: f.db, table: f.table, column: f.column,
    ...(f.category === "temporal" && f.datePart && f.datePart !== "auto" ? { datePart: f.datePart } : {}) };
}

/** The measure ref for a plan entry `{ field, agg }`; an aggregate calculation carries no `agg`. */
export function wireMeasure(entry, ctx) {
  const f = entry.field;
  if (!isCalcPill(f)) return { db: f.db, table: f.table, column: f.column, agg: entry.agg };
  const c = compiled(f, ctx);
  const ref = { db: "", table: "", column: pillName(f, ctx.calcs) };
  if (!c || c.error) return { ...ref, agg: entry.agg };
  return c.info.isAggregate ? { ...ref, calc: c.ast } : { ...ref, calc: c.ast, agg: entry.agg ?? "sum" };
}

/** `"db.table"` keys a pill adds to the query's table list (none for a constant or an unusable calculation). */
export function planTables(f, ctx) {
  if (!isCalcPill(f)) return [`${f.db}.${f.table}`];
  const c = compiled(f, ctx);
  return c && !c.error ? calcTables(c.info).sort() : [];
}

/** First E15 message among the sheet's calculated-field pills, or `null`. `shared` are the applied shared
 *  filters: a shared Top-N ranked by a calculation that is gone must stop the view, not send `topBy: null`. */
export function calcProblem(sheet, ctx, shared = []) {
  const seen = new Set();
  for (const f of pillSlots(sheet)) {
    if (!isCalcPill(f) || seen.has(f.calc)) continue;
    seen.add(f.calc);
    const c = compiled(f, ctx);
    if (!c) return `Calculation '${f.column}' can't be computed: it no longer exists.`;
    if (c.error) return c.error.message;
  }
  for (const x of [...(sheet.filters ?? []), ...shared]) { // a Top-N ranked by a calculation
    const t = x?.op === "top" ? x.topBy : null;
    if (!t || typeof t.calc !== "string" || seen.has(t.calc)) continue;
    seen.add(t.calc);
    const c = compiled(t, ctx);
    if (!c) return `Calculation '${t.column}' can't be computed: it no longer exists.`;
    if (c.error) return c.error.message;
  }
  return null;
}

/** The word an aggregation reads as in a measure's name (matches the server's column naming). */
export const aggWord = (a) => (a === "countDistinct" ? "distinct" : a === "countNonNull" ? "non-null" : a);

/** Display name of a measure, matching the server's result column. `alias` is a plain field's P28 name. */
export function measureLabel(f, calcs, alias) {
  if (isCalcPill(f)) return pillName(f, calcs);
  const a = f.agg ?? "sum";
  const n = alias || f.column;
  if (a === "count") return "count";
  return `${aggWord(a)} ${n}`;
}

/** The `topBy` a Top-N filter stores for a plan entry: a calc pill keeps its id (`calc`) and label. */
export function topByRef(entry, ctx) {
  const f = entry.field;
  if (!isCalcPill(f)) return { db: f.db, table: f.table, column: f.column, agg: entry.agg };
  const c = compiled(f, ctx);
  const ref = { db: "", table: "", column: pillName(f, ctx.calcs), calc: f.calc };
  return c && !c.error && c.info.isAggregate ? ref : { ...ref, agg: entry.agg ?? "sum" };
}

/** Select-option value that identifies a plan entry as a ranking measure. */
export const topByKey = (entry) => (isCalcPill(entry.field)
  ? `calc:${entry.field.calc}:${entry.agg ?? ""}`
  : `${entry.field.db}.${entry.field.table}.${entry.field.column}:${entry.agg}`);

/** A stored `topBy` as the server takes it: a calc id becomes its tree. */
export function wireTopBy(t, ctx) {
  if (typeof t.calc !== "string") return { db: t.db, table: t.table, column: t.column, agg: t.agg ?? "sum" };
  const c = compiled(t, ctx);
  if (!c || c.error) return null; // never a calc-less ref; calcProblem refuses the view first
  const ref = { db: "", table: "", column: pillName(t, ctx.calcs), calc: c.ast };
  return c.info.isAggregate ? ref : { ...ref, agg: t.agg ?? "sum" };
}

/** Finds the sort target for a stored `sort.by`; a calc pill matches whatever agg it had (the agg can change). */
export function resolveSortTarget(targets, by) {
  const exact = targets.find((x) => x.id === by);
  if (exact || typeof by !== "string") return exact;
  const i = by.indexOf(":calc:");
  if (i < 0) return undefined;
  const stem = by.slice(0, by.lastIndexOf(":") + 1);
  return targets.find((x) => x.id.startsWith(stem));
}
