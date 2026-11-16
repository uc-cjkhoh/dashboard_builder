// Line styles — pure, DOM-free (tests/js/charts1.test.mjs). Format → Line style on a line, area
// or combo chart: Straight (point to point), Step (each value holds until the next category, then
// changes) or Step (centred) (the value changes half-way between two categories). The stored key stays "jump".
import { LINE_STYLES } from "../Core/sheet-schema.js";
import { LINE_MARKER_CHOICES, lineMarkersOf } from "./line-marker-model.js";

export const LINE_STYLE_CHOICES = [["straight", "Straight"], ["step", "Step"], ["jump", "Step (centred)"]];
const STEPS = { step: "end", jump: "middle" }; // ECharts `step` values

/** ECharts' `step` setting for a style: false (straight, unset or unknown) or "end" / "middle". */
export const lineStep = (style) => (LINE_STYLES.has(style) ? STEPS[style] ?? false : false);

/** The chart types that draw lines and so offer Line style. */
export const linesTakeStyle = (type) => type === "line" || type === "area" || type === "combo";

// ---- Format → Line pattern: Solid, Dashed or Dotted on the plain measure lines --------------------------------------------------
// Stored as `format.linePattern` ("dashed" | "dotted"; absent = solid, so older files and a sheet that never set it draw as before).
// Dashes that already mean something keep their meaning: a measure cue (colour measure beside several measures) names its line, so the cue wins;
// a comparison line stays dashed and faded (beside a Dashed / Dotted main line it takes the dash-dot, so the two still differ without colour);
// reference lines, bands and the trend line are analytics, not measure lines, and are never patterned. A straight line whose own thickness
// follows a Size field is drawn as thickness polygons, which a dash can't break up, so it stays solid.
import { LINE_PATTERNS } from "../Core/sheet-schema.js";
import { lineSizeMode } from "./mark-channel-model.js";

export const LINE_PATTERN_CHOICES = [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]];

/** Why a line pattern is refused, or null when it is a known one. */
export const linePatternError = (v) => (LINE_PATTERNS.has(v) ? null : "Line pattern must be Solid, Dashed or Dotted.");

/** The stored pattern of a format ("solid" when unset or, defensively, unknown). */
export const linePatternOf = (format) => (LINE_PATTERNS.has(format?.linePattern) ? format.linePattern : "solid");

/** The pattern a plain measure line draws: Solid where Size sets its thickness (`thick`) or a cue names it (`cued`), else the stored choice. */
export const effectivePattern = ({ pattern, thick = false, cued = false }) => (thick || cued || !LINE_PATTERNS.has(pattern) ? "solid" : pattern);

/** ECharts' `lineStyle.type` for a measure line, or undefined for a plain solid line (the option then carries no `type`, as always). A cue's own dash wins. */
export function lineDash({ pattern, cue = null, thick = false }) {
  if (cue) return cue.dash;
  const p = effectivePattern({ pattern, thick });
  return p === "solid" ? undefined : p;
}

/** A comparison line's dash: dashed as always, or dash-dot beside a Dashed / Dotted main line (`pattern` = the effective pattern). */
export const comparisonDash = (pattern) => (pattern === "dashed" || pattern === "dotted" ? [8, 3, 2, 3] : "dashed");

/** The trend line's dash: dotted as always, or dash-dot beside a Dotted main line so the two differ by more than colour (`pattern` = the effective pattern). */
export const trendDash = (pattern) => (pattern === "dotted" ? [8, 3, 2, 3] : "dotted");

const NOTE = {
  thick: "Size sets this line's thickness, and a dashed line can't vary in thickness, so the line stays Solid.",
  cuedPattern: "A colour field on several measures gives each measure its own line pattern, so this choice isn't used.",
  cuedMarkers: "A colour field on several measures gives each measure its own marker, so the markers stay.",
  sizedMarkers: "Size varies the markers' size on this line, so the markers stay.",
  noLinesBar: "This combo draws no lines: its right-axis marks are bars.",
  noLinesOne: "This combo draws no lines yet: its lines start with the second measure.",
  none: "None: no markers on the line. A lone point (no line to carry it) keeps its marker, and Marker size and Marker shape have no other effect.",
};

/**
 * The Line pattern and Line markers controls for a worksheet's Format panel: [] when the chart type draws no lines, else
 * [{ key, label, choices, value, disabled, note }] — `disabled` is the reason the control does nothing (the panel shows it disabled with the reason
 * as its title), `value` what is really drawn (a disabled control reads the overriding value), `note` an extra hint for an enabled control.
 * `shelfCount` = measures on Columns / Rows; `colourMeasure` = a measure on Colour; `hasSize` = a Size field is set; `points` = the points the line chart drew
 * (series x categories, for the Size bound: a straight line with more draws its Size as marker size, so a dash can apply and the markers carry Size).
 */
export function lineControlSpecs({ type, format = {}, shelfCount = 1, colourMeasure = false, hasSize = false, points = 0 }) {
  if (!linesTakeStyle(type)) return [];
  const sizeMode = hasSize ? lineSizeMode(type, format.lineStyle, points) : null; // "width" (a straight line within the point bound) | "marker" (stepped line, area, a line over the bound) | null
  const noLines = type === "combo" && (format.secondaryType === "bar" ? NOTE.noLinesBar : shelfCount < 2 ? NOTE.noLinesOne : null);
  const cued = colourMeasure && shelfCount > 1;
  const markers = lineMarkersOf(format);
  const why = (own) => noLines || (cued ? own.cued : null) || own.size;
  return [
    { key: "linePattern", label: "Line pattern", choices: LINE_PATTERN_CHOICES, ...(() => {
      const reason = why({ cued: NOTE.cuedPattern, size: sizeMode === "width" ? NOTE.thick : null });
      return { value: reason ? "solid" : linePatternOf(format), disabled: reason, note: null };
    })() },
    { key: "lineMarkers", label: "Line markers", choices: LINE_MARKER_CHOICES, ...(() => {
      const reason = why({ cued: NOTE.cuedMarkers, size: sizeMode === "marker" ? NOTE.sizedMarkers : null });
      return { value: reason ? "all" : markers, disabled: reason, note: !reason && markers === "none" ? NOTE.none : null };
    })() },
  ];
}
