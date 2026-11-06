// Continuous colour scale: ramp choice and value range — pure, DOM-free (tests/js/colour-scale-model.test.mjs).
// `format.colorRamp` picks the hue of the single-hue ramp drawn for scatter and heatmap colour; `format.colorMin` /
// `format.colorMax` pin the ends of the scale (null = the data's own end).
import { rampStops } from "./colour-model.js";

/** [value, label] — the hue slots Format offers; each reads a design token at draw time. */
export const RAMP_CHOICES = Object.freeze([["brand", "Brand"], ["blue", "Blue"], ["green", "Green"], ["amber", "Amber"], ["violet", "Violet"]]);
const SLOT = { blue: 0, green: 1, amber: 3, violet: 6 }; // index into the eight categorical tokens

const HEX = /^#[0-9a-f]{6}$/i;
const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** `a` blended `t` (0–1) toward `b`, as #rrggbb; `b` itself when either input is not a #rrggbb. */
export function mixHex(a, b, t) {
  if (!HEX.test(a) || !HEX.test(b)) return b;
  const [x, y] = [toRgb(a), toRgb(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

/** The ramp's [low, high] colours. `tk` = { accent, accentSoft, surface, cat[] } (resolved tokens). */
export function rampColours(name, tk, reverse) {
  const slot = SLOT[name];
  const high = slot === undefined ? tk.accent : tk.cat[slot] ?? tk.accent;
  const low = slot === undefined ? tk.accentSoft : mixHex(tk.surface, high, 0.2);
  return rampStops(low, high, reverse);
}

/** Why a colour range is refused, or null (each end optional; min must be less than max). */
export function colourRangeError(min, max) {
  for (const v of [min, max]) if (v != null && !Number.isFinite(v)) return "The colour range must be numbers.";
  return min != null && max != null && !(min < max) ? "The colour range minimum must be less than the maximum." : null;
}

/** The scale's ends: the data span, overridden by a set min / max; never empty or inverted. */
export function rangeOf(values, min, max) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v));
  let lo = min ?? (nums.length ? Math.min(...nums) : 0);
  let hi = max ?? (nums.length ? Math.max(...nums) : 1);
  if (hi <= lo) hi = lo + 1;
  return { min: lo, max: hi };
}

/** [value, label] — `format.colorScale`: one hue low → high, or two hues meeting at a centre value. */
export const SCALE_CHOICES = Object.freeze([["sequential", "Low → high"], ["diverging", "Diverging"]]);

/** Token fallbacks for the diverging pair (the light theme's values; core.css `--chart-div-low` / `--chart-div-high` win). */
export const DIV_FALLBACK = Object.freeze({ low: "#d98a4a", high: "#2b62b8" });

/** The diverging ramp's [low, centre, high]: the warm token, the surface, the cool token. `tk` = { surface, divLow, divHigh }. */
export function divergingColours(tk, reverse) {
  const [low, high] = [tk.divLow ?? DIV_FALLBACK.low, tk.divHigh ?? DIV_FALLBACK.high];
  return reverse ? [high, tk.surface, low] : [low, tk.surface, high];
}

/** Why a colour centre is refused, or null (blank is fine; a finite number no larger than 1e15 in size). */
export function colourCentreError(v) {
  if (v == null) return null;
  return Number.isFinite(v) && Math.abs(v) <= 1e15 ? null : "The colour centre must be a number no larger than 1e15.";
}

/**
 * The diverging scale's ends and centre for data span lo..hi. The centre is the one set, else 0 when the span
 * straddles it, else the middle. The ends are made symmetric about it so the middle colour sits on the centre.
 */
export function divergingRange(lo, hi, centre) {
  const c = centre != null && Number.isFinite(centre) ? centre : lo < 0 && hi > 0 ? 0 : (lo + hi) / 2;
  const half = Math.max(c - lo, hi - c, 0) || 1;
  return { min: c - half, max: c + half, centre: c };
}
