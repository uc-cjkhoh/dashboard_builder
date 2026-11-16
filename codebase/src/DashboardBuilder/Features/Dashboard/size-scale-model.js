// How a Size field becomes the size of each mark — pure, DOM-free (tests/js/size-scale.test.mjs).
//   * a measure: each value's 0..1 share of the data's span ("span", the default of bars, lines and tiles) or of a span that starts
//     at zero ("zero", the default of a point chart's bubbles);
//   * a dimension: each member is a step, ordered by member order (numbers by value, text by locale, no member last), spread evenly.
// Format → Edit Sizes (`format.sizeScale`) then reverses the shares and keeps them inside a smallest..largest percentage of the
// chart's own size range. A measure's span can also be set: Sizes vary (Automatic = the chart's own default, By range, From zero) and a typed
// Start / End value (a value beyond one saturates at the end mark size, never hidden). With nothing stored every function here returns what the
// chart drew before the setting existed.
import { tupleKey } from "./grid-model.js";

/** Chart types Format → Edit Sizes applies to (a treemap's tile area IS the value, so it takes no range). */
export const SIZE_SCALE_TYPES = new Set(["scatter", "square", "circle", "bar", "line", "area", "table", "text"]);
/** Types whose bubbles start at zero unless the setting says otherwise. */
export const ZERO_BASED_TYPES = new Set(["scatter", "square", "circle"]);
/** The range Edit Sizes accepts, in whole percent of the chart's own size range. */
export const SIZE_PCT = Object.freeze({ min: 0, max: 100 });
/** The Sizes vary modes (Automatic is the chart's own default: bubbles from zero, everything else by range) and the bound on a typed Start / End value. */
export const SIZE_VARY = Object.freeze(["automatic", "range", "zero"]);
export const SIZE_VALUE_LIMIT = 1e12;
/** The Sizes vary drop-down: [mode, label]. */
export const VARY_CHOICES = Object.freeze([["automatic", "Automatic"], ["range", "By range"], ["zero", "From zero"]]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pct = (v) => Number.isInteger(v) && v >= SIZE_PCT.min && v <= SIZE_PCT.max;
const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));
const typed = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= SIZE_VALUE_LIMIT;

/**
 * The setting as the drawing reads it: { smallest, largest, fromZero (null = the chart's default), reversed, start, end (null = the data's) }.
 * `fromZero` is resolved from `vary` (an older file's `fromZero` reads as the same mode). A start is ignored under an explicit From zero. Whether a
 * start applies on a chart whose Automatic is From zero (bubbles), and whether a typed pair is crossed, is decided where the chart is known (`sizeEnds`).
 * Never throws; defensive about a bad stored value.
 */
export function sizeScaleOf(format) {
  const s = isObj(format?.sizeScale) ? format.sizeScale : {};
  const lo = pct(s.smallest) ? s.smallest : SIZE_PCT.min, hi = pct(s.largest) ? s.largest : SIZE_PCT.max, ok = lo < hi;
  const fromZero = SIZE_VARY.includes(s.vary) ? (s.vary === "zero" ? true : s.vary === "range" ? false : null) : typeof s.fromZero === "boolean" ? s.fromZero : null;
  const start = fromZero === true ? null : typed(s.start) ? s.start : null, end = typed(s.end) ? s.end : null;
  return { smallest: ok ? lo : SIZE_PCT.min, largest: ok ? hi : SIZE_PCT.max, fromZero, reversed: s.reversed === true, start, end };
}
/** The Sizes vary mode a read setting is in: "automatic" | "range" | "zero". */
export const sizeVary = (scale) => (scale.fromZero === true ? "zero" : scale.fromZero === false ? "range" : "automatic");
/**
 * The typed ends that apply: a start never applies where the span starts at zero (`zeroDefault` = the chart's own default, used when the mode is
 * Automatic), and a crossed pair (start at or above the end) is ignored whole. An inert stored start therefore never crosses or blocks an end.
 */
