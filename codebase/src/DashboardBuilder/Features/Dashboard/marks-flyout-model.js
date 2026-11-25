// Which controls each Marks tile's flyout shows (pure, DOM-free; tests/js/marks-flyout-model.test.mjs). Like the Color flyout (colour-flyout-model.js), a tile
// holds the settings that used to sit in Format: Size (Marker size, Edit Sizes), Shape (Marker shape, Shape bins, member shapes), Label (Data labels, Label marks,
// Label position), Tooltip (the text, Show tooltips / Command buttons / Tooltip mode), Path (Line style, Line pattern), Dates (the range, A fall is good), and the settings Tableau's card has that Format never held: Label's Allow labels to overlap, Pages' Speed.
// What shows depends on the chart type and on what the tile holds, so a control never appears where it would do nothing, and a tile with no control for the
// chart type stays quiet. dashboards.js builds each key; every stored key (format.markerSize, …) is unchanged.
import { linesTakeStyle } from "./line-style-model.js";
import { ELEMENT_SIZE_TYPES } from "./element-size-model.js";

/** Chart types whose elements are point markers, sized in px by the Size meter (a heatmap only when its cells are circles); every other type in element-size-model.js reads the meter on its own scale. */
export const MARKER_TYPES = new Set(["scatter", "square", "circle", "line", "area", "combo", "heatmap"]);

/** Chart types whose drawn Size field replaces the meter outright (a bubble, a bar's thickness, a Gantt bar's thickness). */
const FIELD_SIZED = new Set(["scatter", "square", "circle", "bar", "gantt"]);

/**
 * `tool` is the Marks tile key ("size" | "shape" | "label" | "tooltip" | "path" | "period" | "pages"; any other has no moved controls).
 * `i`: `{ chartType, isChart, heatmapCircle, sizeEdit, shapeBins, memberShapes, labelMarks, labelPosition, lineKeys, tooltipKeys, labelsDrawn, periodSet, compare, pagesSet }` —
 * `sizeEdit` a drawn Size field offers Edit Sizes, `shapeBins` a measure is on Shape, `memberShapes` a Shape dimension has members to give a symbol,
 * `labelMarks` / `labelPosition` the Label controls are offered, `labelsDrawn` a label is drawn (Data labels or a Label field, on a chart that draws them: Allow labels to overlap), `lineKeys` / `tooltipKeys` the keys `lineControlSpecs` / `tooltipControlSpecs` give,
 * `periodSet` a Dates field is set, `compare` it compares to another period, `pagesSet` a Pages field is set.
 * Returns `[{ label, keys }]` in display order, a section with no key omitted.
 */
export function flyoutSections(tool, i) {
  const out = [];
  const add = (label, keys) => { if (keys.length) out.push({ label, keys }); };
  switch (tool) {
    case "size":
      add("Size", [
        ...(ELEMENT_SIZE_TYPES.has(i.chartType) && (i.chartType !== "heatmap" || i.heatmapCircle) && !(i.sizeEdit && FIELD_SIZED.has(i.chartType)) ? ["markerSize"] : []), // where a drawn Size field sets every size itself the meter would do nothing; a line / area keeps its marker size beside a Size field
        ...(i.sizeEdit ? ["editSizes"] : []),
      ]);
      break;
    case "shape":
      add("Shape", [...(linesTakeStyle(i.chartType) ? ["markerShape"] : []), ...(i.shapeBins ? ["shapeBins"] : []), ...(i.memberShapes ? ["memberShapes"] : [])]);
      break;
    case "label":
      add("Label", [...(i.isChart ? ["dataLabels"] : []), ...(i.labelMarks ? ["labelMarks"] : []), ...(i.labelPosition ? ["labelPosition"] : []), ...(i.labelsDrawn ? ["labelOverlap"] : [])]);
      break;
    case "tooltip":
      add("Text", ["text"]);
      add("Behaviour", i.tooltipKeys);
      break;
    case "path":
      add("Line", [...(linesTakeStyle(i.chartType) ? ["lineStyle"] : []), ...(i.lineKeys.includes("linePattern") ? ["linePattern"] : [])]);
      break;
    case "pages":
      add("Playback", i.pagesSet ? ["pageSpeed"] : []); // the page control and Play stay on the worksheet; the flyout holds only how fast Play steps
      break;
    case "period":
      add("Range", [...(i.periodSet ? ["period"] : []), ...(i.periodSet && i.compare ? ["fallGood"] : [])]);
      break;
    default:
  }
  return out;
}
