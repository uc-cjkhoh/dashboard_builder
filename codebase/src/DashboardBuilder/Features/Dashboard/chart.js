import { makeValueFormatter } from "../Core/format.js";
import { ACCENTS, PALETTES } from "../Core/theme-model.js";
import { pickInk } from "./contrast.js";
import { orderedPalette } from "./colour-model.js";
import { rampColours, rangeOf } from "./colour-scale-model.js";
import { tooltipHtml } from "./tooltip-model.js";
import { lineStep } from "./line-style-model.js";
import { syncRange, secondaryKind, dualAxisOn, rightAxisTitle, seriesAxis } from "./axis-sync-model.js";
import { markBorder, markerSizeOr, markerSymbol, edgeOr } from "./mark-style-model.js";
import { circleSize, circleCells, HEATMAP_GUTTER } from "./heatmap-model.js";
import { bandsFor } from "./bullet-model.js";
import { ganttTime, ganttAxisTime, ganttLabelMargin } from "./gantt-model.js";
import { boxData, outlierPoints } from "./box-model.js";
import { chartFit, markCount, applyFitMode, FIT } from "./chart-fit.js";
import { applySelectionDim } from "./selection-dim.js";
import { dateFitMode } from "./date-labels.js";
import { axisLabelPlan, shortDateLabels } from "./date-axis.js";

// Charting adapter. Renders worksheet results through the self-hosted ECharts library
// (wwwroot/js/vendor/echarts.min.js, loaded as a global before the module graph — no CDN).
// The rest of the app stays vanilla-JS: this is a thin mapper from our { categories, series }
// result to an ECharts option, themed entirely from the CSS design tokens so charts match the
// RED/BLACK/WHITE system. One live instance per container (state in a WeakMap keyed by the container element); rendering into a
// container disposes only that container's previous chart.
//
// Series: one per measure (multiple Rows/Columns measures → multiple series); the category axis
// carries the concatenated dimension keys. A single series wears the brand accent; multiple series
// draw from the dataviz-validated categorical palette in fixed order (with a legend, since identity
// must never be colour-alone). See references/palette.md and site.css --chart-cat-*.

// Per-container state: { instance, resizeObserver, lastOption (the option on screen — re-drawn as SVG for export
// when the chart is on canvas), onCanvas, animateNext (a short entrance for fresh data) }.
const states = new WeakMap();
function stateOf(container) {
  let st = states.get(container);
  if (!st) states.set(container, st = { instance: null, resizeObserver: null, lastOption: null, onCanvas: false, animateNext: true });
  return st;
}
// The container being drawn right now: the option is built synchronously inside renderChart, and builders that need
// the live chart later (a symbolSize callback) capture it at build time. The render settings — palette
// order reversed, and displayed member name -> user colour — live in each container's state (st.paletteReverse,
// st.memberColors), so two live charts never share or clobber them.
let drawing = null;
const reversed = () => Boolean(drawing?.paletteReverse);
const memberColors = () => drawing?.memberColors ?? NO_MEMBER_COLORS;
const NO_MEMBER_COLORS = new Map();
const memberColor = (name, fallback) => memberColors().get(name) ?? fallback;

// Pull themed values from :root so the chart tracks the design tokens (and any future retheme).
function tokens() {
  const cs = getComputedStyle(document.documentElement);
  // Resolve one level of var() indirection in case a browser returns a custom property
  // (e.g. --chart-series: var(--accent)) unsubstituted — belt-and-braces over getComputedStyle.
  const t = (name, fallback) => {
    let v = cs.getPropertyValue(name).trim();
    const m = v.match(/^var\((--[\w-]+)\)$/);
    if (m) v = cs.getPropertyValue(m[1]).trim();
    return v || fallback;
  };
  // Categorical slots for multi-series charts (one measure = one series). This is the dataviz
  // skill's validated 8-hue order (fixed order, never cycled; see references/palette.md) — read from
  // CSS tokens with the validated hexes as fallback. A single-series chart uses the brand accent
  // instead (below), keeping the common case on-brand.
  const catFallback = PALETTES.default.light;
  const cat = orderedPalette(catFallback.map((hex, i) => t(`--chart-cat-${i + 1}`, hex)), reversed());
  return {
    series: t("--chart-series", ACCENTS.crimson.light.accent),
    cat,
    axis: t("--chart-axis", "#d9cfd1"),
    grid: t("--chart-grid", "#ebe4e5"),
    label: t("--chart-label", "#423a3d"),
    muted: t("--chart-muted", "#6b6165"),
    surface: t("--surface", "#ffffff"),
    ink: t("--ink", "#1c1719"),
    font: t("--font", "system-ui, sans-serif"),
    radius: parseFloat(t("--r", "8")) || 8, // the one corner radius (golden rule 11)
    // Brand stops for the sequential heatmap ramp (single-hue soft→saturated, token-driven).
    brand: t("--accent", ACCENTS.crimson.light.accent),
    brandSoft: t("--accent-soft", ACCENTS.crimson.light.soft),
    // continuous low -> high: the chosen hue from the accent pair or a categorical token
    ramp: rampColours(drawing?.colorRamp, { accent: t("--accent", ACCENTS.crimson.light.accent), accentSoft: t("--accent-soft", ACCENTS.crimson.light.soft), surface: t("--surface", "#ffffff"), cat: catFallback.map((hex, i) => t(`--chart-cat-${i + 1}`, hex)) }, reversed()),
  };
}

/**
 * Render a chart into `container`. Types: cartesian `bar` (grouped when ≥2 measures),
 * `stacked`, `line`, `area`, `combo` (dual-axis: 1st measure bars, rest line on a 2nd axis);
 * circular `pie` / `donut` (1 dimension × 1 measure); and `scatter` (two measures → X, Y).
 * One series per measure; the category axis carries the concatenated dimension keys.
 * @param container the #ws-chart element (a positioned host is created inside it)
 * @param spec { type, categories: string[], series: [{ name, data: number[] }],
 *              format?: sheet format config (value/date format, axis titles, legend, labels, colour-by),
 *              selectedIndices?: the category indices of the dashboard-selected mark(s) (bar / stacked / pie / donut fade the rest) }
 */
export function renderChart(container, spec) {
  disposeChart(container);
  const st = stateOf(container);
  st.paletteReverse = !!spec.format?.paletteReverse;
  st.colorRamp = spec.format?.colorRamp; st.colorMin = spec.format?.colorMin ?? null; st.colorMax = spec.format?.colorMax ?? null;
  st.memberColors = spec.memberColors instanceof Map ? spec.memberColors : NO_MEMBER_COLORS;
  const host = document.createElement("div");
  host.className = "ws-chart-canvas";
  container.append(host);

  // Every category keeps a slot and a label: a chart with more categories than fit takes the room it
  // needs and the pane (#ws-chart) scrolls, instead of squeezing bars and skipping labels.
  const inset = () => 2 * parseFloat(getComputedStyle(host).left || 0);
  const paneWidth = () => container.clientWidth - inset();
  const paneHeight = () => container.clientHeight - inset();
  const fitMode = dateFitMode(spec.format?.fit ?? "standard", spec.dateLabels, spec.type === "combo" ? "vertical" : spec.orientation); // Format → Fit, date axis per its Show all / Thin out
  let fit = applyFitMode(chartFit(spec, paneWidth(), paneHeight()), fitMode);
  host.style.setProperty("--chart-min-w", `${fit.minWidth}px`);
  host.style.setProperty("--chart-min-h", `${fit.minHeight}px`);

  // SVG renderer: crisp at any zoom, no canvas-sizing surprises, lighter DOM for our small charts. A
  // big chart (thousands of marks) draws on canvas instead — SVG slows down with that many nodes.
  const onCanvas = st.onCanvas = markCount(spec) > FIT.canvasMarks;
  const instance = st.instance = window.echarts.init(host, null, { renderer: onCanvas ? "canvas" : "svg" });
  let option;
  drawing = st; // builders that size marks later (heatmap circles) capture this container's state
  try {
    option = buildOption(spec.type === "multiples" ? { ...spec, width: paneWidth(), height: paneHeight() } : spec);
    option = applySelectionDim(option, spec.type, spec.selectedIndices); // the dashboard's source widget fades the unselected marks
    if (spec.type !== "multiples") showEveryCategory(option, fit.rotate, fit); // panels keep their own sparse labels
    if (!fit.zoom) setDateAxisLabels(option, spec, paneWidth(), paneHeight());
    if (fit.zoom) addZoom(option, fit);
    if (onCanvas) tuneForSize(option);
  } finally { drawing = null; }
  st.lastOption = option;
  instance.setOption({ ...option, ...motionOption(st.animateNext && !onCanvas) });

  // Click-to-filter: forward mark clicks to the caller, which maps dataIndex → a dimension value.
  if (typeof spec.onSelect === "function") instance.on("click", (p) => { if (p.componentType !== "legend") spec.onSelect(p); });
  // A legend click highlights (and can select) instead of hiding the series — ECharts toggles the
  // item, so every item is shown again straight away and the click goes to the worksheet.
  if (typeof spec.onLegend === "function") instance.on("legendselectchanged", (p) => {
    instance.dispatchAction({ type: "legendAllSelect" });
    // Next tick: the worksheet may re-render (dispose this instance) — not while ECharts is mid-event.
    setTimeout(() => spec.onLegend(p.name), 0);
  });
  if (spec.focus) focusSeries(container, spec.focus, spec.type);

  st.resizeObserver = new ResizeObserver(() => {
    if (st.instance !== instance) return;
    instance.resize();
    const next = applyFitMode(chartFit(spec, paneWidth(), paneHeight()), fitMode);
    if (next.rotate !== fit.rotate) {
      fit = next;
      instance.setOption({ xAxis: [].concat(option.xAxis).map(() => ({ axisLabel: { rotate: fit.rotate } })) });
    }
    if (!fit.zoom) { // a date axis re-picks its labels for the new size
      const d = dateAxisLabels(option, spec, paneWidth(), paneHeight());
      if (d) instance.setOption({ [d.key]: [{ axisLabel: d.axisLabel }] });
    }
  });
  st.resizeObserver.observe(host);
  return instance;
}