export function sizeEnds(scale, zeroDefault = false) {
  const zero = scale.fromZero ?? zeroDefault;
  const start = zero ? null : scale.start, end = scale.end;
  return start != null && end != null && start >= end ? { start: null, end: null } : { start, end };
}
/** Does the stored setting change anything? */
export const sizeScaleIsDefault = (format) => { const s = sizeScaleOf(format); return s.smallest === 0 && s.largest === 100 && s.fromZero === null && !s.reversed && s.start === null && s.end === null; };

/** Why a Sizes vary mode is refused, or null. */
export const sizeVaryError = (v) => (SIZE_VARY.includes(v) ? null : "Sizes vary is Automatic, By range or From zero.");
/** Why a typed Start / End pair is refused (null = not set; a finite number each, within the limit, start below end), or null. */
export function sizeEndsError(start, end) {
  for (const v of [start, end]) {
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return "Start and End values are numbers.";
    if (Math.abs(v) > SIZE_VALUE_LIMIT) return `Start and End values are between -${SIZE_VALUE_LIMIT.toExponential(0)} and ${SIZE_VALUE_LIMIT.toExponential(0)}.`;
  }
  return start != null && end != null && start >= end ? "The start value must be below the end value." : null;
}
/**
 * Typing a Start / End value (`key`, `value` null = cleared) into the stored setting `raw` -> { error, value }: `value` is the stored shape to save
 * (`raw` with the key set or removed). Where the span starts at zero (From zero, or Automatic on a chart whose default is From zero: `zeroDefault`) the
 * Start field is off, so a start stored there is dropped (it could neither be cleared by the user nor be told apart from a crossing at import).
 */
export function sizeEndsEdit(raw, zeroDefault, key, value) {
  const stored = isObj(raw) ? raw : {};
  const inZero = (sizeScaleOf({ sizeScale: stored }).fromZero ?? zeroDefault) === true;
  const next = { start: stored.start ?? null, end: stored.end ?? null, [key]: value };
  if (inZero) next.start = null;
  const error = sizeEndsError(next.start, next.end);
  const out = { ...stored };
  for (const k of ["start", "end"]) if (next[k] == null) delete out[k]; else out[k] = next[k];
  return { error, value: out };
}
/**
 * The stored setting after picking a Sizes vary mode: the older `fromZero` key goes, and From zero drops what it makes meaningless (a start, Reversed).
 * Automatic on a chart whose default is From zero (`zeroDefault`, bubbles) drops the start too, as its field is off there.
 */
export function setSizeVary(raw, vary, zeroDefault = false) {
  const out = { ...(isObj(raw) ? raw : {}) };
  delete out.fromZero; delete out.vary;
  if (vary !== "automatic") out.vary = vary;
  if (vary === "zero") { delete out.start; delete out.reversed; }
  else if (vary === "automatic" && zeroDefault) delete out.start;
  return out;
}

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
  let zero = out.fromZero === true;
  if (raw.vary !== undefined) {
    if (!SIZE_VARY.includes(raw.vary)) issues.push(`Sizes vary "${raw.vary}" — reset to Automatic.`);
    else if (raw.vary === "automatic") { delete out.fromZero; zero = false; } // the default: not stored
    else { out.vary = raw.vary; zero = raw.vary === "zero"; }
  }
  let start, end;
  for (const k of ["start", "end"]) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (!typed(raw[k])) issues.push(`the ${k} value "${raw[k]}" — dropped (a number between -${SIZE_VALUE_LIMIT.toExponential(0)} and ${SIZE_VALUE_LIMIT.toExponential(0)}).`);
    else if (k === "start") start = raw[k]; else end = raw[k];
  }
  if (start !== undefined && end !== undefined && start >= end) { issues.push("the start value was not below the end value — both dropped."); start = end = undefined; }
  if (start !== undefined && zero) { issues.push("From zero starts at zero, so the start value was dropped."); start = undefined; }
  if (start !== undefined) out.start = start;
  if (end !== undefined) out.end = end;
  for (const k of Object.keys(raw)) if (!["smallest", "largest", "fromZero", "reversed", "vary", "start", "end"].includes(k)) issues.push(`the size setting "${k}" is unknown — dropped.`);
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
 * setting, else the chart's default). From zero the span runs from min(0, smallest value) to max(0, largest value); a point chart (`point`)
 * keeps its long-standing floor of 1 on the top (max(1, largest)); otherwise from the data's smallest to largest value (all equal = full size).
 * A typed End replaces the top (and the floor); a typed Start (never under From zero) replaces the bottom. A value below the start takes the
 * smallest share and one above the end the largest: it is never dropped.
 */
