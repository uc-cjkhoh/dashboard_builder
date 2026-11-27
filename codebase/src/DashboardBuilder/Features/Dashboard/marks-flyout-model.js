// Which controls each Marks tile's flyout shows (pure, DOM-free; tests/js/marks-flyout-model.test.mjs). Like the Color flyout (colour-flyout-model.js), a tile
// holds the settings that used to sit in Format: Size (Marker size, Edit Sizes), Shape (Marker shape, Shape bins, member shapes), Label (Show mark labels, Label marks,
// Label position, Text, Font, Alignment), Tooltip (the text, Show tooltips / Command buttons / Tooltip mode), Path (Line style, Line pattern), Dates (the range, A fall is good), and the settings Tableau's card has that Format never held: Label's Allow labels to overlap, Pages' Speed.
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
 * `i`: `{ chartType, isChart, heatmapCircle, sizeEdit, shapeBins, memberShapes, labelMarks, labelPosition, lineKeys, labelsDrawn, periodSet, compare, pagesSet }` —
 * `sizeEdit` a drawn Size field offers Edit Sizes, `shapeBins` a measure is on Shape, `memberShapes` a Shape dimension has members to give a symbol,
 * `labelChart` the chart type draws labels (Text, Font, Alignment, Allow labels to overlap), `labelMarks` / `labelPosition` Marks to Label / Position are offered for this chart type, `labelsDrawn` a label is drawn
 * (Show mark labels or a Label field, on a chart that draws them): the Label controls are offered by chart type and sit disabled until then, never hidden, `lineKeys` the keys `lineControlSpecs` gives,
 * `periodSet` a Dates field is set, `compare` it compares to another period, `pagesSet` a Pages field is set.
 * Returns `[{ label, keys, heading? }]` in display order, a section with no key omitted (`heading`: the section shows its label as a visible heading, set only where its controls do not name it — the Label tile's later sections — and dropped by `flyEditor` when a flyout has one section).
 */
export function flyoutSections(tool, i) {
  const out = [];
  const add = (label, keys, heading = false) => { if (keys.length) out.push(heading ? { label, keys, heading } : { label, keys }); };
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
    case "label": // Tableau's label card: Show mark labels, then Label Appearance (Text, Font, Alignment, Position), Marks to Label and Options — each headed (`heading`)
      add("Label", i.isChart ? ["dataLabels"] : []);
      add("Label Appearance", [...(i.labelChart ? ["labelText", "labelFont", "labelAlign"] : []), ...(i.labelPosition ? ["labelPosition"] : [])], true);
      add("Marks to Label", i.labelMarks ? ["labelMarks"] : [], true);
      add("Options", i.labelChart ? ["labelOverlap"] : [], true);
      break;
    case "tooltip": // no sections here: the whole editor (text, preview, behaviour, formats) is built by tooltip-editor.js and kept in place across renders (dashboards.js tooltipFly)
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
