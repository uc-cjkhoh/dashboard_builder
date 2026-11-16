import { renderChart as drawChart } from "./chart.js";
import { bulletTargets } from "./bullet-model.js";
import { ganttBars, ganttNotice, ganttSplit } from "./gantt-model.js";
import { isCalcPill } from "../Calc/calc-pill.js";
import { colorMode, isSizeDimension, marksOf } from "./sheet-plan.js";
import { sizeChannel } from "./mark-channel-model.js";
import { selectHandler, legendSpec, memberSpec } from "./render-handlers.js";
import { selectedIndicesOf } from "./dashboard-select.js";
import { hint } from "./render-dom.js";
import { heatmapData, treemapTree, sankeyLinks, multiplesData, keyLabel, primaryDim } from "./result-model.js";

// The chart families that pivot the ordinary query result into their own shape: heatmap, treemap, the types
// (waterfall / funnel / gauge / bullet / Sankey / small multiples) and the single-table distribution charts
// (histogram / box plot). Each draws into `container` (one chart per container, chart.js); none reads the editor.

/** Heatmap: two dimensions -> axes, the first measure -> colour. */
export function renderHeatmap(container, result, format, fmtCat) {
  drawChart(container, { type: "heatmap", ...heatmapData(result, fmtCat), format });
}

/**
 * Treemap: one or two dimensions form the hierarchy; the first measure sizes the rectangles. With a Size measure (`sizeIdx`) that
 * measure sets each tile's area and the first measure is the label's second line; a colour measure (`colourIdx`) shades the tiles.
 */
export function renderTreemap(container, result, format, fmtCat, { sizeIdx = -1, colourIdx = -1 } = {}) {
  drawChart(container, { type: "treemap", tree: treemapTree(result, fmtCat, { sizeIdx, colourIdx }), format,
    sizeName: sizeIdx >= 0 ? result.measures[sizeIdx] : null, colourName: colourIdx >= 0 ? result.measures[colourIdx] : null, shelfName: result.measures[0] });
}

/**
 * Waterfall / funnel / gauge / bullet / Sankey / small multiples, from the rows already fetched. A line the view
 * should show in its notice (the small-multiples panel cap) is set on `rc.extraNotice`.
 */
export function renderP36(container, rc, type, rows, categories, series, seriesNames, format, fmtCat, sheet = null, size = null) {
  const label = keyLabel(fmtCat);
  const target = format.target ?? null;
  if (type === "gauge") {
    drawChart(container, { type, value: series[0].data[0], name: seriesNames[0], target, format });
    return;
  }
  if (type === "bullet") {
    const cats = categories.some((x) => x) ? categories : [seriesNames[0]]; // no dimension -> one bar named after the measure
    const targets = bulletTargets({ fixed: target, measureIndex: format.targetMeasure, series, count: cats.length });
    if (!targets) { container.append(hint("Bullet compares each value with a target — set Target in Format, or pick a Target field.")); return; }
    drawChart(container, { type, categories: cats, values: series[0].data, targets, name: seriesNames[0], format });
    return;
  }
  if (type === "gantt") { renderGantt(container, rc, sheet, rows, series, seriesNames, format, fmtCat, size); return; }
  if (type === "sankey") {
    const links = sankeyLinks(rows, label);
    if (!links.length) { container.append(hint("No positive values to draw as flows.")); return; }
    drawChart(container, { type, links, format });
    return;
  }
  if (type === "multiples") {
    const m = multiplesData(rows, series, seriesNames, label);
    rc.extraNotice = m.notice;
    drawChart(container, { type, panels: m.panels, xCats: m.xCats, seriesNames, format });
    return;
  }
  // waterfall / funnel: one measure over the flattened categories.
  drawChart(container, { type, categories, series: [series[0]], format });
}

/**
 * Gantt: one dimension is the row, the first measure the start, the second the length (or, with Format → Length = End, the end). A
 * categorical Colour field (the result's last key) draws a bar per row and member in the member's colour, with a legend; a click on a
 * bar filters by its row's value like a bar chart's. A Size measure (`size` = { values per row, name }) sets each bar's thickness (D123); a Size
 * dimension is a hint (a member step would split the one-bar-per-row layout).
 */
function renderGantt(container, rc, sheet, rows, series, seriesNames, format, fmtCat, size = null) {
  if (sheet && isSizeDimension(marksOf(sheet).size)) container.append(hint(sizeChannel("gantt", series.length, true).note));
  const cf = sheet?.color?.[0];
  const colourSplit = Boolean(cf) && colorMode(sheet) === "discrete";
  const endMode = format.ganttLength === "end";
  const sp = ganttSplit(rows, fmtCat, colourSplit);
  const g = ganttBars(sp.categories, series[0].data, series[1].data, { end: endMode, slots: sp.slots, colours: sp.colours, raws: sp.rawRows, sizes: size?.values ?? null });
  rc.extraNotice = ganttNotice(g.skipped, endMode);
  if (!g.bars.length) { container.append(hint(endMode ? "No row has a valid start and an end that is not before it to draw as a bar." : "No row has a valid start and a length of 0 or more to draw as a bar.")); return; }
  const dim = sheet ? primaryDim(sheet) : null;
  const handler = sheet ? selectHandler(rc, sheet, dim, "gantt", g.raws) : undefined;
  const spec = { type: "gantt", categories: g.rows, gantt: g, name: endMode ? "Length" : seriesNames[1], format, sizeName: size?.name ?? null,
    onSelect: handler ? (p) => handler({ dataIndex: p.data?.[0] }) : undefined, selectedIndices: sheet ? selectedIndicesOf(g.raws, rc.selected, dim) : [] };
  if (colourSplit && g.groups.length) {
    const rawOf = new Map(rows.map((r, i) => [sp.colours[i], r.keys[r.keys.length - 1]]));
    Object.assign(spec, legendSpec(rc, sheet, cf, rawOf), isCalcPill(cf) ? {} : memberSpec(rc, sheet, cf, g.groups.map((name) => ({ name, raw: rawOf.get(name) }))));
  }
  drawChart(container, spec);
}

/** Histogram of one numeric column: `bins` as the histogram endpoint returns them. */
export function renderHistogram(container, bins, format, whole = false) {
  container.replaceChildren();
  drawChart(container, { type: "histogram", bins, whole, format });
}

/** Box plot: `boxes` = the boxplot endpoint's groups. */
export function renderBoxplot(container, boxes, format, outliers = []) {
  container.replaceChildren();
  drawChart(container, { type: "boxplot", boxes, outliers, format });
}
