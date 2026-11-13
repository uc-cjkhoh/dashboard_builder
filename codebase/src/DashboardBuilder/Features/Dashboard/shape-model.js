// Shape — pure, DOM-free (tests/js/shape-model.test.mjs). Three things live here: the symbol set, a measure on Shape (its values cut into
// equal-width bins, one symbol per bin: `format.shapeBins`), and a member's own symbol (`sheet.memberShapes`, kept like `memberColors`).
import { LIMITS } from "../Core/validate.js";
import { memberKey, bare, has } from "./colour-model.js";

/** [key, name in words, ECharts symbol, glyph path on a 20-unit grid] — the seven symbols a Shape member or bin can wear, in the order they are handed out. */
export const SHAPE_CHOICES = Object.freeze([
  ["circle", "Circle", "circle", "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z"],
  ["square", "Square", "rect", "M4 4h12v12H4z"],
  ["triangle", "Triangle", "triangle", "M10 3.5l7 12.5H3z"],
  ["diamond", "Diamond", "diamond", "M10 2.5l7 7.5-7 7.5L3 10z"],
  ["roundSquare", "Rounded square", "roundRect", "M7 4h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"],
  ["pin", "Pin", "pin", "M10 17.5c-3-3.4-5.5-6-5.5-9a5.5 5.5 0 0 1 11 0c0 3-2.5 5.6-5.5 9z"],
  ["arrow", "Arrow", "arrow", "M10 2.5l6.5 7H12.5v8h-5v-8H3.5z"],
].map((c) => Object.freeze(c)));
export const SHAPE_KEYS = Object.freeze(SHAPE_CHOICES.map((c) => c[0]));
const SYMBOLS = Object.freeze(Object.fromEntries(SHAPE_CHOICES.map((c) => [c[0], c[2]])));
const KEYS = new Set(SHAPE_KEYS);
/** The ECharts symbol of a shape key (a circle for an unknown one). */
export const shapeSymbol = (key) => (KEYS.has(key) ? SYMBOLS[key] : "circle");
/** The ECharts symbol of the symbol at position `i` of the set (it wraps), so a member or bin keeps the same symbol while the data changes. */
export const symbolAt = (i) => SHAPE_CHOICES[((i % SHAPE_CHOICES.length) + SHAPE_CHOICES.length) % SHAPE_CHOICES.length][2];
export const isShapeKey = (k) => typeof k === "string" && KEYS.has(k);

// --- a measure on Shape: equal-width bins ---------------------------------------
// Six bins at most: the seventh symbol is kept for a missing value, so no two groups ever share a symbol.
export const SHAPE_BINS_DEFAULT = 5, SHAPE_BINS_MIN = 2, SHAPE_BINS_MAX = SHAPE_KEYS.length - 1;
const NULL_INDEX = SHAPE_KEYS.length - 1;
const BINS_MESSAGE = `Shape bins must be a whole number from ${SHAPE_BINS_MIN} to ${SHAPE_BINS_MAX}.`;
/** Why a bin count is refused, or null. */
export const shapeBinsError = (n) => (Number.isInteger(n) && n >= SHAPE_BINS_MIN && n <= SHAPE_BINS_MAX ? null : BINS_MESSAGE);
/** The bin count a format asks for (the default when absent or, defensively, invalid). */
export const shapeBinsOf = (format) => (shapeBinsError(format?.shapeBins) === null ? format.shapeBins : SHAPE_BINS_DEFAULT);
/** `format.shapeBins` as a sheet stores it -> { ok, value } (null = the default, nothing to store); for the Format control's change. */
export function cleanShapeBins(n) {
  if (n == null || n === SHAPE_BINS_DEFAULT) return { ok: true, value: null };
  const error = shapeBinsError(n);
  return error ? { ok: false, error } : { ok: true, value: n };
}

const round = (x) => Number(x.toPrecision(12)); // 1 + 1.6 * 3 is 5.800000000000001 in floating point: the bound is what the legend says
/**
 * Cut `values` (one per point, in any order) into `n` equal-width bins over their own span. A value on a boundary belongs to the bin above;
 * the largest value belongs to the last bin; flat data is one bin. A missing / non-numeric value takes the seventh symbol as its own group.
 * -> { binOf: per value, its symbol index; bins: [{ index, name }] only the groups that hold a point, lowest first, the missing group last; nullIndex }.
 * The index is the bin's position, so a bin keeps its symbol as the data changes. `fmt` formats a bound for the legend ("10 to 20").
 */