// Past FIT.maxSlots categories an axis gets a slider (and wheel/drag inside the plot) showing a window
// of categories at a time, instead of a pane thousands of pixels wide. Colours from the chart tokens.
function addZoom(option, fit) {
  const c = tokens();
  const slider = {
    type: "slider", height: 16, borderColor: c.grid, backgroundColor: "transparent", fillerColor: c.brandSoft,
    dataBackground: { lineStyle: { color: c.axis }, areaStyle: { color: c.grid } },
    handleStyle: { color: c.surface, borderColor: c.series }, moveHandleStyle: { color: c.axis },
    textStyle: { color: c.muted, fontFamily: c.font }, brushSelect: false,
  };
  const zooms = [];
  const grid = option.grid ?? (option.grid = {});
  if (fit.zoom.includes("x")) {
    const w = { startValue: 0, endValue: Math.max(0, fit.window - 1) };
    zooms.push({ type: "inside", xAxisIndex: 0, ...w }, { ...slider, xAxisIndex: 0, bottom: 4, ...w });
    grid.bottom = (Number(grid.bottom) || 0) + 28;
  }
  if (fit.zoom.includes("y")) {
    const w = { startValue: 0, endValue: Math.max(0, fit.windowY - 1) };
    zooms.push({ type: "inside", yAxisIndex: 0, ...w }, { ...slider, yAxisIndex: 0, orient: "vertical", right: 4, width: 16, height: null, ...w });
    grid.right = (Number(grid.right) || 0) + 28;
  }
  option.dataZoom = zooms;
}

// Canvas-sized charts: bars draw in ECharts' large mode, lines keep their shape with LTTB sampling
// (peaks and dips survive) when there are more points than pixels.
function tuneForSize(option) {
  for (const sr of [].concat(option.series ?? [])) {
    // Large mode draws plain values only — skip it when a bar carries its own style (Other, colour-by).
    if (sr.type === "bar" && (sr.data ?? []).every((v) => v === null || typeof v !== "object"))
      Object.assign(sr, { large: true, largeThreshold: 2000 });
    if (sr.type === "line") sr.sampling = "lttb";
  }
}

// Category axes label every category (no skipping); long labels truncate (the tooltip has the full
// name), and bottom labels tilt when they can't sit side by side.
function showEveryCategory(option, rotate, fit = {}) {
  const fix = (axis, bottom) => {
    if (!axis || axis.type !== "category") return axis;
    // A fitted axis shares the pane: labels thin out instead of forcing a slot each.
    if (bottom ? fit.fittedX : fit.fittedY) return { ...axis, axisLabel: { ...axis.axisLabel, hideOverlap: true, width: bottom ? FIT.labelMax : FIT.sideMax, overflow: "truncate" } };
    return { ...axis, axisLabel: { ...axis.axisLabel, interval: 0, hideOverlap: false,
      width: bottom ? FIT.labelMax : FIT.sideMax, overflow: "truncate", ...(bottom ? { rotate } : {}) } };
  };
  const each = (axes, bottom) => (Array.isArray(axes) ? axes.map((a) => fix(a, bottom)) : fix(axes, bottom));
  if (option.xAxis) option.xAxis = each(option.xAxis, true);
  if (option.yAxis) option.yAxis = each(option.yAxis, false);
}

// A date axis's labels (see date-axis.js): shortened to what varies, and in "Thin out" mode only as many as fit
// — first and last always, none touching. Returns { key: "xAxis" | "yAxis", axisLabel } or null (no date axis).
let measureCtx = null;
function dateAxisLabels(option, spec, width, height) {
  if (spec.dateLabels === undefined || spec.type === "multiples") return null;
  const bottom = !(spec.orientation === "horizontal" && spec.type !== "combo");
  const key = bottom ? "xAxis" : "yAxis";
  const axis = [].concat(option[key] ?? [])[0];
  if (!axis || axis.type !== "category" || !axis.data?.length) return null;
  const labels = axis.data.map(String);
  measureCtx ??= document.createElement("canvas").getContext("2d"); // null where canvas is unavailable
  if (measureCtx) measureCtx.font = `12px ${tokens().font}`;
  const cap = bottom ? FIT.labelMax : FIT.sideMax;
  const measure = (t) => Math.min(measureCtx ? measureCtx.measureText(t).width : t.length * FIT.charPx, cap);
  const g = option.grid ?? {};
  const length = bottom
    ? width - (Number(g.left) || 0) - (Number(g.right) || 0) - 56
    : height - (Number(g.top) || 0) - (Number(g.bottom) || 0) - 32;
  if (spec.dateLabels === "all") { // every label stays; they just say less
    const { texts } = shortDateLabels(labels);
    const byLabel = new Map(labels.map((l, i) => [l, texts[i]]));
    return { key, axisLabel: { formatter: (v) => byLabel.get(String(v)) ?? String(v) } };
  }
  const plan = axisLabelPlan({ labels, length: Math.max(length, 40), side: bottom ? "bottom" : "left", measure });
  const shown = new Set(plan.indices);
  const byLabel = new Map(labels.map((l, i) => [l, plan.texts[i]]));
  const box = Math.ceil(Math.max(...plan.indices.map((i) => measure(plan.texts[i])))) + 2; // a label's box is as wide as its text, not the truncation cap, so neighbours are not judged overlapping
  return { key, axisLabel: { interval: (i) => shown.has(i), hideOverlap: false, showMinLabel: true, showMaxLabel: true, width: plan.rotate ? cap : box, formatter: (v) => byLabel.get(String(v)) ?? String(v),
    ...(bottom ? { rotate: plan.rotate, alignMinLabel: plan.rotate ? null : "left", alignMaxLabel: plan.rotate ? null : "right" } : {}) } };
}
function setDateAxisLabels(option, spec, width, height) {
  const d = dateAxisLabels(option, spec, width, height);
  if (!d) return;
  const axes = [].concat(option[d.key]);
  axes[0] = { ...axes[0], axisLabel: { ...axes[0].axisLabel, ...d.axisLabel } };
  option[d.key] = Array.isArray(option[d.key]) ? axes : axes[0];
}

/** Highlight one series (or a pie slice) and dim the rest; null clears. */
export function focusSeries(container, name, type) {
  const instance = stateOf(container).instance;
  if (!instance) return;
  instance.dispatchAction({ type: "downplay" });
  if (name == null) return;
  if (type === "pie" || type === "donut" || type === "funnel") instance.dispatchAction({ type: "highlight", name });
  else instance.dispatchAction({ type: "highlight", seriesName: name });
}

/** Is there a live ECharts instance to export? (Table/KPI render as native DOM, so there isn't.) */
export function hasChartInstance(container) { return stateOf(container).instance !== null; }

// Motion: a short, decelerating entrance (300ms, not ECharts' default 1s) when the data is fresh from
// ClickHouse; none when re-rendering a cached result or under prefers-reduced-motion.
/** Draw the live chart at a fixed size (printing), or back to its pane's size with null. */
export function sizeChart(container, size) {
  const instance = stateOf(container).instance;
  if (!instance) return;
  instance.resize(size ? { ...size, animation: { duration: 0 } } : { width: "auto", height: "auto", animation: { duration: 0 } });
}

/** Whether the next renderChart animates its entrance (the worksheet sets this per result). */
export function animateNextChart(container, on) { stateOf(container).animateNext = Boolean(on); }
function motionOption(on) {
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return on && !reduce
    ? { animation: true, animationDuration: 300, animationEasing: "cubicOut", animationDurationUpdate: 250, animationEasingUpdate: "cubicInOut" }
    : { animation: false };
}

