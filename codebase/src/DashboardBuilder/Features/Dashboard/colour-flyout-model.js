// Which controls the Marks card's Color flyout shows (pure, DOM-free; tests/js/colour-flyout-model.test.mjs). The flyout holds the Colour
// controls that used to sit in Format, in three sections: Color (Colour by category, the continuous scale, Reverse palette, member colours),
// Opacity, and Effects (Border, Border colour, Line markers). What shows depends on the chart type and on what Color holds, so a control never appears
// where it would do nothing. dashboards.js builds each key; the stored keys are unchanged (format.colorScale, markOpacity, …).
import { BORDER_TYPES } from "./mark-style-model.js";
import { OPACITY_TYPES } from "./mark-opacity-model.js";
import { COLOUR_MEASURE_TYPES } from "./mark-channel-model.js";
import { linesTakeStyle } from "./line-style-model.js";

/** Whether the continuous colour scale (Colour scale, Steps, ramp, Limits …) applies: a heatmap always, a chart when a measure is on Color. */
export const colourScaleShown = (chartType, mode) => chartType === "heatmap" || (mode === "continuous" && COLOUR_MEASURE_TYPES.has(chartType));

/**
 * `{ chartType, isChart, mode, canColourByCat, borderOn, scale, steps }` → `{ colour, opacity, effects }`, each a list of control keys in display order.
 * `mode` is `colorMode(sheet)` ("none" | "discrete" | "continuous"); `scale` the scale the drawing resolved ("sequential" | "diverging");
 * `steps` whether Steps is set; `isChart` whether the type takes the chart-only Format controls (Reverse palette, member colours).
 */
export function colourFlyoutGroups({ chartType, isChart, mode, canColourByCat, borderOn, scale, steps }) {
  const scaleShown = colourScaleShown(chartType, mode);
  const diverging = scale === "diverging";
  const colour = [];
  if (canColourByCat) colour.push("colourByCategory");
  if (scaleShown) colour.push("scale", "steps", diverging ? "pair" : "ramp", ...(diverging && !steps ? ["fullRange"] : []));
  if (isChart) colour.push("reverse");
  if (scaleShown) colour.push("limits");
  if (isChart && mode !== "continuous") colour.push("members"); // a colour measure replaces member colours
  const opacity = OPACITY_TYPES.has(chartType) ? ["opacity"] : [];
  const effects = [];
  if (BORDER_TYPES.has(chartType)) { effects.push("border"); if (borderOn) effects.push("borderColour"); }
  if (linesTakeStyle(chartType)) effects.push("lineMarkers");
  return { colour, opacity, effects };
}
