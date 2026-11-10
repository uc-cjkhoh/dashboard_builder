import { renderChart as drawChart } from "./chart.js";
import { bulletTargets } from "./bullet-model.js";
import { ganttBars, ganttNotice } from "./gantt-model.js";
import { hint } from "./render-dom.js";
import { heatmapData, treemapTree, sankeyLinks, multiplesData, keyLabel } from "./result-model.js";

// The chart families that pivot the ordinary query result into their own shape: heatmap, treemap, the types
// (waterfall / funnel / gauge / bullet / Sankey / small multiples) and the single-table distribution charts
// (histogram / box plot). Each draws into `container` (one chart per container, chart.js); none reads the editor.

/** Heatmap: two dimensions -> axes, the first measure -> colour. */
export function renderHeatmap(container, result, format, fmtCat) {
  drawChart(container, { type: "heatmap", ...heatmapData(result, fmtCat), format });
}

/** Treemap: one or two dimensions form the hierarchy; the first measure sizes the rectangles. */
export function renderTreemap(container, result, format, fmtCat) {
  drawChart(container, { type: "treemap", tree: treemapTree(result, fmtCat), format });
}

/**
 * Waterfall / funnel / gauge / bullet / Sankey / small multiples, from the rows already fetched. A line the view
 * should show in its notice (the small-multiples panel cap) is set on `rc.extraNotice`.
 */
export function renderP36(container, rc, type, rows, categories, series, seriesNames, format, fmtCat) {
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
  if (type === "gantt") {
    const g = ganttBars(categories, series[0].data, series[1].data);
    rc.extraNotice = ganttNotice(g.skipped);
    if (!g.bars.length) { container.append(hint("No row has a valid start and a length of 0 or more to draw as a bar.")); return; }
    drawChart(container, { type, categories, gantt: g, name: seriesNames[1], format });
    return;
  }
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
