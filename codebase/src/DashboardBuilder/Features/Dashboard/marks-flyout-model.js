// Which controls each Marks tile's flyout shows (pure, DOM-free; tests/js/marks-flyout-model.test.mjs). Like the Color flyout (colour-flyout-model.js), a tile
// holds the settings that used to sit in Format: Size (Marker size, Edit Sizes), Shape (Marker shape, Shape bins, member shapes), Label (Data labels, Label marks,
// Label position), Tooltip (the text, Show tooltips / Command buttons / Tooltip mode), Path (Line style, Line pattern), Dates (the range, A fall is good).
// What shows depends on the chart type and on what the tile holds, so a control never appears where it would do nothing, and a tile with no control for the
// chart type stays quiet. dashboards.js builds each key; every stored key (format.markerSize, …) is unchanged.
import { linesTakeStyle } from "./line-style-model.js";

/** Chart types that draw a point marker whose size the Size flyout's Marker size sets (a heatmap only when its cells are circles). */
export const MARKER_TYPES = new Set(["scatter", "square", "circle", "line", "area", "combo", "heatmap"]);

/**
 * `tool` is the Marks tile key ("size" | "shape" | "label" | "tooltip" | "path" | "period"; any other has no moved controls).
 * `i`: `{ chartType, isChart, heatmapCircle, sizeEdit, shapeBins, memberShapes, labelMarks, labelPosition, lineKeys, tooltipKeys, periodSet, compare }` —
 * `sizeEdit` a drawn Size field offers Edit Sizes, `shapeBins` a measure is on Shape, `memberShapes` a Shape dimension has members to give a symbol,
 * `labelMarks` / `labelPosition` the Label controls are offered, `lineKeys` / `tooltipKeys` the keys `lineControlSpecs` / `tooltipControlSpecs` give,
 * `periodSet` a Dates field is set, `compare` it compares to another period.
 * Returns `[{ label, keys }]` in display order, a section with no key omitted.
 */
export function flyoutSections(tool, i) {
  const out = [];
  const add = (label, keys) => { if (keys.length) out.push({ label, keys }); };
  switch (tool) {
    case "size":
      add("Size", [
        ...(MARKER_TYPES.has(i.chartType) && (i.chartType !== "heatmap" || i.heatmapCircle) ? ["markerSize"] : []),
        ...(i.sizeEdit ? ["editSizes"] : []),
      ]);
      break;
    case "shape":
      add("Shape", [...(linesTakeStyle(i.chartType) ? ["markerShape"] : []), ...(i.shapeBins ? ["shapeBins"] : []), ...(i.memberShapes ? ["memberShapes"] : [])]);
      break;
    case "label":
      add("Label", [...(i.isChart ? ["dataLabels"] : []), ...(i.labelMarks ? ["labelMarks"] : []), ...(i.labelPosition ? ["labelPosition"] : [])]);
      break;
    case "tooltip":
      add("Text", ["text"]);
      add("Behaviour", i.tooltipKeys);
      break;
    case "path":
      add("Line", [...(linesTakeStyle(i.chartType) ? ["lineStyle"] : []), ...(i.lineKeys.includes("linePattern") ? ["linePattern"] : [])]);
      break;
    case "period":
      add("Range", [...(i.periodSet ? ["period"] : []), ...(i.periodSet && i.compare ? ["fallGood"] : [])]);
      break;
    default:
  }
  return out;
}
