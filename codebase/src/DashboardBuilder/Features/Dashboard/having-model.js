// Dashboard/having-model.js — the filter on an aggregated measure (SQL HAVING), pure and DOM-free (tests/js/having-model.test.mjs).
// A measure pill stores `having = { op, value }` or `{ op: "between", values: [from, to] }`: a number compared with the measure's value
// in each group, AFTER grouping. Mirrors ClickHouse/RequestValidation.cs (HavingOps, ValidateHaving, ApiLimits.MaxHaving).
import { LIMITS, number } from "../Core/validate.js";

/** [wire operator, the words the sentence uses] — the server's whitelist, in menu order. */
export const HAVING_OPS = Object.freeze([
  ["=", "equals"], ["!=", "is not"], [">", "is greater than"], [">=", "is at least"], ["<", "is less than"], ["<=", "is at most"], ["between", "is between"],
]);
const WORDS = new Map(HAVING_OPS);
const SYMBOLS = { "=": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤" };
const blank = (v) => v == null || !String(v).trim();

/** { state: "empty" | "ok" | "invalid", error? } for a stored measure filter. Never clamps: a bad number is invalid. */
export function checkHaving(h) {
  if (!h || typeof h !== "object") return { state: "empty" };
  if (!WORDS.has(h.op)) return { state: "invalid", error: "A measure filter is =, !=, >, >=, <, <= or between." };
  if (h.op === "between") {
    const [lo, hi] = Array.isArray(h.values) ? h.values : [];
    if (blank(lo) && blank(hi)) return { state: "empty" };
    if (blank(lo) || blank(hi)) return { state: "invalid", error: "Enter both From and To." };
    const a = number(lo), b = number(hi);
    if (!a.ok) return { state: "invalid", error: a.error };
    if (!b.ok) return { state: "invalid", error: b.error };
    return a.value > b.value ? { state: "invalid", error: "From must be less than or equal to To." } : { state: "ok" };
  }
  if (blank(h.value)) return { state: "empty" };
  const r = number(h.value);
  return r.ok ? { state: "ok" } : { state: "invalid", error: r.error };
}

/** A stored filter reduced to its own keys, or null when it isn't a valid one (workbook import: bad data is dropped, never kept). */
export function cleanHaving(h) {
  if (checkHaving(h).state !== "ok") return null;
  return h.op === "between" ? { op: "between", values: h.values.map((v) => String(v).trim()) } : { op: h.op, value: String(h.value).trim() };
}

/** The wire `having` list for a plan's measures (planMeasures entries): shelf measures only, by their position in the query. */
export function havingPlan(measures) {
  const out = [];
  measures.forEach((e, i) => {
    if (e.role !== "shelf" || checkHaving(e.field?.having).state !== "ok") return;
    const c = cleanHaving(e.field.having);
    if (out.length < LIMITS.having) out.push({ measure: i, ...c });
  });
  return out;
}

const operand = (h) => (h.op === "between" ? `${String(h.values[0]).trim()} and ${String(h.values[1]).trim()}` : String(h.value).trim());
/** "sum Sales is at least 1000". */
export const havingSentence = (label, h) => `${label} ${WORDS.get(h.op)} ${operand(h)}`;

/** The short text on the pill: "≥ 1000", "1 – 5" ("" when none). */
export function havingBadge(h) {
  if (checkHaving(h).state !== "ok") return "";
  return h.op === "between" ? `${String(h.values[0]).trim()} – ${String(h.values[1]).trim()}` : `${SYMBOLS[h.op]} ${String(h.value).trim()}`;
}

/** The line under the view: the filter in words, and the grain it applies at. `entries` = [{ label, having }] for the shelf measures;
 *  `grain` = the group-by field names. null when no measure carries a filter. */
export function havingNotice(entries, grain) {
  const set = entries.filter((e) => checkHaving(e.having).state !== "empty" && e.having);
  if (!set.length) return null;
  const bad = set.filter((e) => checkHaving(e.having).state === "invalid");
  const good = set.filter((e) => checkHaving(e.having).state === "ok");
  const parts = [];
  if (good.length) {
    const cond = good.map((e) => havingSentence(e.label, e.having)).join(" and ");
    if (!grain.length) parts.push(`Showing only the total when ${cond}.`);
    else parts.push(`Showing only groups where ${cond}, per ${grain.length > 1 ? `${grain.slice(0, -1).join(", ")} and ${grain.at(-1)}` : grain[0]}.`);
  }
  if (bad.length) parts.push(`${bad.length} measure filter${bad.length === 1 ? "" : "s"} not applied — fix the highlighted value.`);
  return parts.join(" ");
}

// ---- the range slider (a "between" filter drawn over the measure's span) ----
/** { min, max } of measure column `index` over the result rows, widened by the span seen before (`prev`) and by a stored
 *  "between" filter, so narrowing never shrinks the track. null when no finite number is known. */
export function sliderBounds(rows, index, prev, h) {
  const xs = [];
  for (const r of rows ?? []) { const v = r?.values?.[index]; if (typeof v === "number" && Number.isFinite(v)) xs.push(v); }
  if (prev) xs.push(prev.min, prev.max);
  if (h?.op === "between" && checkHaving(h).state === "ok") xs.push(Number(h.values[0]), Number(h.values[1]));
  if (!xs.length) return null;
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

/** The slider step: 1 when both ends are whole numbers and the span is at least 10, else the power of ten at or below 1/100 of the span. */
export function sliderStep({ min, max }) {
  const span = max - min;
  if (Number.isInteger(min) && Number.isInteger(max) && span >= 10) return 1;
  return span > 0 ? 10 ** Math.floor(Math.log10(span / 100)) : 1;
}

/** [from, to] for the two thumbs: the stored filter when it is a valid "between" inside the bounds, else the whole span. */
export function sliderValues(b, h) {
  if (h?.op === "between" && checkHaving(h).state === "ok") {
    const lo = Number(h.values[0]), hi = Number(h.values[1]);
    if (lo >= b.min && hi <= b.max) return [lo, hi];
  }
  return [b.min, b.max];
}