export function binShapeValues(values, n, fmt) {
  const nums = values.map((v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null));
  const real = nums.filter((v) => v !== null);
  const lo = real.length ? Math.min(...real) : 0, hi = real.length ? Math.max(...real) : 0;
  const count = lo === hi ? 1 : Math.min(SHAPE_BINS_MAX, Math.max(1, n));
  const width = (hi - lo) / count;
  const edges = Array.from({ length: count + 1 }, (_, i) => (i === count ? hi : round(lo + width * i))); // the last edge is the data's own maximum
  const binOf = nums.map((v) => {
    if (v === null) return NULL_INDEX;
    let b = 0;
    while (b < count - 1 && v >= edges[b + 1]) b++;
    return b;
  });
  const used = new Set(binOf);
  const taken = new Set();
  const named = (name, i) => { let out = name; if (taken.has(out)) out = `${name} (bin ${i + 1})`; taken.add(out); return out; };
  const bins = [];
  for (let b = 0; b < count; b++) if (used.has(b)) bins.push({ index: b, name: named(count === 1 ? fmt(lo) : `${fmt(edges[b])} to ${fmt(edges[b + 1])}`, b) });
  if (used.has(NULL_INDEX)) bins.push({ index: NULL_INDEX, name: named("No value", NULL_INDEX) });
  return { binOf, bins, nullIndex: NULL_INDEX };
}

/** `groups` ({ shape: { index } }) lowest symbol first, the missing group last (a stable sort: groups of one bin keep their order). */
export const shapeOrder = (groups) => groups.map((g, i) => [g, i]).sort((a, b) => ((a[0].shape?.index ?? -1) - (b[0].shape?.index ?? -1)) || a[1] - b[1]).map(([g]) => g);

// --- a member's own shape: { [fieldKey]: { [memberKey]: shapeKey } } ------------------
const isPlain = (o) => o && typeof o === "object" && !Array.isArray(o);

/** Set (a shape key) or clear (null) one member's shape: { ok, value } with a new map, or { ok:false, error }. */
export function setMemberShape(map, field, member, shape) {
  const next = bare();
  for (const [f, m] of Object.entries(map ?? {})) next[f] = bare(m);
  if (shape == null) {
    if (next[field]) { delete next[field][member]; if (!Object.keys(next[field]).length) delete next[field]; }
    return { ok: true, value: next };
  }
  if (!isShapeKey(shape)) return { ok: false, error: "Choose one of the listed shapes." };
  if (member === "__proto__") return { ok: false, error: "That member name can't be given a shape." };
  if (field.length > LIMITS.memberField) return { ok: false, error: `The Shape field's name is too long to keep member shapes (at most ${LIMITS.memberField} characters) — they would be lost on reload.` };
  if (member.length > LIMITS.memberKey) return { ok: false, error: `A member name must be at most ${LIMITS.memberKey} characters to be given a shape.` };
  const cur = has(next, field) ? next[field] : bare();
  if (!has(cur, member) && Object.keys(cur).length >= LIMITS.memberColors) return { ok: false, error: `At most ${LIMITS.memberColors} members per field can have a shape.` };
  if (!has(next, field) && Object.keys(next).length >= LIMITS.memberColorFields) return { ok: false, error: `At most ${LIMITS.memberColorFields} fields can have member shapes.` };
  next[field] = bare({ ...cur, [member]: shape });
  return { ok: true, value: next };
}

/** Remove every shape of one field: { ok, value } with a new map. */
export function clearFieldShapes(map, field) {
  const next = bare();
  for (const [f, m] of Object.entries(map ?? {})) if (f !== field) next[f] = bare(m);
  return { ok: true, value: next };
}

/** A saved memberShapes map, checked: bad entries dropped and reported, never coerced. undefined when there is nothing to keep (the key stays off the sheet). */
export function cleanMemberShapes(raw, where, issues) {
  if (raw == null) return undefined;
  if (!isPlain(raw)) { issues.push(`${where}: member shapes weren't an object — cleared.`); return undefined; }
  const out = bare();
  let dropped = 0;
  for (const field of Object.keys(raw)) {
    const members = has(raw, field) ? raw[field] : undefined;
    if (field === "__proto__" || !isPlain(members) || field.length > LIMITS.memberField || Object.keys(out).length >= LIMITS.memberColorFields) { dropped++; continue; }
    const kept = bare();
    for (const [m, shape] of Object.entries(members)) {
      if (m === "__proto__" || !isShapeKey(shape) || m.length > LIMITS.memberKey || Object.keys(kept).length >= LIMITS.memberColors) { dropped++; continue; }
      kept[m] = shape;
    }
    if (Object.keys(kept).length) out[field] = kept;
  }
  if (dropped) issues.push(`${where}: ${dropped} invalid member shape${dropped === 1 ? "" : "s"} dropped.`);
  return Object.keys(out).length ? out : undefined;
}

/** displayed name -> shape key, for the members ({ name, raw }) a view shows that have a saved shape. */
export function shapesByName(fieldMap, members) {
  const out = new Map();
  if (!isPlain(fieldMap)) return out;
  for (const { name, raw } of members ?? []) {
    const k = memberKey(raw);
    if (has(fieldMap, k) && isShapeKey(fieldMap[k])) out.set(name, fieldMap[k]);
  }
  return out;
}
