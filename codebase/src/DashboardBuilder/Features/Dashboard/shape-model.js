// Shape — pure, DOM-free (tests/js/shape-model.test.mjs). Three things live here: the symbol set, a measure on Shape (its values cut into
// equal-width bins, one symbol per bin: `format.shapeBins`), and a member's own symbol (`sheet.memberShapes`, kept like `memberColors`).
import { LIMITS } from "../Core/validate.js";
import { memberKey, bare, has } from "./colour-model.js";

/** [key, name in words, ECharts symbol, glyph path on a 20-unit grid] — the seven symbols a measure's bins wear, in the order they are handed out (the Default palette starts with them). */
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

// --- palettes (Tableau's Edit Shape: Select Shape Palette) ----------------------------------------------------------
// A glyph is a path on the 20-unit grid; the chart draws a shape that ECharts has no name for as `path://<glyph>` (it fits the path to the mark's box).
const f2 = (x) => String(Math.round(x * 100) / 100);
const poly = (pts) => `M${pts.map(([x, y]) => `${f2(x)} ${f2(y)}`).join("L")}z`;
const rotate = (pts, deg, [cx, cy] = [10, 10]) => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]); };
const ngon = (n, r, start = -90, [cx, cy] = [10, 10]) => Array.from({ length: n }, (_, i) => { const t = ((start + (360 / n) * i) * Math.PI) / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; });
const starPts = (n, ro, ri) => Array.from({ length: n * 2 }, (_, i) => { const t = ((-90 + (180 / n) * i) * Math.PI) / 180, r = i % 2 ? ri : ro; return [10 + r * Math.cos(t), 10 + r * Math.sin(t)]; });
/** A hollow shape: the outline, and the same outline pulled in toward its centre and wound the other way, which the fill leaves empty. */
const ring = (pts, k = 0.56) => `${poly(pts)}${poly(pts.map(([x, y]) => [10 + (x - 10) * k, 10 + (y - 10) * k]).reverse())}`;
const bar = (w, h, deg) => rotate([[10 - w / 2, 10 - h / 2], [10 + w / 2, 10 - h / 2], [10 + w / 2, 10 + h / 2], [10 - w / 2, 10 + h / 2]], deg);
const PLUS = [[8, 3], [12, 3], [12, 8], [17, 8], [17, 12], [12, 12], [12, 17], [8, 17], [8, 12], [3, 12], [3, 8], [8, 8]];
const ARROW_UP = [[10, 2.5], [16.5, 9.5], [12.5, 9.5], [12.5, 17.5], [7.5, 17.5], [7.5, 9.5], [3.5, 9.5]];
const DIRECTIONS = [["n", "up", 0], ["ne", "up-right", 45], ["e", "right", 90], ["se", "down-right", 135], ["s", "down", 180], ["sw", "down-left", 225], ["w", "left", 270], ["nw", "up-left", 315]];
const shape = (key, name, glyph) => Object.freeze([key, name, `path://${glyph}`, glyph]);

