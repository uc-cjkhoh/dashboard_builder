// Dual axis (T03-16, T03-17) — pure, DOM-free (tests/js/charts2.test.mjs). Format → Synchronise axes gives a combo's
// two value axes one shared, nice-rounded range so the bars and the right-axis marks are comparable. Format → Right-axis
// marks picks how the secondary measures are drawn.
import { SECONDARY_TYPES } from "../Core/sheet-schema.js";

export const SECONDARY_CHOICES = [["line", "Line"], ["bar", "Bars"], ["area", "Area"]];

/** The mark kind for the right-axis measures: line (unset or unknown), bar or area. */
export const secondaryKind = (t) => (SECONDARY_TYPES.has(t) ? t : "line");

const niceStep = (rough) => {
  const p = 10 ** Math.floor(Math.log10(rough));
  const f = rough / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
const clean = (v) => Number(v.toPrecision(12)); // 0.1 * 3 -> 0.3, no float dust on the axis

/**
 * One { min, max } for all the series (arrays of values) — or null when no value is a finite number.
 * Non-numbers (null, NaN, strings, ±Infinity) are skipped. `zeroBaseline` (default, for bars) always includes 0.
 */
export function syncRange(seriesData, { zeroBaseline = true } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (const data of seriesData) for (const v of data ?? []) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return null;
  if (zeroBaseline || lo === hi) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) return { min: 0, max: 1 }; // all zero
  const step = niceStep((hi - lo) / 5);
  return { min: clean(Math.floor(lo / step) * step), max: clean(Math.ceil(hi / step) * step) };
}