/**
 * Export the current chart as an image. We use the SVG renderer, so the SVG is already in the
 * DOM — we serialise that element (robust across ECharts builds; `renderToSVGString` only exists on
 * SSR instances). PNG is rasterised from the SVG through a canvas. Returns { blob, ext } or null.
 * @param kind "svg" | "png"
 */
export async function exportChart(container, kind) {
  const { instance, onCanvas, lastOption } = stateOf(container);
  if (!instance) return null;
  const w = (instance.getWidth && instance.getWidth()) || 800;
  const h = (instance.getHeight && instance.getHeight()) || 450;

  // A canvas chart: PNG straight from the canvas; SVG by redrawing the same option off-screen as SVG.
  if (onCanvas) {
    if (kind === "png") {
      const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff";
      const url = instance.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: surface });
      return { blob: await (await fetch(url)).blob(), ext: "png" };
    }
    const svg = offscreenSvg(lastOption, w, h);
    return svg ? { blob: new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), ext: "svg" } : null;
  }

  let svg = currentSvgString(instance, w, h);
  if (!svg) return null;
  if (kind === "svg") return { blob: new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), ext: "svg" };
  const blob = await svgToPng(svg, w, h);
  return blob ? { blob, ext: "png" } : null;
}

// Draw the on-screen option once more with the SVG renderer, in a detached box of the same size.
function offscreenSvg(lastOption, w, h) {
  if (!lastOption) return null;
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:-100000px;top:0;width:${w}px;height:${h}px`;
  document.body.append(box);
  const tmp = window.echarts.init(box, null, { renderer: "svg", width: w, height: h });
  try {
    tmp.setOption({ ...lastOption, animation: false });
    const el = box.querySelector("svg");
    let svg = el ? new XMLSerializer().serializeToString(el) : null;
    if (svg && !/xmlns=/.test(svg)) svg = svg.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    return svg;
  } finally { tmp.dispose(); box.remove(); }
}

// The chart's SVG as a standalone string. Prefer the DOM <svg> ECharts rendered (SVG renderer);
// fall back to renderToSVGString / getDataURL if present. Ensures xmlns + explicit width/height so
// the file opens on its own and rasterises at a known size.
function currentSvgString(instance, w, h) {
  let svg = null;
  const dom = instance.getDom && instance.getDom();
  const svgEl = dom && dom.querySelector("svg");
  if (svgEl) {
    svg = new XMLSerializer().serializeToString(svgEl);
  } else if (typeof instance.renderToSVGString === "function") {
    try { svg = instance.renderToSVGString(); } catch { svg = null; }
  } else if (typeof instance.getDataURL === "function") {
    try {
      const url = instance.getDataURL({ type: "svg" });
      const m = /^data:image\/svg\+xml[^,]*,(.*)$/.exec(url);
      if (m) svg = decodeURIComponent(m[1]);
    } catch { svg = null; }
  }
  if (!svg) return null;
  if (!/xmlns=/.test(svg)) svg = svg.replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/\swidth=/.test(svg)) svg = svg.replace(/<svg/, `<svg width="${w}" height="${h}"`);
  return svg;
}

// Rasterise an SVG string to a PNG Blob via an offscreen canvas. Resolves null if the browser can't
// load the SVG image (caller falls back to offering SVG).
function svgToPng(svg, w, h) {
  return new Promise((resolve) => {
    const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff";
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    const img = new Image();
    img.onload = () => {
      const scale = 2; // crisp on hi-dpi
      const canvas = document.createElement("canvas");
      canvas.width = (img.width || w || 800) * scale;
      canvas.height = (img.height || h || 450) * scale;
      const cx = canvas.getContext("2d");
      cx.fillStyle = surface;
      cx.fillRect(0, 0, canvas.width, canvas.height);
      cx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => resolve(b), "image/png");
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Tear down the live instance + its observer. Safe to call when nothing is rendered.
export function disposeChart(container) {
  const st = states.get(container);
  if (!st) return;
  if (st.resizeObserver) { st.resizeObserver.disconnect(); st.resizeObserver = null; }
  if (st.instance) { st.instance.dispose(); st.instance = null; }
  st.lastOption = null; st.onCanvas = false;
}

// Dispatch by chart-type family: circular (pie/donut), scatter (two value axes), or the
// shared cartesian builder (bar/stacked/line/area/combo).
function buildOption(spec) {
  if (spec.type === "pie" || spec.type === "donut") return buildPie(spec);
  if (spec.type === "scatterShapes") return buildScatterShapes(spec); // shape-split scatter
  if (spec.type === "scatter" || spec.type === "square" || spec.type === "circle") return buildScatter(spec); // point marks
  if (spec.type === "heatmap") return buildHeatmap(spec);
  if (spec.type === "treemap") return buildTreemap(spec);
  if (spec.type === "histogram") return buildHistogram(spec);
  if (spec.type === "boxplot") return buildBoxplot(spec);
  if (spec.type === "waterfall") return buildWaterfall(spec);
  if (spec.type === "funnel") return buildFunnel(spec);
  if (spec.type === "gauge") return buildGauge(spec);
  if (spec.type === "bullet") return buildBullet(spec);
  if (spec.type === "gantt") return buildGantt(spec);
  if (spec.type === "sankey") return buildSankey(spec);
  if (spec.type === "multiples") return buildMultiples(spec);
  return buildCartesian(spec);
}

// Legend placement shared across families. `defaultOn` decides the "auto" case.
function legendFor(format, c, names, defaultOn) {
  const mode = format.legend ?? "auto";
  const show = mode === "hidden" ? false : mode === "auto" ? defaultOn : true;
  const pos = mode === "auto" || mode === "hidden" ? (defaultOn ? "top" : "top") : mode;
  const legend = show ? {
    type: "scroll",
    data: names,
    textStyle: { color: c.label, fontFamily: c.font },
    icon: "roundRect",
    ...(pos === "bottom" ? { bottom: 0, left: "center" }
      : pos === "left" ? { left: 0, top: "middle", orient: "vertical" }
      : pos === "right" ? { right: 0, top: "middle", orient: "vertical" }
      : { top: 0, left: "center" }),
  } : undefined;
  return { show, pos, legend };
}

// bar / stacked / line / area / combo. Orientation (Tableau-style): a dimension on **Rows** →
// **horizontal** bars (category on the y-axis, value on x); a dimension on **Columns** → **vertical**
// (the default). `orientation` is decided by the caller from the shelves; combo stays vertical (its
// dual value axis is on y). Axis *titles* name the physical axes (xTitle = bottom, yTitle = left)
// regardless of orientation, so the Format controls stay literal.
export function buildCartesian({ type, categories, series, format = {}, orientation = "vertical", pointLabels, tooltipExtra, tooltipText, tooltipFields, tooltipStyle, otherIndex = -1, analytics = null }) {
  const c = tokens();
  const labels = (categories ?? []).map((l) => l ?? "—");
  // Comparison series (compare: true) ride beside their measure: they don't make a chart "multi"
  // (the main series keeps the brand colour), but they do bring the legend so the dashed line is named.
  const mainCount = series.filter((s) => !s.compare).length;
  const hasCompare = mainCount < series.length;
  const multi = mainCount > 1;
  const isCombo = type === "combo";
  const dual = dualAxisOn(type, format, mainCount) && (isCombo || orientation !== "horizontal"); // combo, or a vertical line / area with Format → Dual axis
  const horizontal = orientation === "horizontal" && !isCombo && !dual;
  const fmtVal = makeValueFormatter(format); // measure value format (tooltip, axis, labels)

  const colorFor = (i, name) => (multi ? memberColor(name, c.cat[i % c.cat.length]) : c.series);
  // Colour-by-dimension: a single-measure bar chart colours each bar by its category. The
  // category axis already labels each bar, so colour restates identity (never colour-alone).
  const colorByDim = type === "bar" && !multi && !!format.colorByDimension;

  const { show: showLegend, pos, legend } = legendFor(format, c, series.map((s) => s.name), multi || dual || hasCompare);
  const xTitle = format.xTitle || null;
  const yTitle = format.yTitle || null;

  // Label: when a Label field is mapped, marks show its per-row value; otherwise the toggle
  // shows the measure value. `pointLabels` is indexed by category (dataIndex).
  const labelPos = horizontal ? "right" : "top";
  const dataLabel = (pointLabels || format.dataLabels)
    ? { show: true, position: labelPos, color: c.label, fontFamily: c.font, fontSize: 14,
        formatter: (p) => (pointLabels ? String(pointLabels[p.dataIndex] ?? "") : fmtVal(p.value)) }
    : { show: false };

  // Attach a name to an axis with placement suited to its physical position (bottom vs left).
  const nameStyle = { color: c.label, fontFamily: c.font, fontWeight: 600 };
  const withName = (axis, name, isBottom) => (name
    ? { ...axis, name, nameLocation: isBottom ? "middle" : "end", nameGap: isBottom ? 28 : 12,
        nameTextStyle: { ...nameStyle, align: isBottom ? "center" : "left" } }
    : axis);

  const categoryAxis = {
    type: "category", data: labels,
    axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
    axisLabel: { color: c.muted, hideOverlap: true },
  };
  const valueAxisBase = (extra = {}) => ({
    type: "value",
    axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: c.grid } },
    axisLabel: { color: c.muted, formatter: fmtVal }, ...extra,
  });

  let xAxis, yAxis;
  if (dual) {
    // Combo / dual-axis line or area: category on x, left and right value axes on y.
    xAxis = withName(categoryAxis, xTitle, true);
    // Synchronise axes — one nice range (zero included, the first measure is bars) on both value axes.
    const shared = format.syncAxes ? syncRange(series.map((s) => s.data), { zeroBaseline: type !== "line" }) : null;
    const range = shared ? { min: shared.min, max: shared.max } : {};
    yAxis = [
      withName(valueAxisBase(range), yTitle || series[0]?.name, false),
      { ...withName(valueAxisBase({ position: "right", splitLine: { show: false }, ...range }), rightAxisTitle(series.filter((s) => !s.compare).map((s) => s.name)) || series[1]?.name, false), nameTruncate: { maxWidth: 160, ellipsis: "…" } }, // long lists of measure names end in an ellipsis (the legend has them in full)
    ];
  } else if (horizontal) {
    // Horizontal: value on x (bottom), category on y (left); inverse so the first category is on top.
    xAxis = withName(valueAxisBase(), xTitle, true);
    yAxis = { ...withName(categoryAxis, yTitle, false), inverse: true };
  } else {
    xAxis = withName(categoryAxis, xTitle, true);
    yAxis = withName(valueAxisBase(), yTitle, false);
  }

  const base = {
    textStyle: { fontFamily: c.font, color: c.label }, // text wears text tokens, never the series colour
    legend,
    grid: {
      left: 6 + (showLegend && pos === "left" ? 96 : 0),
      right: 18 + (showLegend && pos === "right" ? 96 : 0) + (dual ? 36 : 0),
      top: 18 + (showLegend && pos === "top" ? 18 : 0) + (yTitle || dual ? 18 : 0),
      bottom: 6 + (showLegend && pos === "bottom" ? 22 : 0) + (xTitle ? 24 : 0),
      containLabel: true,
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: type === "line" || type === "area" ? "line" : "shadow", lineStyle: { color: c.axis } },
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => {
        const arr = Array.isArray(p) ? p : [p];
        if (tooltipText) return customTip(tooltipText, tooltipFields, tooltipStyle, arr[0].dataIndex, Object.fromEntries(arr.map((d) => [String(d.seriesName), fmtVal(d.value)])));
        const head = `<span style="color:${c.muted}">${escapeHtml(String(arr[0].axisValueLabel ?? arr[0].name ?? ""))}</span>`;
        const lines = arr.map((d) =>
          `<br><span style="display:inline-block;width:8px;height:8px;border-radius:${c.radius}px;background:${d.color};margin-right:8px"></span>` +
          `<b>${escapeHtml(String(d.seriesName))}:</b> ${fmtVal(d.value)}`).join("");
        return head + lines + extraTooltip(tooltipExtra, arr[0].dataIndex, c); // custom tooltip fields
      },
    },
    xAxis,
    yAxis,
  };

  const step = lineStep(format.lineStyle); // false | "end" | "middle"
  const edge = markBorder(format.markBorder, c.muted); // the stroke of bars (and the lines' markers)
  const secondary = secondaryKind(format.secondaryType); // how a combo draws its right-axis measures
  base.series = series.map((s, i) => {
    // A comparison series wears its measure's colour, faded and dashed (line) or muted (bar).
    if (s.compare) {
      const color = colorFor(i - mainCount);
      const asLine = type === "line" || type === "area";
      return asLine
        ? { name: s.name, type: "line", step, yAxisIndex: seriesAxis(dual, i - mainCount), data: s.data, showSymbol: false, z: 1,
            lineStyle: { width: 2, type: "dashed", color, opacity: 0.7 }, itemStyle: { color, opacity: 0.7 }, emphasis: { focus: "series" } }
        : { name: s.name, type: "bar", data: s.data, barMaxWidth: 40,
            // Hatched as well as faded, so it reads as "the other period" without relying on colour.
            itemStyle: { color: c.muted, opacity: 0.55, borderRadius: horizontal ? [0, c.radius, c.radius, 0] : [c.radius, c.radius, 0, 0],
              decal: { symbol: "rect", symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: c.surface } },
            emphasis: { itemStyle: { opacity: 0.8 } } };
    }
    const color = colorFor(i, s.name);
    // line/area always draw as a line; in a combo the 1st measure is a bar and the rest are lines.
    const rightBars = isCombo && i >= 1 && secondary === "bar";
    const asLine = !rightBars && (type === "line" || type === "area" || (isCombo && i >= 1));
    if (asLine) {
      return {
        name: s.name, type: "line", step,
        yAxisIndex: seriesAxis(dual, i, isCombo),
        data: s.data,
        showSymbol: s.data.length <= 60 || format.markerSize != null, // dots only when they won't crowd (unless a size is chosen)
        symbol: markerSymbol(format.markerShape), symbolSize: markerSizeOr(format.markerSize, 8), // ≥8px markers (dataviz mark spec) unless Format → Marker size
        areaStyle: type === "area" || (isCombo && secondary === "area") ? { opacity: 0.18, color } : undefined,
        lineStyle: { width: 2, color },
        itemStyle: { color, ...(format.markBorder && format.markBorder !== "none" ? edge : {}) },
        label: dataLabel,
        emphasis: { focus: "series" },
      };
    }
    const stacked = type === "stacked";
    // Round the "growing" end of the bar: top for vertical, right for horizontal; none when stacked.
    const barRadius = stacked ? [0, 0, 0, 0] : (horizontal ? [0, c.radius, c.radius, 0] : [c.radius, c.radius, 0, 0]);
    // The "Other" bar (everything past the limit) wears the muted ink (≥ 3:1 on the surface, apart from
    // the series hue); its label says what it is.
    const otherItem = (v) => ({ value: v, itemStyle: { color: c.muted, borderRadius: barRadius, ...edge } });
    return {
      name: s.name, type: "bar",
      yAxisIndex: rightBars ? 1 : 0,
      stack: stacked ? "total" : undefined,
      // Colour-by-dimension: per-bar colours; otherwise the series colour.
      data: colorByDim
        ? s.data.map((v, di) => (di === otherIndex ? otherItem(v) : { value: v, itemStyle: { color: memberColor(labels[di], c.cat[di % c.cat.length]), borderRadius: barRadius, ...edge } }))
        : s.data.map((v, di) => (di === otherIndex ? otherItem(v) : v)),
      barMaxWidth: 40,
      itemStyle: { color, borderRadius: barRadius, ...edge },
      label: dataLabel,
      emphasis: { focus: "series", itemStyle: colorByDim ? { opacity: 0.85 } : { color, opacity: 0.85 } },
    };
  });
  if (analytics) addAnalytics(base, analytics, { c, fmtVal, horizontal });
  return base;
}

// Analytics overlays on a cartesian chart: a dashed reference line (labelled with its value), a
// shaded band (labelled), and a dotted trend line named at its end — each carries words, never colour alone.
function addAnalytics(base, a, { c, fmtVal, horizontal }) {
  const s0 = base.series[a.measure ?? 0]; // the reference line and band sit on their own measure's axis (the trend follows the first)
  if (!s0) return;
  const axis = horizontal ? "xAxis" : "yAxis";
  if (a.ref) {
    s0.markLine = { silent: true, symbol: "none", animation: false,
      lineStyle: { color: c.ink, type: "dashed", width: 1.5 },
      label: { formatter: `${a.ref.name}: ${fmtVal(a.ref.value)}`, color: c.label, fontFamily: c.font, position: horizontal ? "insideEndTop" : "insideEndTop" },
      data: [{ [axis]: a.ref.value }] };
  }
  if (a.band) {
    s0.markArea = { silent: true, animation: false, itemStyle: { color: c.grid, opacity: 0.7 },
      label: { show: true, formatter: `${a.band.name ?? "Band"} ${fmtVal(a.band.from)}–${fmtVal(a.band.to)}`, color: c.muted, fontFamily: c.font, position: "insideTopLeft" },
      data: [[{ [axis]: a.band.from }, { [axis]: a.band.to }]] };
  }
  if (a.trend) {
    base.series.push({ name: a.trend.name, type: "line", data: a.trend.data, showSymbol: false, z: 4, animation: false,
      lineStyle: { width: 2, type: "dotted", color: c.muted }, itemStyle: { color: c.muted },
      endLabel: { show: true, formatter: a.trend.short ?? a.trend.name, color: c.muted, fontFamily: c.font, fontSize: 14 },
      tooltip: { valueFormatter: fmtVal } });
    base.grid.right = (Number(base.grid.right) || 0) + 84; // room for the short end label
  }
}

// pie / donut — one dimension (slices) × one measure (size). Colour IS the encoding, so a legend
// shows by default (dataviz: identity never colour-alone; the legend supplies the labels).
function buildPie({ type, categories, series, format = {}, pointLabels, tooltipExtra, tooltipText, tooltipFields, tooltipStyle, otherIndex = -1 }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = (categories ?? []).map((l) => l ?? "—");
  const data = labels.map((name, i) => ({ name, value: series[0].data[i], ...(i === otherIndex ? { itemStyle: { color: c.muted } } : memberColors().has(name) ? { itemStyle: { color: memberColors().get(name) } } : {}) }));
  const { pos, legend } = legendFor(format, c, labels, true);
  const showLabels = !!format.dataLabels || !!pointLabels; // Label field forces slice labels on

  return {
    color: c.cat,
    textStyle: { fontFamily: c.font, color: c.label },
    legend,
    tooltip: {
      trigger: "item",
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => tooltipText
        ? customTip(tooltipText, tooltipFields, tooltipStyle, p.dataIndex, { [String(series[0].name)]: fmtVal(p.value), Percent: `${p.percent}%` })
        :
        `<span style="color:${c.muted}">${escapeHtml(String(p.name))}</span><br>` +
        `<b>${escapeHtml(String(series[0].name))}:</b> ${fmtVal(p.value)} (${p.percent}%)` +
        extraTooltip(tooltipExtra, p.dataIndex, c),
    },
    series: [{
      type: "pie",
      radius: type === "donut" ? ["45%", "72%"] : "72%",
      center: legend && (pos === "left" || pos === "right") ? ["42%", "52%"] : ["50%", "54%"],
      data,
      label: { show: showLabels, color: c.label, fontFamily: c.font,
        formatter: (p) => (pointLabels ? String(pointLabels[p.dataIndex] ?? "") : `${p.name}: ${fmtVal(p.value)}`) },
      labelLine: { show: showLabels },
      itemStyle: edgeOr(format.markBorder, c.muted, { borderColor: c.surface, borderWidth: 2 }),
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.2)" } },
    }],
  };
}

// scatter — two measures map to the X and Y value axes; dimension keys label the points. marks:
// `sizes` scales the symbol (bubble), `colorValues` ramps a continuous gradient (visualMap legend),
// `pointLabels` writes a field on each point, `tooltipExtra` appends field lines to the tooltip.
function buildScatter({ categories, series, format = {}, sizes, sizeName, colorValues, colorName, pointLabels, tooltipExtra, tooltipText, tooltipFields, tooltipStyle, symbol }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = (categories ?? []).map((l) => l ?? "—");
  const xName = format.xTitle || series[0]?.name || "x";
  const yName = format.yTitle || series[1]?.name || "y";
  const continuous = Array.isArray(colorValues);
  const colorByDim = !!format.colorByDimension && !continuous; // continuous colour wins over per-category
  // Each datum: [x, y, size?, colour?] — extra dims feed symbolSize / visualMap by index.
  const sizeDim = Array.isArray(sizes) ? 2 : -1;
  const colorDim = continuous ? (sizeDim >= 0 ? 3 : 2) : -1;
  const data = labels.map((name, i) => {
    const arr = [num(series[0].data[i]), num(series[1].data[i])];
    if (sizeDim >= 0) arr.push(num(sizes[i]));
    if (colorDim >= 0) arr.push(num(colorValues[i]));
    return { value: arr, name, ...(colorByDim ? { itemStyle: { color: memberColor(name, c.cat[i % c.cat.length]) } } : {}) };
  });
  const symbolSize = sizeDim >= 0 ? sizeScaler(sizes, (v) => v[sizeDim]) : markerSizeOr(format.markerSize, 14); // a Size field wins
  const visualMap = colorDim >= 0 ? continuousVisualMap(colorValues, colorDim, c, fmtVal, colorName) : undefined;

  return {
    textStyle: { fontFamily: c.font, color: c.label },
    grid: { left: 6, right: 18, top: 18, bottom: 6 + 24 + (visualMap ? 24 : 0), containLabel: true },
    visualMap,
    tooltip: {
      trigger: "item",
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => tooltipText
        ? customTip(tooltipText, tooltipFields, tooltipStyle, p.dataIndex, { [xName]: fmtVal(p.value[0]), [yName]: fmtVal(p.value[1]),
          ...(sizeDim >= 0 ? { [sizeName || "size"]: fmtVal(p.value[sizeDim]) } : {}),
          ...(colorDim >= 0 ? { [colorName || "colour"]: fmtVal(p.value[colorDim]) } : {}) })
        :
        `<span style="color:${c.muted}">${escapeHtml(String(p.name ?? ""))}</span><br>` +
        `<b>${escapeHtml(xName)}:</b> ${fmtVal(p.value[0])}<br><b>${escapeHtml(yName)}:</b> ${fmtVal(p.value[1])}` +
        (sizeDim >= 0 ? `<br><b>${escapeHtml(sizeName || "size")}:</b> ${fmtVal(p.value[sizeDim])}` : "") +
        (colorDim >= 0 ? `<br><b>${escapeHtml(colorName || "colour")}:</b> ${fmtVal(p.value[colorDim])}` : "") +
        extraTooltip(tooltipExtra, p.dataIndex, c),
    },
    xAxis: {
      type: "value", name: xName, nameLocation: "middle", nameGap: 28,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600 },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.muted, formatter: fmtVal },
    },
    yAxis: {
      type: "value", name: yName, nameLocation: "end", nameGap: 12,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600, align: "left" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.muted, formatter: fmtVal },
    },
    series: [{
      type: "scatter", data, symbolSize, symbol: symbol || "circle", // square/circle marks
      itemStyle: { ...(colorByDim || continuous ? {} : { color: c.series, opacity: 0.8 }), ...pointEdge(format, c) },
      label: (pointLabels || format.dataLabels)
        ? { show: true, position: "top", color: c.muted, fontFamily: c.font, fontSize: 14,
            formatter: (p) => (pointLabels ? String(pointLabels[p.dataIndex] ?? "") : String(p.name ?? "")) }
        : { show: false },
      emphasis: { focus: "self", itemStyle: { borderColor: c.ink, borderWidth: 1 } },
    }],
  };
}

// scatterShapes — one scatter series per Shape-dimension value, each a distinct symbol so
// identity survives greyscale (shape is a non-colour channel). X/Y are the two shelf measures; an
// optional Size dim scales the symbol. spec: { groups:[{name, points:[{value:[x,y,size?], name}]}],
// xName, yName, hasSize, sizeName, format }.
const SHAPE_SYMBOLS = ["circle", "rect", "triangle", "diamond", "roundRect", "pin", "arrow"];
function buildScatterShapes({ groups, xName, yName, hasSize, sizeName, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const allSizes = hasSize ? groups.flatMap((g) => g.points.map((p) => p.value[2])) : null;
  const symbolSize = hasSize ? sizeScaler(allSizes, (v) => v[2]) : markerSizeOr(format.markerSize, 12);
  const names = groups.map((g) => g.name);
  const { show, pos, legend } = legendFor(format, c, names, true);
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    legend,
    grid: {
      left: 6 + (show && pos === "left" ? 96 : 0), right: 18 + (show && pos === "right" ? 96 : 0),
      top: 24 + (show && pos === "top" ? 18 : 0), bottom: 6 + 24 + (show && pos === "bottom" ? 22 : 0), containLabel: true,
    },
    tooltip: {
      trigger: "item", backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) =>
        `<span style="color:${c.muted}">${escapeHtml(String(p.seriesName))}${p.data && p.data.name ? " · " + escapeHtml(String(p.data.name)) : ""}</span><br>` +
        `<b>${escapeHtml(xName)}:</b> ${fmtVal(p.value[0])}<br><b>${escapeHtml(yName)}:</b> ${fmtVal(p.value[1])}` +
        (hasSize ? `<br><b>${escapeHtml(sizeName || "size")}:</b> ${fmtVal(p.value[2])}` : ""),
    },
    xAxis: {
      type: "value", name: xName, nameLocation: "middle", nameGap: 28,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600 },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, formatter: fmtVal },
    },
    yAxis: {
      type: "value", name: yName, nameLocation: "end", nameGap: 12,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600, align: "left" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, formatter: fmtVal },
    },
    series: groups.map((g, i) => ({
      name: g.name, type: "scatter", symbol: SHAPE_SYMBOLS[i % SHAPE_SYMBOLS.length], symbolSize,
      data: g.points, itemStyle: { color: c.cat[i % c.cat.length], opacity: 0.85, ...pointEdge(format, c) },
      emphasis: { focus: "series", itemStyle: { borderColor: c.ink, borderWidth: 1 } },
    })),
  };
}

// heatmap — two dimensions on the axes, one measure as colour intensity. Colour IS a channel
// here, so a continuous visualMap legend accompanies it (identity also comes from the x/y labels).
// spec: { xCats:string[], yCats:string[], cells:[[xi, yi, value]], format }
function buildHeatmap({ xCats, yCats, cells, format = {} }) {
  const live = drawing ?? { instance: null }; // this container's state, read when ECharts sizes the circles
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const circles = format.heatmapShape === "circle";
  // The cell separator stays the surface-coloured hairline unless a border is chosen.
  const cellEdge = format.markBorder && format.markBorder !== "none" ? markBorder(format.markBorder, c.muted) : { borderColor: c.surface, borderWidth: 1 };
  const vals = cells.map((d) => d[2]).filter((v) => v != null);
  const { min, max } = colourScaleRange(vals, true);
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    tooltip: {
      position: "top",
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) =>
        `<span style="color:${c.muted}">${escapeHtml(String(xCats[p.value[0]] ?? ""))} · ${escapeHtml(String(yCats[p.value[1]] ?? ""))}</span><br>` +
        `<b>${fmtVal(p.value[2])}</b>`,
    },
    grid: { left: 6, right: 12, top: 12, bottom: 60, containLabel: true },
    xAxis: {
      type: "category", data: xCats, splitArea: { show: !circles },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      axisLabel: { color: c.muted, hideOverlap: true },
    },
    yAxis: {
      type: "category", data: yCats, splitArea: { show: !circles },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      axisLabel: { color: c.muted },
    },
    visualMap: {
      min, max, calculable: true, dimension: 2, orient: "horizontal", left: "center", bottom: 6,
      inRange: { color: c.ramp }, // single-hue sequential (soft → saturated), tokens; a pinned end saturates
      text: outOfRangeNote() ? [outOfRangeNote(), ""] : undefined,
      textStyle: { color: c.muted, fontFamily: c.font }, formatter: (v) => fmtVal(v),
    },
    series: [circles
      // Circles = scatter marks on the same category grid, sized by the cell, coloured by the
      // value through the same visualMap (dimension 2); the value label sits inside each circle.
      ? {
        // Empty cells draw nothing; the size is re-read from the live chart on every draw, so it follows the pane.
        type: "scatter", data: circleCells(cells), symbol: "circle",
        symbolSize: () => format.markerSize != null ? markerSizeOr(format.markerSize, 6) : circleSize((live.instance?.getWidth() ?? 800) - HEATMAP_GUTTER.x, (live.instance?.getHeight() ?? 450) - HEATMAP_GUTTER.y, xCats.length, yCats.length),
        label: { show: !!format.dataLabels, color: c.ink, fontFamily: c.font, formatter: (p) => fmtVal(p.value[2]) },
        itemStyle: { opacity: 1, ...cellEdge },
        emphasis: { itemStyle: { borderColor: c.ink, borderWidth: 2 } },
      }
      : {
        type: "heatmap", data: cells,
        label: { show: !!format.dataLabels, color: c.ink, fontFamily: c.font, formatter: (p) => fmtVal(p.value[2]) },
        itemStyle: cellEdge,
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(0,0,0,0.25)" } },
      }],
  };
}

// treemap — nested rectangles sized by a measure; one or two dimensions form the hierarchy.
// spec: { tree:[{ name, value, children? }], format }
function buildTreemap({ tree, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  // Label ink per tile: the tile colour is the top-level node's category colour (by index), and every
  // descendant keeps that hue, so pick the ink with the best contrast against it (>= 4.5:1).
  const inks = [c.ink, c.surface, "#000000", "#ffffff"];
  const withInk = (node, ink) => ({ ...node, label: { ...node.label, color: ink }, ...(node.children ? { children: node.children.map((k) => withInk(k, ink)) } : {}) });
  const data = tree.map((n, i) => withInk(n, pickInk(c.cat[i % c.cat.length], inks)));
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    tooltip: {
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => `<span style="color:${c.muted}">${escapeHtml(String(p.name))}</span><br><b>${fmtVal(p.value)}</b>`,
    },
    series: [{
      type: "treemap", data, roam: false, nodeClick: false,
      breadcrumb: { show: false },
      label: { show: true, fontFamily: c.font, formatter: (p) => p.name },
      itemStyle: { ...edgeOr(format.markBorder, c.muted, { borderColor: c.surface, borderWidth: 2 }), gapWidth: 2 },
      levels: [{ color: c.cat, colorMappingBy: "index" }],
    }],
  };
}

// histogram — equal-width numeric bins from the server; a gapless bar of counts.
// spec: { bins:[{x0, x1, count}], format }
function buildHistogram({ bins, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = bins.map((b) => `${fmtVal(b.x0)}–${fmtVal(b.x1)}`);
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    grid: { left: 6, right: 18, top: 18, bottom: 6 + (format.xTitle ? 24 : 0), containLabel: true },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => `<span style="color:${c.muted}">${escapeHtml(String((Array.isArray(p) ? p[0] : p).name))}</span><br><b>${fmtVal((Array.isArray(p) ? p[0] : p).value)}</b>`,
    },
    xAxis: {
      type: "category", data: labels,
      name: format.xTitle || undefined, nameLocation: "middle", nameGap: 28,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600 },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      axisLabel: { color: c.muted, hideOverlap: true },
    },
    yAxis: {
      type: "value", name: format.yTitle || "count", nameLocation: "end", nameGap: 12,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600, align: "left" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, formatter: fmtVal },
    },
    series: [{
      type: "bar", data: bins.map((b) => b.count), barCategoryGap: "0%",
      itemStyle: { color: c.series, borderColor: c.surface, borderWidth: 1 },
      label: { show: !!format.dataLabels, position: "top", color: c.label, fontFamily: c.font, fontSize: 14, formatter: (p) => fmtVal(p.value) },
      emphasis: { itemStyle: { opacity: 0.85 } },
    }],
  };
}

// boxplot — five-number summary per group from the server.
// spec: { boxes:[{ label, min, q1, median, q3, max }], format }
function buildBoxplot({ boxes, outliers = [], format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = boxes.map((b) => (b.label == null ? "—" : String(b.label)));
  const data = boxData(boxes);
  const points = outlierPoints(boxes, outliers);
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    grid: { left: 6, right: 18, top: 18, bottom: 6 + (format.xTitle ? 24 : 0), containLabel: true },
    tooltip: {
      trigger: "item",
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => {
        // Read the five-number summary from the source row by index — robust to ECharts' internal
        // value layout for boxplot series.
        if (p.seriesType === "scatter") return `<span style="color:${c.muted}">${escapeHtml(labels[p.value[0]] ?? "")}</span><br>outlier <b>${fmtVal(p.value[1])}</b>`;
        const b = boxes[p.dataIndex] ?? {};
        return `<span style="color:${c.muted}">${escapeHtml(labels[p.dataIndex] ?? "")}</span><br>` +
          `max ${fmtVal(b.max)}<br>Q3 ${fmtVal(b.q3)}<br>median <b>${fmtVal(b.median)}</b><br>Q1 ${fmtVal(b.q1)}<br>min ${fmtVal(b.min)}`;
      },
    },
    xAxis: {
      type: "category", data: labels,
      name: format.xTitle || undefined, nameLocation: "middle", nameGap: 28,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600 },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      axisLabel: { color: c.muted, hideOverlap: true },
    },
    yAxis: {
      type: "value", name: format.yTitle || undefined, nameLocation: "end", nameGap: 12,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600, align: "left" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, formatter: fmtVal },
    },
    series: [{
      type: "boxplot", data,
      itemStyle: { color: c.brandSoft, borderColor: c.series },
      emphasis: { itemStyle: { borderColor: c.ink } },
    }, ...(points.length ? [{
      // Outliers: hollow rings, so they read apart from the box without relying on colour.
      type: "scatter", data: points, symbol: "circle", symbolSize: 8,
      itemStyle: { color: c.surface, borderColor: c.series, borderWidth: 1.5 },
      emphasis: { itemStyle: { borderColor: c.ink } },
    }] : [])],
  };
}

// --- chart types ----------------------------------------------------------
const tipBox = (c) => ({ backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1, textStyle: { color: c.ink, fontFamily: c.font } });
const valueAxis = (c, fmtVal, extra = {}) => ({
  type: "value", axisLine: { show: false }, axisTick: { show: false },
  splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, formatter: fmtVal }, ...extra,
});
// A point mark's stroke — nothing added while the setting is None (keeps the old look).
const pointEdge = (format, c) => (format.markBorder && format.markBorder !== "none" ? markBorder(format.markBorder, c.muted) : {});
const catAxis = (c, data, extra = {}) => ({
  type: "category", data, axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
  axisLabel: { color: c.muted, hideOverlap: true }, ...extra,
});

/**
 * Waterfall steps: each category's value is a change from the running total, then a final Total bar.
 * Returns [{ name, start, end, kind: up | down | total }] (pure — exported for tests).
 */
export function waterfallSteps(categories, values) {
  const steps = [];
  let run = 0;
  categories.forEach((name, i) => {
    const v = Number(values[i]);
    const d = Number.isFinite(v) ? v : 0;
    steps.push({ name, start: run, end: run + d, kind: d < 0 ? "down" : "up", value: d });
    run += d;
  });
  steps.push({ name: "Total", start: 0, end: run, kind: "total", value: run });
  return steps;
}

// waterfall — floating bars drawn as a custom series (so a running total below zero still works);
// increases blue, decreases orange, Total muted — each named in the legend and signed in its label.
function buildWaterfall({ categories, series, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const steps = waterfallSteps(categories ?? [], series[0]?.data ?? []);
  const colour = { up: c.cat[0], down: c.cat[5], total: c.muted };
  const names = { up: "Increase", down: "Decrease", total: "Total" };
  const signed = (v) => (v > 0 ? `+${fmtVal(v)}` : v < 0 ? `−${fmtVal(-v)}` : fmtVal(v));
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    legend: { top: 0, left: "center", data: ["Increase", "Decrease", "Total"], textStyle: { color: c.label, fontFamily: c.font }, icon: "roundRect" },
    grid: { left: 6, right: 18, top: 36, bottom: 6, containLabel: true },
    tooltip: { trigger: "item", ...tipBox(c),
      formatter: (p) => { const st = steps[p.dataIndex]; return st ? `<span style="color:${c.muted}">${escapeHtml(String(st.name))}</span><br><b>${st.kind === "total" ? fmtVal(st.value) : signed(st.value)}</b>${st.kind === "total" ? "" : `<br>running total ${fmtVal(st.end)}`}` : ""; } },
    xAxis: catAxis(c, steps.map((st) => st.name)),
    yAxis: valueAxis(c, fmtVal),
    series: [
      { type: "custom", name: "steps", data: steps.map((st, i) => [i, st.start, st.end]),
        encode: { x: 0, y: [1, 2] },
        renderItem: (params, api) => {
          const st = steps[params.dataIndex];
          const a = api.coord([api.value(0), api.value(1)]), b = api.coord([api.value(0), api.value(2)]);
          const w = Math.min(40, api.size([1, 0])[0] * 0.6);
          const top = Math.min(a[1], b[1]), h = Math.max(1, Math.abs(a[1] - b[1]));
          return {
            type: "group", children: [
              { type: "rect", shape: { x: a[0] - w / 2, y: top, width: w, height: h, r: 2 }, style: { fill: colour[st.kind] } },
              { type: "text", style: { text: st.kind === "total" ? fmtVal(st.value) : signed(st.value), x: a[0], y: top - 4,
                  align: "center", verticalAlign: "bottom", fill: c.label, font: `14px ${c.font}` } },
            ],
          };
        } },
      // Legend swatches only (no data).
      ...["up", "down", "total"].map((k) => ({ type: "bar", name: names[k], data: [], itemStyle: { color: colour[k] } })),
    ],
  };
}

// funnel — stages by value, widest first; each stage labelled with its value and % of the first.
function buildFunnel({ categories, series, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  // Each stage's label ink is picked for contrast against its own palette colour (≥ 4.5:1).
  const inks = [c.ink, c.surface, "#000000", "#ffffff"];
  const data = (categories ?? []).map((name, i) => ({ name, value: Number(series[0].data[i]) || 0,
    label: { color: pickInk(c.cat[i % c.cat.length], inks) } }));
  const top = Math.max(...data.map((d) => d.value), 0) || 1;
  const { legend } = legendFor(format, c, data.map((d) => d.name), false);
  return {
    color: c.cat, textStyle: { fontFamily: c.font, color: c.label }, legend,
    tooltip: { trigger: "item", ...tipBox(c), formatter: (p) => `<span style="color:${c.muted}">${escapeHtml(String(p.name))}</span><br><b>${fmtVal(p.value)}</b> (${((p.value / top) * 100).toFixed(1)}% of the first)` },
    series: [{
      type: "funnel", sort: "descending", gap: 2, left: "10%", right: "10%", top: legend ? 36 : 12, bottom: 12, minSize: "8%",
      data, itemStyle: edgeOr(format.markBorder, c.muted, { borderColor: c.surface, borderWidth: 1 }),
      label: { show: true, position: "inside", fontFamily: c.font, lineHeight: 16,
        formatter: (p) => `${p.name}\n${fmtVal(p.value)} · ${((p.value / top) * 100).toFixed(0)}%` },
    }],
  };
}

/** A round axis maximum just above `v` (1, 2, 2.5, 5 × 10^n). */
export function niceMax(v) {
  const n = Math.abs(Number(v)) || 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

// gauge — one value on an arc from 0 to the Target (Format) or a round maximum; the value and "of
// <target>" are written in the middle, so the arc never carries the meaning alone.
function buildGauge({ value, name, target, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const v = Number(value) || 0;
  const max = target != null && Number(target) > 0 ? Number(target) : niceMax(v);
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    tooltip: { ...tipBox(c), formatter: () => `${escapeHtml(String(name))}: <b>${fmtVal(v)}</b>${target != null ? ` of ${fmtVal(target)}` : ""}` },
    series: [{
      type: "gauge", min: 0, max, startAngle: 210, endAngle: -30, radius: "88%", center: ["50%", "58%"],
      progress: { show: true, width: 16, itemStyle: { color: target != null && v >= max ? c.cat[4] : c.series } },
      axisLine: { lineStyle: { width: 16, color: [[1, c.grid]] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { distance: 22, color: c.muted, fontFamily: c.font, formatter: (x) => (x === 0 || x === max ? fmtVal(x) : "") },
      title: { offsetCenter: [0, "34%"], color: c.label, fontFamily: c.font, fontSize: 14 },
      detail: { offsetCenter: [0, "4%"], valueAnimation: true, color: c.ink, fontFamily: c.font, fontSize: 24, fontWeight: 600,
        formatter: () => (target != null ? `${fmtVal(v)}\n{t|${((v / max) * 100).toFixed(0)}% of ${fmtVal(target)}}` : fmtVal(v)),
        rich: { t: { fontSize: 14, color: c.muted, fontWeight: 400, padding: [6, 0, 0, 0] } } },
      data: [{ value: Math.min(v, max), name }],
    }],
  };
}

// bullet — per category, the actual value (a dark bar) over three bands (< 50 %, 50–75 %, 75–100 % of
// target) with the target as a tick. Horizontal, first category on top.
function buildBullet({ categories, values, target, targets, name, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const cats = categories ?? [];
  const vals = (values ?? []).map((v) => Number(v) || 0);
  const ts = targets ?? cats.map(() => Number(target)); // one target per category, or the fixed one
  const max = niceMax(Math.max(...ts.map((t) => (t ?? 0) * 1.1), ...vals, 1e-9));
  const bands = [["Below 50% of target", 0, 0.5, 0.12], ["50–75%", 0.5, 0.75, 0.22], ["75–100%", 0.75, 1, 0.32]];
  const pctText = (i) => (ts[i] ? ` (${((vals[i] / ts[i]) * 100).toFixed(0)}%)` : "");
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    legend: { top: 0, left: "center", textStyle: { color: c.label, fontFamily: c.font }, data: [name, "Target", ...bands.map((b) => b[0])] },
    grid: { left: 6, right: 24, top: 36, bottom: 6, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, ...tipBox(c),
      formatter: (p) => { const i = (Array.isArray(p) ? p[0] : p).dataIndex; return `<span style="color:${c.muted}">${escapeHtml(String(cats[i] ?? ""))}</span><br><b>${escapeHtml(String(name))}:</b> ${fmtVal(vals[i])}<br><b>Target:</b> ${ts[i] == null ? "—" : fmtVal(ts[i])}${pctText(i)}`; } },
    xAxis: valueAxis(c, fmtVal, { max }),
    yAxis: catAxis(c, cats, { inverse: true }),
    series: [
      ...bands.map(([label, from, to, op]) => ({ type: "bar", name: label, stack: "bands", silent: true, barWidth: "60%",
        data: bandsFor(ts, from, to), itemStyle: { color: c.muted, opacity: op } })),
      { type: "bar", name, data: vals, barWidth: "24%", barGap: "-70%", z: 3, itemStyle: { color: c.ink } },
      { type: "scatter", name: "Target", data: cats.map((_, i) => (ts[i] == null ? null : [ts[i], i])), symbol: "rect", symbolSize: [3, 26], z: 4,
        itemStyle: { color: c.series } },
    ],
  };
}

// gantt — one horizontal bar per row from its start to start + length (days for a date start), first row on
// top; the length is written at the bar's end and named in the tooltip, so the bar's colour carries nothing.
function buildGantt({ categories, gantt, name, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const { bars, isDate, hasTime } = gantt;
  const at = (v) => (isDate ? ganttTime(v, hasTime) : fmtVal(v));
  const len = (b) => (isDate ? `${fmtVal(b.duration)} ${b.duration === 1 ? "day" : "days"}` : fmtVal(b.duration));
  const label = name || "Length";
  const axisTime = ganttAxisTime(bars, hasTime);
  return {
    color: [c.cat[0]],
    textStyle: { fontFamily: c.font, color: c.label },
    legend: { top: 0, left: "center", data: [label], selectedMode: false, textStyle: { color: c.label, fontFamily: c.font }, icon: "roundRect" },
    grid: { left: 6, right: ganttLabelMargin(bars.map(len)), top: 36, bottom: 6, containLabel: true },
    tooltip: { trigger: "item", ...tipBox(c),
      formatter: (p) => { const b = bars[p.dataIndex]; return b ? `<span style="color:${c.muted}">${escapeHtml(String(b.name ?? ""))}</span><br>${at(b.start)} → ${at(b.end)}<br><b>${escapeHtml(label)}:</b> ${len(b)}` : ""; } },
    xAxis: valueAxis(c, isDate ? undefined : fmtVal, isDate
      ? { type: "time", axisLabel: { color: c.muted, formatter: (v) => ganttTime(v, axisTime), hideOverlap: true } } : { scale: true }),
    yAxis: catAxis(c, categories ?? [], { inverse: true }),
    series: [
      { type: "custom", name: label, data: bars.map((b) => [b.i, b.start, b.end]), encode: { x: [1, 2], y: 0 },
        renderItem: (params, api) => {
          const b = bars[params.dataIndex];
          const a = api.coord([api.value(1), api.value(0)]), e = api.coord([api.value(2), api.value(0)]);
          const h = Math.min(28, api.size([0, 1])[1] * 0.6);
          return { type: "group", children: [
            { type: "rect", shape: { x: a[0], y: a[1] - h / 2, width: Math.max(2, e[0] - a[0]), height: h, r: 2 }, style: { fill: c.cat[0] } },
            { type: "text", style: { text: len(b), x: Math.max(e[0], a[0] + 2) + 4, y: a[1], align: "left", verticalAlign: "middle", fill: c.label, font: `14px ${c.font}` } },
          ] };
        } },
    ],
  };
}

// sankey — flows from the first dimension's members (left) to the second's (right), width = measure.
// Node ids carry a side prefix so a value present on both sides stays two nodes; labels strip it.
function buildSankey({ links, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const nodes = [...new Set(links.flatMap((l) => [l.source, l.target]))].map((n) => ({ name: n }));
  const label = (id) => String(id).slice(2);
  return {
    color: c.cat, textStyle: { fontFamily: c.font, color: c.label },
    tooltip: { trigger: "item", ...tipBox(c),
      formatter: (p) => (p.dataType === "edge"
        ? `${escapeHtml(label(p.data.source))} → ${escapeHtml(label(p.data.target))}<br><b>${fmtVal(p.data.value)}</b>`
        : `${escapeHtml(label(p.name))}<br><b>${fmtVal(p.value)}</b>`) },
    series: [{
      type: "sankey", left: 8, right: 120, top: 12, bottom: 12, nodeGap: 10, nodeWidth: 14, draggable: false,
      emphasis: { focus: "adjacency" }, data: nodes, links,
      label: { color: c.label, fontFamily: c.font, formatter: (p) => label(p.name) },
      lineStyle: { color: "gradient", opacity: 0.35, curveness: 0.5 },
      itemStyle: { borderColor: c.surface, borderWidth: 1 },
    }],
  };
}

/** Grid layout for n small-multiple panels in a w × h box: { cols, rows } close to the box's shape. */
export function multiplesGrid(n, w = 4, h = 3) {
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * w) / h)) || 1));
  return { cols, rows: Math.ceil(n / cols) };
}

// small multiples — one mini line chart per member of the first dimension, the second dimension along
// each x axis, all panels on one shared y scale so their heights compare honestly.
function buildMultiples({ panels, xCats, seriesNames, format = {}, width = 800, height = 450 }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const { cols, rows } = multiplesGrid(panels.length, width, height);
  const all = panels.flatMap((p) => p.series.flatMap((s) => s)).map(Number).filter(Number.isFinite);
  const yMax = all.length ? niceMax(Math.max(...all, 0)) : 1;
  const yMin = all.length && Math.min(...all) < 0 ? -niceMax(-Math.min(...all)) : 0;
  const cw = 100 / cols, rh = 100 / rows;
  const titles = [], grids = [], xAxes = [], yAxes = [], series = [];
  panels.forEach((p, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    titles.push({ text: p.name, left: `${col * cw + 1}%`, top: `${row * rh}%`, textStyle: { color: c.label, fontFamily: c.font, fontSize: 14, fontWeight: 600 } });
    grids.push({ left: `${col * cw + 3}%`, width: `${cw - 5}%`, top: `${row * rh + 5}%`, height: `${rh - 12}%`, containLabel: true });
    xAxes.push({ ...catAxis(c, xCats), gridIndex: i, axisLabel: { color: c.muted, hideOverlap: true, fontSize: 14 } });
    yAxes.push({ ...valueAxis(c, fmtVal), gridIndex: i, min: yMin, max: yMax, splitNumber: 2, axisLabel: { color: c.muted, formatter: fmtVal, fontSize: 14, show: col === 0 } });
    p.series.forEach((data, si) => series.push({
      type: "line", name: seriesNames[si], xAxisIndex: i, yAxisIndex: i, data, showSymbol: data.length <= 30, symbolSize: 5,
      lineStyle: { width: 1.5, color: seriesNames.length > 1 ? c.cat[si % c.cat.length] : c.series },
      itemStyle: { color: seriesNames.length > 1 ? c.cat[si % c.cat.length] : c.series },
    }));
  });
  return {
    textStyle: { fontFamily: c.font, color: c.label }, title: titles, grid: grids, xAxis: xAxes, yAxis: yAxes, series,
    legend: seriesNames.length > 1 ? { bottom: 0, left: "center", textStyle: { color: c.label, fontFamily: c.font } } : undefined,
    tooltip: { trigger: "axis", ...tipBox(c), valueFormatter: fmtVal },
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

// --- marks helpers ------------------------------------------------------
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// A symbol-size function mapping a datum's magnitude onto an 8–36px range (bubble scatter).
function sizeScaler(values, accessor) {
  const nums = (values ?? []).map((v) => Number(v) || 0);
  const min = Math.min(...nums, 0), max = Math.max(...nums, 1), span = (max - min) || 1;
  return (val) => { const v = accessor ? accessor(val) : (Number(val) || 0); return 8 + ((v - min) / span) * (36 - 8); };
}
// The scale's ends: the data span unless Format pinned one.
// Unpinned, a heatmap keeps its plain data span (`plain`); a scatter always gets a non-empty one.
const colourPinned = () => drawing?.colorMin != null || drawing?.colorMax != null;
const colourScaleRange = (nums, plain = false) => {
  if (plain && !colourPinned()) { const v = nums.filter((x) => Number.isFinite(x)); return { min: v.length ? Math.min(...v) : 0, max: v.length ? Math.max(...v) : 1 }; }
  return rangeOf(nums, drawing?.colorMin, drawing?.colorMax);
};
// A pinned end saturates: values beyond it take that end's colour (the visualMap clamps), so a pin never reads as "missing".
const outOfRangeNote = () => (colourPinned() ? "beyond range: end colour" : "");
// A continuous visualMap (the gradient legend) over `values`, coloured on the single-hue token ramp.
function continuousVisualMap(values, dimension, c, fmtVal, name) {
  const { min, max } = colourScaleRange((values ?? []).map((v) => Number(v)));
  return {
    type: "continuous", min, max, dimension, calculable: true,
    orient: "horizontal", left: "center", bottom: 0,
    inRange: { color: c.ramp }, 
    text: name || colourPinned() ? [[name ? String(name) : "", outOfRangeNote()].filter(Boolean).join(" · "), ""] : undefined,
    textStyle: { color: c.muted, fontFamily: c.font }, formatter: (v) => fmtVal(v),
  };
}
// The user's tooltip template → safe HTML. `measures` maps a measure name → its formatted value for
// this mark; group-by / mark fields come from `tooltipFields` ([{ name, values }] by dataIndex).
function customTip(text, tooltipFields, style, dataIndex, measures) {
  const dims = new Map((tooltipFields ?? []).map((f) => [f.name, f.values?.[dataIndex]]));
  return tooltipHtml(text, (name) => (Object.prototype.hasOwnProperty.call(measures, name) ? measures[name] : dims.get(name)), style);
}
// Extra tooltip lines for the Tooltip encoding: one "<field>: <value>" per chosen field.
function extraTooltip(tooltipExtra, dataIndex, c) {
  if (!Array.isArray(tooltipExtra) || !tooltipExtra.length) return "";
  return tooltipExtra
    .map((t) => `<br><span style="color:${c.muted}">${escapeHtml(String(t.name))}:</span> ${escapeHtml(String(t.values?.[dataIndex] ?? ""))}`)
    .join("");
}
