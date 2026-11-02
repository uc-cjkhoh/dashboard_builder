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
