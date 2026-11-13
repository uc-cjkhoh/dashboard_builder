// How a Size field becomes the size of each mark — pure, DOM-free (tests/js/size-scale.test.mjs).
//   * a measure: each value's 0..1 share of the data's span ("span", the default of bars, lines and tiles) or of a span that starts
//     at zero ("zero", the default of a point chart's bubbles);
//   * a dimension: each member is a step, ordered by member order (numbers by value, text by locale, no member last), spread evenly.
// Format → Edit Sizes (`format.sizeScale`) then reverses the shares and keeps them inside a smallest..largest percentage of the
// chart's own size range. With nothing stored every function here returns what the chart drew before the setting existed.
import { tupleKey } from "./grid-model.js";

/** Chart types Format → Edit Sizes applies to (a treemap's tile area IS the value, so it takes no range). */
export const SIZE_SCALE_TYPES = new Set(["scatter", "square", "circle", "bar", "line", "area", "table", "text"]);
/** Types whose bubbles start at zero unless the setting says otherwise. */
export const ZERO_BASED_TYPES = new Set(["scatter", "square", "circle"]);
/** The range Edit Sizes accepts, in whole percent of the chart's own size range. */
export const SIZE_PCT = Object.freeze({ min: 0, max: 100 });

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pct = (v) => Number.isInteger(v) && v >= SIZE_PCT.min && v <= SIZE_PCT.max;
const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));

/** The setting as the drawing reads it: { smallest, largest, fromZero (null = the chart's default), reversed }. Never throws; defensive about a bad stored value. */
export function sizeScaleOf(format) {
  const s = isObj(format?.sizeScale) ? format.sizeScale : {};
  const smallest = pct(s.smallest) ? s.smallest : SIZE_PCT.min;
  const largest = pct(s.largest) ? s.largest : SIZE_PCT.max;
  return smallest < largest
    ? { smallest, largest, fromZero: typeof s.fromZero === "boolean" ? s.fromZero : null, reversed: s.reversed === true }
    : { smallest: SIZE_PCT.min, largest: SIZE_PCT.max, fromZero: typeof s.fromZero === "boolean" ? s.fromZero : null, reversed: s.reversed === true };
}
/** Does the stored setting change anything? */
export const sizeScaleIsDefault = (format) => { const s = sizeScaleOf(format); return s.smallest === 0 && s.largest === 100 && s.fromZero === null && !s.reversed; };

/** Why a smallest / largest pair is refused (whole percent 0–100, smallest below largest), or null. */
export function sizeRangeError(smallest, largest) {
  if (!pct(smallest) || !pct(largest)) return `Sizes are whole percentages from ${SIZE_PCT.min} to ${SIZE_PCT.max}.`;
  return smallest < largest ? null : "The smallest size must be below the largest.";
}

/**
 * A saved `sizeScale` cleaned for import -> { value, issues }. `value` holds only what differs from the default (so a sheet without
 * the setting round-trips unchanged) or is null; a bad part is dropped (never clamped) and reported in `issues`.
 */
export function cleanSizeScale(raw) {
  const issues = [];
  if (raw === undefined || raw === null) return { value: null, issues };
  if (!isObj(raw)) return { value: null, issues: ["sizes weren't an object — reset to Auto."] };
  let smallest = SIZE_PCT.min, largest = SIZE_PCT.max;
  const out = {};
  for (const k of ["smallest", "largest"]) {
    if (raw[k] === undefined) continue;
    if (!pct(raw[k])) issues.push(`the ${k} size "${raw[k]}" — reset to ${k === "smallest" ? SIZE_PCT.min : SIZE_PCT.max} %.`);
    else if (k === "smallest") smallest = raw[k]; else largest = raw[k];
  }
  if (smallest >= largest) { issues.push("the smallest size was not below the largest — both reset."); smallest = SIZE_PCT.min; largest = SIZE_PCT.max; }
  if (smallest !== SIZE_PCT.min) out.smallest = smallest;
  if (largest !== SIZE_PCT.max) out.largest = largest;
  for (const k of ["fromZero", "reversed"]) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "boolean") issues.push(`${k === "fromZero" ? "from zero" : "reversed"} must be on or off — reset.`);
    else if (k === "fromZero" || raw[k]) out[k] = raw[k];
  }
  for (const k of Object.keys(raw)) if (!["smallest", "largest", "fromZero", "reversed"].includes(k)) issues.push(`the size setting "${k}" is unknown — dropped.`);
  return { value: Object.keys(out).length ? out : null, issues };
}

