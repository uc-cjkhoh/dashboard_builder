// Pure worksheet rules (no DOM): aggregations per field, filter usability, stat-chart filter mapping.
import { filterValue, range, LIMITS } from "../Core/validate.js";
import { PERIOD_PRESETS } from "../Core/sheet-schema.js";
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

// P30 richer filters. Text match (bound, case-insensitive), relative date (a period preset, resolved to a
// `between` in the browser) and top-N by a measure (a bound subquery on the server).
export const TEXT_OPS = new Set(["contains", "startsWith", "endsWith"]);
export const OP_LABELS = { contains: "contains", startsWith: "starts with", endsWith: "ends with", relative: "in the", top: "top" };
/** The operators that make sense for a field's category. */
export function opsFor(category) {
  const base = ["=", "!=", ">", ">=", "<", "<=", "in", "between"];
  if (category === "text") return [...base, "contains", "startsWith", "endsWith", "top"];
  if (category === "temporal") return [...base, "relative", "top"];
  if (category === "numeric") return base;
  return [...base, "top"];
}
const isWhole = (v, lo, hi) => /^\d+$/.test(String(v ?? "").trim()) && Number(v) >= lo && Number(v) <= hi;

export function checkFilter(f) {
  const col = `${f.table}.${f.column}`;
  if (TEXT_OPS.has(f.op)) {
    if (f.category && f.category !== "text") return { state: "invalid", error: `Text matching needs a text field — ${col} isn't one.` };
    if (blank(f.value)) return { state: "empty" };
    return String(f.value).length > LIMITS.filterValue
      ? { state: "invalid", error: `A filter value must be at most ${LIMITS.filterValue} characters.` } : { state: "ok" };
  }
  if (f.op === "relative") {
    if (f.category && f.category !== "temporal") return { state: "invalid", error: `A relative date needs a date field — ${col} isn't one.` };
    if (blank(f.value)) return { state: "empty" };
    return PERIOD_PRESETS.has(f.value) && f.value !== "custom" ? { state: "ok" } : { state: "invalid", error: "Pick a date range." };
  }
  if (f.op === "top") {
    if (blank(f.value)) return { state: "empty" };
    if (!isWhole(f.value, 1, 1000)) return { state: "invalid", error: "Top-N must be a whole number from 1 to 1000." };
    if (!f.topBy?.column) return { state: "invalid", error: "Pick a measure to rank by." };
    return { state: "ok" };
  }
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
/**
 * What the server receives for a filter: relative dates become a bound `between` over whole days
 * (`resolve(preset)` → { from, to }; a Date column takes days, a DateTime the first / last second), top-N
 * carries its ranking measure (`wireTopBy` turns a calculated one into its tree); everything else as is.
 */
export function serverFilter(f, { resolve, dateOnly, wireTopBy } = {}) {
  const base = { db: f.db, table: f.table, column: f.column, op: f.op, value: f.value ?? "", values: f.values ?? null };
  if (f.op === "relative") {
    const r = resolve ? resolve(f.value) : null;
    if (!r) return null;
    return { ...base, op: "between", value: "", values: dateOnly ? [r.from, r.to] : [`${r.from} 00:00:00`, `${r.to} 23:59:59`] };
  }
  if (f.op === "top") return { ...base, value: String(f.value).trim(), topBy: wireTopBy ? wireTopBy(f.topBy) : { db: f.topBy.db, table: f.topBy.table, column: f.topBy.column, agg: f.topBy.agg ?? "sum" }, bottom: Boolean(f.bottom) };
  return base;
}
export function statFilters(filters, db, table, convert = (f) => serverFilter(f)) {
  // Top-N needs the worksheet query; it doesn't apply to a histogram / box plot (counted as ignored).
  const usable = filters.filter((f) => checkFilter(f).state === "ok");
  const mine = usable.filter((f) => f.db === db && f.table === table && f.op !== "top").map(convert).filter(Boolean);
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

// --- shelf / view caps (pure) -------------------------------------------------
const roleOfField = (f) => f.role ?? (f.category === "numeric" ? "measure" : "dimension");
const SHELF_SLOTS = new Set(["columns", "rows", "color", "detail", "tooltip"]);
/** Dimensions and measures a view would send to the server (a conservative count, whatever the chart type). */
export function viewCounts(sheet) {
  const m = sheet.marks ?? {};
  const numeric = (f) => Boolean(f) && f.category === "numeric";
  const shelf = [...(sheet.columns ?? []), ...(sheet.rows ?? [])];
  const cf = (sheet.color ?? [])[0];
  let dims = shelf.filter((f) => roleOfField(f) === "dimension").length + (m.detail ?? []).length;
  if (m.shape) dims++;
  if (cf && !numeric(cf)) dims++;
  if (sheet.drill) dims++;
  let measures = shelf.filter((f) => roleOfField(f) === "measure").length;
  if (numeric(m.size)) measures++;
  if (numeric(cf)) measures++;
  for (const f of [m.label, m.path, ...(m.tooltip ?? [])]) if (numeric(f)) measures++;
  return { dims, measures };
}
/** May `field` go into `slot` ("columns"|"rows"|"color"|"detail"|"tooltip"|"size"|"label"|"path"|"shape")?
 *  Returns { ok: true } or { ok: false, error } — a full sentence naming the cap. */
export function checkAdd(sheet, slot, field, role) {
  const marks = { ...(sheet.marks ?? {}) };
  const next = { ...sheet, marks };
  const entry = { ...field, ...(role ? { role } : {}) };
  if (slot === "columns" || slot === "rows") {
    if ((sheet[slot] ?? []).length >= LIMITS.pillsPerShelf)
      return { ok: false, error: `The ${slot === "columns" ? "Columns" : "Rows"} shelf can hold at most ${LIMITS.pillsPerShelf} fields.` };
    next[slot] = [...sheet[slot], entry];
  } else if (slot === "detail" || slot === "tooltip") {
    if ((marks[slot] ?? []).length >= LIMITS.pillsPerShelf)
      return { ok: false, error: `The ${slot === "detail" ? "Detail" : "Tooltip"} shelf can hold at most ${LIMITS.pillsPerShelf} fields.` };
    marks[slot] = [...(marks[slot] ?? []), entry];
  } else if (slot === "color") next.color = [entry];
  else if (slot === "size" || slot === "label" || slot === "path" || slot === "shape") marks[slot] = entry;
  const before = viewCounts(sheet), after = viewCounts(next);
  if (after.dims > LIMITS.dimensions && after.dims > before.dims)
    return { ok: false, error: `A view can group by at most ${LIMITS.dimensions} fields.` };
  if (after.measures > LIMITS.measures && after.measures > before.measures)
    return { ok: false, error: `A view can show at most ${LIMITS.measures} measures.` };
  return { ok: true };
}
