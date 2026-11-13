// Mark opacity (Format → Opacity) — pure, DOM-free (tests/js/mark-opacity.test.mjs). `format.markOpacity` is a whole percent, a multiple of 10
// from 0 to 100, kept off `defaultFormat` (absent = 100 = the marks as they have always drawn). The drawing multiplies every opacity a mark
// already carries (a scatter's 0.8, an area's 0.18, a dimmed selection's 0.35) by the setting rather than replacing it, so nothing
// that opacity already says (a fade for "not selected", a hatched comparison) is lost. Opacity never carries meaning: legends, axes,
// tooltips and labels stay at full strength.
import { BORDER_TYPES } from "./mark-style-model.js";

/** Chart types whose marks take Format → Opacity (the ones with a Mark border, plus lines, areas and small multiples). */
export const OPACITY_TYPES = new Set([...BORDER_TYPES, "line", "area", "multiples"]);
/** [value, label] — the percentages Format offers. */
export const OPACITY_CHOICES = Object.freeze(Array.from({ length: 11 }, (_, i) => [100 - i * 10, `${100 - i * 10} %`]));

/** Why a stored opacity is refused, or null (a whole percent that is a multiple of 10, 0 to 100). */
export const markOpacityError = (v) => (Number.isInteger(v) && v >= 0 && v <= 100 && v % 10 === 0 ? null : "Opacity must be 0 to 100 percent in steps of 10.");
/** The opacity as a 0..1 factor; 1 for an absent or (defensively) invalid value. */
export const markOpacityOf = (format) => { const v = format?.markOpacity; return v !== undefined && v !== null && markOpacityError(v) === null ? v / 100 : 1; };

const R = (x) => Math.round(x * 1000) / 1000;
const times = (style, k) => ({ ...style, opacity: R((style?.opacity ?? 1) * k) });
const ANALYTICS = "analytics:"; // the id prefix of a trend line: it is an overlay about the marks, not a mark
export const ANALYTICS_ID = ANALYTICS;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** A data item's own opacity (a faded one) scaled; an item without its own keeps the series' (scaled) value. */
const scaleItem = (d, k) => (isObj(d) && d.itemStyle?.opacity != null ? { ...d, itemStyle: times(d.itemStyle, k) } : d);

/**
 * `option` with every mark's opacity multiplied by `k` (0..1). Returns the option itself when k is 1. Reference lines, bands and the trend
 * are left alone. A straight line drawn with a thickness overlay (a silent custom series of the same name) hides its own thin stroke when
 * k < 1, so the overlay alone shows and the two do not stack into a darker core.
 */
export function applyMarkOpacity(option, k) {
  if (!option || !Array.isArray(option.series) || !(k >= 0 && k < 1)) return option;
  if (option.series.every((s) => s.type === "treemap")) return option; // drawn with alpha colours by the builder
  const overlaid = new Set(option.series.filter((s) => String(s.id ?? "").startsWith("size-width:")).map((s) => s.name));
  return { ...option, series: option.series.map((s) => {
    if (String(s.id ?? "").startsWith(ANALYTICS) || String(s.id ?? "").startsWith("size-width:")) return s;
    const out = { ...s, itemStyle: times(s.itemStyle, k) };
    if (s.type === "line") {
      out.lineStyle = overlaid.has(s.name) ? { ...s.lineStyle, opacity: 0 } : times(s.lineStyle, k);
      if (s.areaStyle) out.areaStyle = times(s.areaStyle, k);
    }
    if (s.type === "sankey" && s.lineStyle) out.lineStyle = times(s.lineStyle, k); // the flows
    if (s.emphasis?.itemStyle?.opacity != null) out.emphasis = { ...s.emphasis, itemStyle: times(s.emphasis.itemStyle, k) };
    if (Array.isArray(s.data)) out.data = s.data.map((d) => scaleItem(d, k));
    return out;
  }) };
}

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
/** `colour` (#rrggbb) as an rgba() at alpha `k`; any other colour string is returned as it is. A treemap tile takes no itemStyle opacity, so it is drawn with an alpha colour. */
export const withAlpha = (colour, k) => { const m = HEX6.exec(colour ?? ""); return m && k < 1 ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${R(k)})` : colour; };

/** `format.markOpacity` as a sheet stores it: -> { ok, value } (null = nothing to store: 100); for the Format control's change. */
export function cleanMarkOpacity(v) {
  if (v == null || v === 100) return { ok: true, value: null };
  const err = markOpacityError(v);
  return err ? { ok: false, error: err } : { ok: true, value: v };
}
