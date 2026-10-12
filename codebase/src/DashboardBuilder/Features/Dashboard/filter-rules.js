// Pure worksheet rules (no DOM): aggregations per field, filter usability, stat-chart filter mapping.
import { filterValue, range, LIMITS } from "../Core/validate.js";
export const AGGS = Object.freeze({
  numeric: ["sum", "avg", "min", "max", "count", "countDistinct"],
  ordered: ["count", "countDistinct", "min", "max"], // text + temporal: min/max come back as text
  other: ["count", "countDistinct"],                  // boolean, compound, other
});
export const aggsFor = (category) =>
  category === "numeric" ? AGGS.numeric : category === "text" || category === "temporal" ? AGGS.ordered : AGGS.other;
// Chart types that can show a text measure value (min/max of a text or date field).
export const TEXT_VALUE_TYPES = new Set(["table", "text", "kpi"]);
const blank = (v) => v == null || !String(v).trim();
export function checkFilter(f) {
  const col = `${f.table}.${f.column}`;
  if (f.op === "in") {
    const vals = Array.isArray(f.values) ? f.values : [];
    if (!vals.length) return { state: "empty" };
    return vals.length > LIMITS.inValues
      ? { state: "invalid", error: `An 'in' filter can list at most ${LIMITS.inValues} values.` } : { state: "ok" };
  }
  if (f.op === "between") {
    const [lo, hi] = Array.isArray(f.values) ? f.values : [];
    if (blank(lo) && blank(hi)) return { state: "empty" };
    if (blank(lo) || blank(hi)) return { state: "invalid", error: `Enter both From and To for ${col}.` };
    const r = range(f.category, lo, hi, col);
    return r.ok ? { state: "ok" } : { state: "invalid", error: r.error };
  }
  if (blank(f.value)) return { state: "empty" };
  const r = filterValue(f.category, f.value, col);
  return r.ok ? { state: "ok" } : { state: "invalid", error: r.error };
}
export function statFilters(filters, db, table) {
  const usable = filters.filter((f) => checkFilter(f).state === "ok");
  const mine = usable.filter((f) => f.db === db && f.table === table);
  return {
    apply: mine.map((f) => ({ column: f.column, op: f.op, value: f.value ?? "", values: f.values ?? null })),
    ignored: usable.length - mine.length,
  };
}
// Fill a missing `category` on filters (saved workbooks and older drops carry none) from the column
// catalog. Mutates and returns the filters so the filled category is persisted. A column absent from
// the catalog stays category-less and so reads as invalid (visible), never silently dropped.
export function withCategories(filters, categoryOf) {
  for (const f of filters) if (!f.category) { const c = categoryOf(f.db, f.table, f.column); if (c) f.category = c; }
  return filters;
}