/** One share through Edit Sizes: reversed, then kept inside smallest..largest. `degenerate` (all values equal / one member) is never reversed. */
function applyScale(f, scale, degenerate) {
  if (f == null) return null;
  const g = scale.reversed && !degenerate ? 1 - f : f;
  const lo = scale.smallest / 100, hi = scale.largest / 100;
  return lo === 0 && hi === 1 ? g : lo + g * (hi - lo);
}

/**
 * A measure's share function: value -> 0..1 (null for a non-number). `zero` = whether the span starts at zero for this chart (the
 * setting, else the chart's default). From zero the span runs from min(0, smallest value) to max(1, largest) — a point chart's
 * long-standing rule; otherwise from the data's smallest to largest value (all equal = full size).
 */
export function measureShareFn(values, { zero = false, scale = sizeScaleOf({}) } = {}) {
  const nums = (values ?? []).filter(finite).map(Number);
  if (!zero && !nums.length) return () => null;
  const lo = zero ? Math.min(...nums, 0) : Math.min(...nums), hi = zero ? Math.max(...nums, 1) : Math.max(...nums);
  const degenerate = !zero && lo === hi, span = (hi - lo) || 1;
  return (v) => (finite(v) ? applyScale(degenerate ? 1 : (Number(v) - lo) / span, scale, degenerate) : null);
}
/** A measure's per-mark shares (0..1, null stays null): measureShareFn over the list. */
export const measureShares = (values, opts) => { const f = measureShareFn(values, opts); return (values ?? []).map(f); };

/** The member order of a Size dimension: distinct raw keys, numbers by value, text by locale, no member last. -> [{ raw, key }] */
export function memberOrder(rawKeys) {
  const seen = new Map();
  for (const raw of rawKeys) { const key = tupleKey([raw]); if (!seen.has(key)) seen.set(key, { raw, key }); }
  const cmp = (a, b) => {
    if (a.raw == null || b.raw == null) return (a.raw == null) - (b.raw == null);
    const na = Number(a.raw), nb = Number(b.raw);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a.raw).localeCompare(String(b.raw));
  };
  return [...seen.values()].sort(cmp);
}

/** A member step's share function: rank -> 0..1 for `count` members spread evenly from smallest (0) to largest (1); one member = full size. */
export const memberShareFn = (count, scale = sizeScaleOf({})) => (r) => (r == null ? null : applyScale(count <= 1 ? 1 : r / (count - 1), scale, count <= 1));
/** The shares of a list of ranks. */
export const memberShares = (ranks, count, scale) => ranks.map(memberShareFn(count, scale));

/**
 * The Size dimension's per-row steps for rows with raw keys `rawKeys` (null entries = a row that takes no size, e.g. Other):
 * -> { ranks: number|null[] aligned with rawKeys, order: [{ raw, key }] smallest member first }.
 */
export function memberRanks(rawKeys) {
  const order = memberOrder(rawKeys.filter((_, i) => rawKeys[i] !== undefined));
  const at = new Map(order.map((m, i) => [m.key, i]));
  return { ranks: rawKeys.map((k) => (k === undefined ? null : at.get(tupleKey([k])))), order };
}

/** The Size legend's words: "Size: sum qty (3 to 41)", or for members "Size: region (APAC to US, 6 steps)"; a reversed scale says so. */
export function sizeLegendText(name, { range, members, reversed = false, fmtVal = String }) {
  if (members) {
    const n = members.length;
    const body = n === 1 ? members[0] : `${members[0]} to ${members[n - 1]}, ${n} steps`;
    return `Size: ${name} (${body}${reversed ? ", reversed" : ""})`;
  }
  return `Size: ${name} (${fmtVal(range.min)} to ${fmtVal(range.max)}${reversed ? ", reversed" : ""})`;
}

/** A line's own thickness in px for a 0..1 share (null = the thinnest). */
export const LINE_WIDTH = Object.freeze([2, 12]);
export const lineWidthFor = (share) => Math.round(LINE_WIDTH[0] + (share ?? 0) * (LINE_WIDTH[1] - LINE_WIDTH[0]));

/** Text steps for a Table / Text cell: the type scale's body, lead and title sizes (design rule 5), by thirds of the share. */
export const TEXT_STEPS = Object.freeze(["body", "lead", "title"]);
export const textStepFor = (share) => (share == null || share < 1 / 3 ? 0 : share < 2 / 3 ? 1 : 2);