export function measureShareFn(values, { zero = false, point = false, scale = sizeScaleOf({}) } = {}) {
  const nums = (values ?? []).filter(finite).map(Number);
  if (!zero && !nums.length) return () => null;
  const { start, end } = sizeEnds({ ...scale, fromZero: zero }, zero);
  const lo = start ?? (zero ? Math.min(...nums, 0) : Math.min(...nums));
  const hi = end ?? (zero ? Math.max(...nums, point ? 1 : 0) : Math.max(...nums));
  const degenerate = !zero && start == null && end == null && lo === hi, span = hi - lo;
  return (v) => {
    if (!finite(v)) return null;
    const x = Number(v);
    if (start != null && x < start) return applyScale(0, scale, false);
    if (end != null && x > end) return applyScale(1, scale, false);
    if (degenerate) return applyScale(1, scale, true);
    const raw = span > 0 ? Math.min(1, Math.max(0, (x - lo) / span)) : start != null ? 0 : end != null ? 1 : (x - lo) / (span || 1);
    return applyScale(raw, scale, false);
  };
}
/** A measure's per-mark shares (0..1, null stays null): measureShareFn over the list. */
export const measureShares = (values, opts) => { const f = measureShareFn(values, opts); return (values ?? []).map(f); };

/** The member order of a Size dimension: distinct raw keys, numbers by value, text by locale, no member last. -> [{ raw, key }] */
export function memberOrder(rawKeys) {
  const seen = new Map();
  for (const raw of rawKeys) { const key = tupleKey([raw]); if (!seen.has(key)) seen.set(key, { raw, key }); }
  const list = [...seen.values()];
  const numeric = list.every((m) => m.raw == null || Number.isFinite(Number(m.raw))); // one rule for every pair, so the order is transitive
  const cmp = (a, b) => {
    if (a.raw == null || b.raw == null) return (a.raw == null) - (b.raw == null);
    return numeric ? Number(a.raw) - Number(b.raw) : String(a.raw).localeCompare(String(b.raw));
  };
  return list.sort(cmp);
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

/** The Size legend's words: "Size: sum qty (3 to 41)", or for members "Size: region (APAC to US, 6 steps)"; a reversed scale says so, and typed ends replace the data's ("10 to 50, set"). */
export function sizeLegendText(name, { range, members, reversed = false, fmtVal = String, ends = null }) {
  if (members) {
    const n = members.length;
    const body = n === 1 ? members[0] : `${members[0]} to ${members[n - 1]}, ${n} steps`;
    return `Size: ${name} (${body}${reversed ? ", reversed" : ""})`;
  }
  const start = ends?.start ?? null, end = ends?.end ?? null;
  const set = start != null && end != null ? ", set" : start != null ? ", start set" : end != null ? ", end set" : "";
  return `Size: ${name} (${fmtVal(start ?? range.min)} to ${fmtVal(end ?? range.max)}${set}${reversed ? ", reversed" : ""})`;
}

/** A line's own thickness in px for a 0..1 share (null = the thinnest). */
export const LINE_WIDTH = Object.freeze([2, 12]);
export const lineWidthFor = (share) => Math.round(LINE_WIDTH[0] + (share ?? 0) * (LINE_WIDTH[1] - LINE_WIDTH[0]));

/** Text steps for a Table / Text cell: the type scale's body, lead and title sizes (design rule 5), by thirds of the share. */
export const TEXT_STEPS = Object.freeze(["body", "lead", "title"]);
export const textStepFor = (share) => (share == null || share < 1 / 3 ? 0 : share < 2 / 3 ? 1 : 2);
