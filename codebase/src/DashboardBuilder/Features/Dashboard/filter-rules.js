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
