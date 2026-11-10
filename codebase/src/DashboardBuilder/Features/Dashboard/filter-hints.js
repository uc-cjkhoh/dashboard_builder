// Pure hints around filters (no DOM): the default operator, "did you mean" for a case-only miss, filters that
// exclude each other, the empty-result message and the Keep only / Exclude label for the Filters tile.
// Unit-tested in tests/js/filter-hints.test.mjs.
import { checkFilter } from "./filter-rules.js";
import { resolveRange } from "./period-model.js";

/** A new filter on a text dimension starts as an `in` value list (the bounded distinct-values picker); any other field as `=`. */
export const defaultOpFor = (category) => (category === "text" ? "in" : "=");
export function newFilter(f) {
  const op = defaultOpFor(f.category);
  return { db: f.db, table: f.table, column: f.column, category: f.category, op, ...(op === "in" ? { values: [] } : { value: "" }) };
}

/** The member a typed `=` value matches only by case ("shipped" → "Shipped"), or null (exact match, no near member, nothing typed). */
export function caseMiss(value, members) {
  const v = String(value ?? "").trim();
  if (!v || !Array.isArray(members)) return null;
  const list = members.filter((m) => m != null).map(String);
  if (list.includes(v) || list.includes(String(value))) return null;
  return list.find((m) => m.toLowerCase() === v.toLowerCase()) ?? null;
}
export const caseMissText = (value, member) => `No member '${String(value).trim()}' — did you mean '${member}'?`;

// What a simple filter allows: { inc: Set } (= / in) or { exc: Set } (not in). null = not a simple, applied filter.
// A value as a comparable key: numbers by value (1 = 1.0), dates by instant (a bare day = its midnight), booleans as true / false.
function norm(category, v) {
  const t = String(v ?? "").trim();
  if (category === "numeric") return Number.isFinite(Number(t)) && t !== "" ? String(Number(t)) : t;
  if (category === "temporal") {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(t);
    return m ? `${m[1]} ${m[2] ?? "00:00"}:${m[3] ?? "00"}` : t;
  }
  if (category === "boolean") return t === "1" ? "true" : t === "0" ? "false" : t.toLowerCase();
  return t;
}
function allowance(f) {
  if (f.param || typeof f.calc === "string" || checkFilter(f).state !== "ok") return null;
  const n = (v) => norm(f.category, v);
  if (f.op === "=") return { inc: new Set([n(f.value)]) };
  if (f.op === "in") return { inc: new Set(f.values.map(n)) };
  if (f.op === "notin") return { exc: new Set(f.values.map(n)) };
  return null;
}
const disjoint = (a, b) => ![...a].some((v) => b.has(v));
const subset = (a, b) => [...a].every((v) => b.has(v));
const clash = (x, y) => (x.inc && y.inc ? disjoint(x.inc, y.inc) : x.inc && y.exc ? subset(x.inc, y.exc) : x.exc && y.inc ? subset(y.inc, x.exc) : false);

/** Fields with two simple filters (=, in, not in) that cannot both be true: [{ column: "table.column", indexes: [i, j] }]. */
export function conflicts(filters) {
  const byField = new Map(), out = [];
  filters.forEach((f, i) => {
    const a = allowance(f);
    if (!a) return;
    const key = `${f.db}\u0000${f.table}\u0000${f.column}`;
    const seen = byField.get(key) ?? [];
    byField.set(key, seen);
    if (!out.some((c) => c.key === key)) {
      const other = seen.find((s) => clash(s.a, a));
      if (other) out.push({ key, column: `${f.table}.${f.column}`, indexes: [other.i, i] });
    }
    seen.push({ a, i });
  });
  return out.map(({ column, indexes }) => ({ column, indexes }));
}
const sentence = (c) => `These two filters on ${c.column} exclude each other.`;
/** One line for the notice under the view, or null. */
export function conflictNotice(filters) {
  const list = conflicts(filters);
  return list.length ? list.map(sentence).join(" ") : null;
}
/** The warning for the filter at `index` (pill tooltip), or null. */
export function conflictFor(filters, index) {
  const c = conflicts(filters).find((x) => x.indexes.includes(index));
  return c ? sentence(c) : null;
}

/** The text for an empty result: filters, a date range, pages, a drill or a kept selection removed the rows, or the fields hold none. */
export function emptyMessage(sheet, { shared = 0 } = {}) {
  const limited = shared > 0 || (sheet.filters ?? []).some((f) => checkFilter(f).state === "ok") || (sheet.period && resolveRange(sheet.period)) || sheet.pages
    || (sheet.drill?.levels?.length ?? 0) > 0 || Boolean(sheet.selection?.action);
  return limited ? "No rows match the filters." : "No data for these fields.";
}

/** "Keep only Malaysia" / "Exclude Malaysia" for an active selection (a plain highlight is not a filter: null). */
export function selectionLabel(sel) {
  return sel?.action === "keep" ? `Keep only ${sel.label}` : sel?.action === "exclude" ? `Exclude ${sel.label}` : null;
}