/** { key, name, shapes: [[key, name, ECharts symbol, glyph]] } — Default (ten shapes: the seven above, then a plus, a cross and a star), Outline, Arrows and Weather. Shape keys are unique across palettes, so a member stores its key alone. */
export const SHAPE_PALETTES = Object.freeze([
  { key: "default", name: "Default", shapes: [...SHAPE_CHOICES, shape("plus", "Plus", poly(PLUS)), shape("cross", "Cross", poly(rotate(PLUS, 45))), shape("star", "Star", poly(starPts(5, 8, 3.4)))] },
  { key: "outline", name: "Outline", shapes: [
    shape("o-circle", "Circle outline", "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM10 6.9a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2z"),
    shape("o-square", "Square outline", ring([[4, 4], [16, 4], [16, 16], [4, 16]])),
    shape("o-triangle", "Triangle outline", ring([[10, 3.5], [17, 16], [3, 16]], 0.5)),
    shape("o-diamond", "Diamond outline", ring([[10, 2.5], [17, 10], [10, 17.5], [3, 10]])),
    shape("o-pentagon", "Pentagon outline", ring(ngon(5, 7.5))),
    shape("o-hexagon", "Hexagon outline", ring(ngon(6, 7.5, 0))),
    shape("o-star", "Star outline", ring(starPts(5, 8, 3.4), 0.5)),
  ] },
  { key: "arrows", name: "Arrows", shapes: DIRECTIONS.map(([d, name, deg]) => shape(`arrow-${d}`, `Arrow ${name}`, poly(rotate(ARROW_UP, deg)))) },
  { key: "weather", name: "Weather", shapes: [
    shape("sun", "Sun", poly(starPts(8, 8.2, 5))),
    shape("cloud", "Cloud", "M6 15.5a3.5 3.5 0 0 1-.3-7 4.5 4.5 0 0 1 8.6-1.2 3.8 3.8 0 0 1-.3 8.2z"),
    shape("moon", "Moon", "M13.5 3.5A7 7 0 1 0 16.5 12 5.5 5.5 0 0 1 13.5 3.5z"),
    shape("snowflake", "Snowflake", [bar(1.8, 15, 0), bar(1.8, 15, 60), bar(1.8, 15, 120)].map(poly).join("")),
    shape("bolt", "Lightning", "M11.5 2L4.5 11h4.5l-1 7 7-9.5h-4.5z"),
    shape("drop", "Raindrop", "M10 2.5C7 6.5 4.5 9.2 4.5 12a5.5 5.5 0 0 0 11 0c0-2.8-2.5-5.5-5.5-9.5z"),
  ] },
].map((p) => Object.freeze({ ...p, shapes: Object.freeze(p.shapes) })));
export const SHAPE_PALETTE_DEFAULT = SHAPE_PALETTES[0];
const ALL = new Map(SHAPE_PALETTES.flatMap((p) => p.shapes).map((c) => [c[0], c]));
/** The shape ([key, name, symbol, glyph]) of a key, or undefined. */
export const shapeOf = (key) => ALL.get(key);
/** The default shape at position `i` of the Default palette (it wraps): what a member or bin wears until it is given one. */
export const defaultShapeAt = (i) => { const n = SHAPE_PALETTE_DEFAULT.shapes.length; return SHAPE_PALETTE_DEFAULT.shapes[((i % n) + n) % n]; };
/** The ECharts symbol of a shape key (a circle for an unknown one). */
export const shapeSymbol = (key) => ALL.get(key)?.[2] ?? "circle";
/** The ECharts symbol of the symbol at position `i` of the Default palette (it wraps), so a member or bin keeps the same symbol while the data changes. */
export const symbolAt = (i) => defaultShapeAt(i)[2];
/** The symbol at position `i` of the first seven (it wraps): the symbols of a measure's bins and of a scatter's groups that have no Shape of their own, which the ten-shape Default palette (D172) does not change. */
export const baseSymbolAt = (i) => SHAPE_CHOICES[((i % SHAPE_CHOICES.length) + SHAPE_CHOICES.length) % SHAPE_CHOICES.length][2];
export const isShapeKey = (k) => typeof k === "string" && ALL.has(k);

/** Assign Palette: the palette's shapes handed to `members` (memberKeys) in order, repeating from the first when the members outnumber the shapes -> { [memberKey]: shapeKey }. */
export function assignPalette(palette, members) {
  const shapes = palette?.shapes ?? [];
  const out = bare();
  if (shapes.length) members.forEach((m, i) => { if (m !== "__proto__") out[m] = shapes[i % shapes.length][0]; });
  return out;
}

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

const round = (x) => Number(x.toPrecision(15)); // 1 + 1.6 * 3 is 5.800000000000001 in floating point: the bound is what the legend says (15 digits keep an epoch in milliseconds exact)
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
  const width = hi / count - lo / count; // not (hi - lo) / count: a span of about 2e308 overflows to Infinity
  const edges = Array.from({ length: count + 1 }, (_, i) => (i === 0 ? lo : i === count ? hi : round(lo + width * i))); // the first and last edges are the data's own minimum and maximum
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

/** Replace one field's member shapes with `entries` ({ [memberKey]: shapeKey }; empty = none) -> { ok, value } with a new map, or { ok:false, error } at the first entry a limit or a bad key refuses. */
export function setFieldShapes(map, field, entries) {
  let cur = { ok: true, value: clearFieldShapes(map, field).value };
  for (const [m, shape] of Object.entries(entries ?? {})) { cur = setMemberShape(cur.value, field, m, shape); if (!cur.ok) return cur; }
  return cur;
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
