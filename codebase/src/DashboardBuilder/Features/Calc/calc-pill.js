// Calculated-field pills (pure, DOM-free; tests/js/calc-pill.test.mjs). Pill shape (plan decision B1):
//   { calc: id, db: "", table: "", column: <name at last save>, category, role, agg? }
// The live name always comes from the calculation list by id; `column` is only a fallback.
import { roleOfCalc } from "./calc-model.js";
import { compileCalculation } from "./calc-resolve.js";

const CATEGORY = { number: "numeric", text: "text", date: "temporal", boolean: "boolean" };
export const REFUSAL = "Calculated fields can't be used here yet.";
const ENTRIES = new Set(["filter", "pages", "drill", "period", "sharedFilter", "selection", "shape", "angle", "choice"]);

/** Aggregations a row-level calculated measure may use; mirrors the server's CalcCatalog.RowLevelAggregations (never `count`). */
export const CALC_AGGS = ["sum", "avg", "min", "max", "median", "stddev", "variance", "attr", "countDistinct", "countNonNull"];

export const isCalcPill = (f) => Boolean(f) && typeof f === "object" && typeof f.calc === "string";

/** A pill for `calc`; `role` defaults from the compile info. A row-level measure gets `agg: "sum"`. */
export function makeCalcPill(calc, info, role) {
  const r = role ?? roleOfCalc(info);
  const pill = { calc: calc.id, db: "", table: "", column: calc.name, category: CATEGORY[info.type] ?? "other", role: r };
  if (r === "measure" && !info.isAggregate) pill.agg = "sum";
  return pill;
}

/** Live name (follows renames), falling back to the saved column. */
export function pillName(f, calcs) {
  if (!isCalcPill(f)) return `${f.table}.${f.column}`;
  return (calcs ?? []).find((c) => c.id === f.calc)?.name ?? f.column;
}

/** Same shape as dashboards.js `fieldId`, so a stored sort target survives. */
export const calcPillId = (f, kind) => `${kind}:calc:${f.calc}:${f.agg ?? ""}`;

export const sameCalcPill = (a, b) => isCalcPill(a) && isCalcPill(b) && a.calc === b.calc;

/** The toast text when a calc pill is dropped on an entry point E12 refuses; null otherwise. */
export function refusal(f, entry) {
  return isCalcPill(f) && ENTRIES.has(entry) ? REFUSAL : null;
}

const SINGLES = ["size", "label", "shape", "path", "angle"];
export function* pillSlots(sheet) {
  for (const k of ["rows", "columns", "color"]) for (const f of sheet[k] ?? []) yield f;
  const m = sheet.marks ?? {};
  for (const k of SINGLES) if (m[k]) yield m[k];
  for (const k of ["detail", "tooltip"]) for (const f of m[k] ?? []) yield f;
}

/** Refreshes each calc pill's category/role/column/agg from its current compile; returns ids it could not compute. */
export function syncCalcPills(sheet, calcs, catalog) {
  const bad = [];
  const seen = new Map();
  for (const f of pillSlots(sheet)) {
    if (!isCalcPill(f)) continue;
    const calc = (calcs ?? []).find((c) => c.id === f.calc);
    if (!calc) { if (!bad.includes(f.calc)) bad.push(f.calc); continue; }
    if (!seen.has(f.calc)) seen.set(f.calc, compileCalculation(calc, calcs, catalog));
    const c = seen.get(f.calc);
    if (c.error) { if (!bad.includes(f.calc)) bad.push(f.calc); continue; }
    const wasNumber = f.category === "numeric";
    const override = wasNumber && f.role === "dimension" && c.info.type === "number" ? "dimension" : null;
    f.category = CATEGORY[c.info.type] ?? "other";
    f.role = roleOfCalc(c.info, override);
    f.column = calc.name;
    delete f.datePart; // E12: a calculated dimension is never date-grouped
    if (f.role === "measure" && !c.info.isAggregate) f.agg = CALC_AGGS.includes(f.agg) ? f.agg : "sum";
    else delete f.agg;
  }
  return bad;
}

export function usesCalc(sheet, id) {
  for (const f of pillSlots(sheet)) if (isCalcPill(f) && f.calc === id) return true;
  return sortPointsAt(sheet, id) || filtersUseCalc(sheet.filters, id);
}

const topByUses = (f, id) => f?.op === "top" && f.topBy?.calc === id;

/** Whether a (sheet or shared) filter list holds a Top-N ranked by calculation `id`. */
export const filtersUseCalc = (filters, id) => (filters ?? []).some((x) => topByUses(x, id));

/** A Top-N ranked by it keeps its filter but loses the ranking; the filter panel re-applies "first shelf measure". */
export function clearFilterCalc(filters, id) {
  for (const x of filters ?? []) if (topByUses(x, id)) x.topBy = null;
}

const sortPointsAt = (sheet, id) => typeof sheet.sort?.by === "string" && sheet.sort.by.split(":")[1] === "calc" && sheet.sort.by.split(":")[2] === id;

/** Removes every pill for calculation `id` (shelves, marks, colour) and a sort aimed at it. */
export function clearCalcPills(sheet, id) {
  const keep = (f) => !(isCalcPill(f) && f.calc === id);
  for (const k of ["rows", "columns", "color"]) if (Array.isArray(sheet[k])) sheet[k] = sheet[k].filter(keep);
  const m = sheet.marks;
  if (m) {
    for (const k of SINGLES) if (m[k] && !keep(m[k])) m[k] = null;
    for (const k of ["detail", "tooltip"]) if (Array.isArray(m[k])) m[k] = m[k].filter(keep);
  }
  if (sortPointsAt(sheet, id)) sheet.sort = null;
  clearFilterCalc(sheet.filters, id);
}
