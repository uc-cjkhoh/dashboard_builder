import { makeValueFormatter } from "../Core/format.js";
import { ACCENTS, PALETTES } from "../Core/theme-model.js";
import { fontToken } from "./font-model.js";
import { pickInk } from "./contrast.js";
import { orderedPalette } from "./colour-model.js";
import { DIV_FALLBACK, DIV_HUE_FALLBACK, divergingColours, divergingRange, effectiveScale, fullRangeRamp, rampColours, rangeOf, stepPieces, stepColours, stepIndexOf, positionOf, mixHex } from "./colour-scale-model.js";
import { sizeRange, barThickness, markerSizeFor, drawsSize, lineSizeMode, measureCue } from "./mark-channel-model.js";
import { sizeScaleOf, measureShareFn, memberShareFn, sizeLegendText, lineWidthFor } from "./size-scale-model.js";
import { tooltipHtml } from "./tooltip-model.js";
import { tipLookup } from "./tooltip-formats.js";
import { lineStep, lineDash, comparisonDash, effectivePattern, trendDash, linesTakeStyle } from "./line-style-model.js";
import { markerPlan } from "./line-marker-model.js";
import { syncRange, secondaryKind, dualAxisOn, rightAxisTitle, seriesAxis } from "./axis-sync-model.js";
import { markBorder, markerSizeOr, markerSymbol, edgeOr, strokeOf, borderInk } from "./mark-style-model.js";
import { circleSize, circleCells, HEATMAP_GUTTER, LABEL_FONT, cellSizeOf, labelsShown } from "./heatmap-model.js";
import { bandsFor } from "./bullet-model.js";
import { ganttTime, ganttAxisTime, ganttLabelMargin } from "./gantt-model.js";
import { boxData, outlierPoints } from "./box-model.js";
import { chartFit, markCount, applyFitMode, rotatedLabelCap, FIT } from "./chart-fit.js";
import { applySelectionDim } from "./selection-dim.js";
import { shapeSymbol, symbolAt } from "./shape-model.js";
import { labelMask, labelPositionSymbol } from "./label-marks-model.js";
import { applyMarkOpacity, markOpacityOf, withAlpha, OPACITY_TYPES, ANALYTICS_ID } from "./mark-opacity-model.js";
import { dateFitMode } from "./date-labels.js";
import { histogramLabel } from "./chart-polish.js";
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
  const rampTk = { divLow: t("--chart-div-low", DIV_FALLBACK.low), divHigh: t("--chart-div-high", DIV_FALLBACK.high), accent: t("--accent", ACCENTS.signal.light.accent), accentSoft: t("--accent-soft", ACCENTS.signal.light.soft), surface: t("--surface", "#ffffff"), ink: t("--ink", "#1c1719"), cat: catFallback.map((hex, i) => t(`--chart-cat-${i + 1}`, hex)), hues: Object.fromEntries(Object.entries(DIV_HUE_FALLBACK).map(([h, hex]) => [h, t(`--chart-div-${h}`, hex)])) };
  return {
    series: t("--chart-series", ACCENTS.signal.light.accent),
    cat,
    axis: t("--chart-axis", "#d9cfd1"),
    grid: t("--chart-grid", "#ebe4e5"),
    label: t("--chart-label", "#423a3d"),
    muted: t("--chart-muted", "#6b6165"),
    surface: t("--surface", "#ffffff"),
    ink: t("--ink", "#1c1719"),
    font: t(fontToken(drawing?.font) ?? "--font", "system-ui, sans-serif"),
    radius: parseFloat(t("--r", "8")) || 8, // the one corner radius (golden rule 11)
    // Brand stops for the sequential heatmap ramp (single-hue soft→saturated, token-driven).
    brand: t("--accent", ACCENTS.signal.light.accent),
    brandSoft: t("--accent-soft", ACCENTS.signal.light.soft),
    // continuous low -> high: the chosen hue from the accent pair or a categorical token
    ramp: drawing?.colorScale === "diverging" ? divergingColours(rampTk, reversed(), drawing?.colorPair, drawing?.colorAuto === true) : rampColours(drawing?.colorRamp, rampTk, reversed()),
  };
}

// The values the continuous colour scale reads for `spec` (a colour measure, a heatmap's cells, a treemap's leaves) — what Automatic looks at.
function colourValuesOf(spec) {
  if (Array.isArray(spec.colorValues)) return spec.colorValues;
  if (spec.type === "heatmap") return (spec.cells ?? []).map((d) => d[2]);
  if (spec.type === "treemap") { const out = []; const walk = (ns) => (ns ?? []).forEach((n) => (n.children ? walk(n.children) : out.push(n.colour))); walk(spec.tree); return out; }
  return [];
}
/** The continuous colour scale the chart in `container` drew with ("sequential" or "diverging"): Automatic resolved against its data. */
export function resolvedColourScale(container) { return stateOf(container).colorScale ?? "sequential"; }

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
  st.font = spec.format?.font;
  st.colorSteps = spec.format?.colorSteps ?? 0;
  st.colorScale = effectiveScale(spec.format?.colorScale, colourValuesOf(spec)); // Automatic resolves here, once, against the values the scale reads: nothing below sees "auto"
  st.colorAuto = spec.format?.colorScale === "auto" && st.colorScale === "diverging"; // an Automatic scale that resolved to Diverging has a visible neutral centre (D110)
  st.colorFullRange = spec.format?.colorFullRange === true;
  st.colorPair = spec.format?.colorPair; st.colorCentre = spec.format?.colorCentre ?? null;
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
    if (OPACITY_TYPES.has(spec.type)) option = applyMarkOpacity(option, markOpacityOf(spec.format)); // only the types whose Format offers the control (a stale setting on a Gauge is not applied) // Format → Opacity multiplies every mark's own opacity (after the dim, so a faded mark stays fainter than a kept one)
    if (spec.type !== "multiples") showEveryCategory(option, fit.rotate, fit, paneHeight()); // panels keep their own sparse labels
    if (!fit.zoom) setDateAxisLabels(option, spec, paneWidth(), paneHeight());
    if (fit.zoom) addZoom(option, fit);
    if (onCanvas) tuneForSize(option, spec);
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
      instance.setOption({ xAxis: [].concat(option.xAxis).map(() => ({ axisLabel: { rotate: fit.rotate, ...(fit.rotate ? { width: rotatedLabelCap(paneHeight()) } : {}) } })) });
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
export function tuneForSize(option, spec = {}) {
  const allMarkers = linesTakeStyle(spec.type) && spec.format?.lineMarkers === "all"; // Format → Line markers All: LTTB would drop points, and with them their markers
  for (const sr of [].concat(option.series ?? [])) {
    // Large mode draws plain values only — skip it when a bar carries its own style (Other, colour-by).
    if (sr.type === "bar" && (sr.data ?? []).every((v) => v === null || typeof v !== "object"))
      Object.assign(sr, { large: true, largeThreshold: 2000 });
    if (sr.type === "line" && !allMarkers) sr.sampling = "lttb";
  }
}

// Category axes label every category (no skipping); long labels truncate (the tooltip has the full
// name), and bottom labels tilt when they can't sit side by side.
function showEveryCategory(option, rotate, fit = {}, height = 0) {
  const fix = (axis, bottom) => {
    if (!axis || axis.type !== "category") return axis;
    // A fitted axis shares the pane: labels thin out instead of forcing a slot each.
    // An upright bottom label is capped by the pane's height (a short widget would otherwise clip it); the ellipsis marks the cut.
    const wide = bottom ? (rotate ? rotatedLabelCap(height) : FIT.labelMax) : FIT.sideMax;
    if (bottom ? fit.fittedX : fit.fittedY) return { ...axis, axisLabel: { ...axis.axisLabel, hideOverlap: true, width: bottom ? FIT.labelMax : FIT.sideMax, overflow: "truncate" } };
    return { ...axis, axisLabel: { ...axis.axisLabel, interval: 0, hideOverlap: false,
      width: wide, overflow: "truncate", ...(bottom ? { rotate } : {}) } };
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
      const shaded = /\bws-bg-/.test(container.className) ? getComputedStyle(container).backgroundColor : "";
      const surface = shaded || getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff";
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
export function buildOption(spec) {
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
export function buildCartesian({ type, categories, series, format = {}, orientation = "vertical", pointLabels, seriesLabels, tooltipExtra, tooltipText, tooltipFields, tooltipStyle, tooltipFormats, otherIndex = -1, analytics = null, colorValues, colorName, sizes, sizeName, sizeMembers, sizeOrder, sizeGrid, sizeMembersGrid, labelMarks }) {
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
  // A colour measure (one measure only) colours each bar / marker / line stretch by its value: it replaces the palette and Colour by category.
  const { show: showLegend, pos, legend } = legendFor(format, c, series.map((s) => s.name), multi || dual || hasCompare);
  const byValue = Array.isArray(colorValues) && (type === "bar" || type === "stacked" || type === "line" || type === "area" || isCombo)
    ? colourByValue(colorValues, c, fmtVal, colorName, showLegend && pos === "bottom" ? 28 : 0) : null;
  // With several measures every mark of every measure wears its row's colour, so colour no longer says which measure a mark is: each measure gets
  // a cue of its own (a bar pattern, a line dash and marker; stacked segments are also separated by a surface stroke) and the legend swatches are neutral.
  const cued = Boolean(byValue) && mainCount > 1;
  const cueOf = (i) => (cued && !series[i]?.compare ? measureCue(i, format.markerShape) : null);
  const colorByDim = type === "bar" && !multi && !!format.colorByDimension && !byValue;
  // Size (a measure, or a dimension's member steps): a bar's thickness (custom series), a straight line's own thickness (a segment overlay), or an
  // area / stepped line's marker size. `sizes` is one value per category shared by every series; `sizeGrid` (beside a Colour split) one per series cell.
  const sz = cartesianSizes({ sizes, sizeGrid, sizeOrder, type, mainCount, format });
  const sizeFr = sz?.fr ?? null; // sizeFr[series][category] = 0..1
  const sizeMode = lineSizeMode(type, format.lineStyle, mainCount * labels.length); // "width" | "marker" | null
  const sizeNote = sz ? sizeLegend(sz.flat, sizeName, c, fmtVal, showLegend && pos === "top" ? 24 : 2, { order: sizeOrder, reversed: sizeScaleOf(format).reversed }) : null;
  const sizeText = (si, di) => { // a cell's Size in words (a member's name, or the formatted value)
    const m = sizeMembersGrid ? sizeMembersGrid[si]?.[di] : sizeMembers ? sizeMembers[di] : undefined;
    if (m != null) return String(m);
    const v = sizeGrid ? sizeGrid[si]?.[di] : sizes?.[di];
    return v == null ? null : fmtVal(v);
  };
  const xTitle = format.xTitle || null;
  const yTitle = format.yTitle || null;

  // Label: when a Label field is mapped, marks show its per-row value; otherwise the toggle
  // shows the measure value. `pointLabels` is indexed by category (dataIndex).
  const labelPos = horizontal ? "right" : "top";
  // seriesLabels[series][category]: a colour split's Label, laid out per cell; pointLabels[category]: one text per mark.
  const labelAt = (si, di) => (seriesLabels ? seriesLabels[si]?.[di] : pointLabels?.[di]);
  // Format → Label marks: a mask over each series' marks (Min & max, Selected, Most recent, Line ends, or only while highlighted); null = every mark, as always.
  const mask = labelMarks ? labelMask(labelMarks.mode, { series: series.map((s) => s.data), skip: otherIndex >= 0 ? [otherIndex] : [], selected: labelMarks.selected, recent: labelMarks.recent }) : null;
  const hoverLabel = mask?.hover ? { label: { show: true } } : {}; // Highlighted: the label appears with the mark's emphasis (hover, or a legend item's highlight)
  const focusOf = mask?.hover ? "self" : "series"; // one mark's label on hover, not the whole series'
  const linePos = type === "line" || type === "area" ? labelPositionSymbol(format.labelPosition) : null; // Format → Label position: a line's label sits on its point; bars keep their own place
  const dataLabel = (si, onLine = false) => ((pointLabels || seriesLabels || format.dataLabels)
    ? { show: !mask?.hover, position: (onLine && linePos) || (type === "stacked" && seriesLabels ? "inside" : labelPos), // only a colour split's Label sits inside its stack segment color: c.label, fontFamily: c.font, fontSize: 14,
        formatter: (p) => (mask && !mask.at(si, p.dataIndex) ? "" : (pointLabels || seriesLabels) ? String(labelAt(si, p.dataIndex) ?? "") : fmtVal(p.value)) }
    : { show: false });

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
    ...(byValue?.legend ?? {}), // the colour measure's gradient / steps (display only)
    ...(sizeNote ?? {}),
    grid: {
      left: 6 + (showLegend && pos === "left" ? 96 : 0),
      right: 18 + (showLegend && pos === "right" ? 96 : 0) + (dual ? 36 : 0),
      top: 18 + (showLegend && pos === "top" ? 18 : 0) + (yTitle || dual ? 18 : 0) + (sizeNote ? 24 : 0),
      bottom: 6 + (showLegend && pos === "bottom" ? 22 : 0) + (xTitle ? 24 : 0) + (byValue ? byValue.room : 0),
      containLabel: true,
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: type === "line" || type === "area" ? "line" : "shadow", lineStyle: { color: c.axis } },
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => {
        const arr = (Array.isArray(p) ? p : [p]).filter((d) => !String(d.seriesId ?? "").startsWith(WIDTH_ID)); // the line-thickness overlay is not a series to list
        const val = (d) => (Array.isArray(d.value) ? d.value[horizontal ? 0 : 1] : d.value); // a variable-width bar's value is [position, value, size]
        if (tooltipText) return customTip(tooltipText, tooltipFields, tooltipStyle, tooltipFormats, fmtVal, format, arr[0].dataIndex, Object.fromEntries(arr.map((d) => [String(d.seriesName), val(d)])));
        const head = `<span style="color:${c.muted}">${escapeHtml(String(arr[0].axisValueLabel ?? arr[0].name ?? ""))}</span>`;
        const lines = arr.map((d) =>
          `<br><span style="display:inline-block;width:8px;height:8px;border-radius:${c.radius}px;background:${d.color ?? d.data?.itemStyle?.color ?? c.series};margin-right:8px"></span>` +
          `<b>${escapeHtml(String(d.seriesName))}:</b> ${fmtVal(val(d))}` +
          (sizeGrid && sizeFr && sizeText(d.seriesIndex, d.dataIndex) != null ? ` · <b>${escapeHtml(String(sizeName || "size"))}:</b> ${escapeHtml(sizeText(d.seriesIndex, d.dataIndex))}` : "")).join("");
        const at = arr[0].dataIndex;
        const channels = (sizeFr && !sizeGrid && sizeText(0, at) != null ? `<br><b>${escapeHtml(String(sizeName || "size"))}:</b> ${escapeHtml(sizeText(0, at))}` : "") +
          (byValue && colorValues[at] != null ? `<br><b>${escapeHtml(String(colorName || "colour"))}:</b> ${fmtVal(colorValues[at])}` : "");
        return head + lines + channels + extraTooltip(tooltipExtra, at, c); // custom tooltip fields
      },
    },
    xAxis,
    yAxis,
  };

  const step = lineStep(format.lineStyle); // false | "end" | "middle"
  const edge = markBorder(format.markBorder, borderInk(format.markBorderColor, c)); // the stroke of bars (and the lines' markers)
  const secondary = secondaryKind(format.secondaryType); // how a combo draws its right-axis measures
  if (cued && legend) { // each legend entry wears its measure's cue: a line's marker symbol, a bar's roundRect with its pattern
    const lineAt = (i) => !(isCombo && i >= 1 && secondary === "bar") && (type === "line" || type === "area" || (isCombo && i >= 1));
    legend.data = legend.data.map((name, i) => ({ name, ...(cueOf(i) && lineAt(i) ? { icon: cueOf(i).symbol } : {}) }));
  }
  const widthLines = []; // straight lines drawn with a Size: each gets a segment overlay (below)
  // Format → Line pattern: a Size field setting a straight line's thickness (polygons, which a dash can't break up) keeps it solid, and a cued chart's measures keep their own dashes.
  const patternThick = Boolean(sizeFr) && sizeMode === "width"; // the same rule the Format panel applies with the drawn point count (line-controls.js)
  const pattern = effectivePattern({ pattern: format.linePattern, thick: patternThick, cued });
  base.series = series.map((s, i) => {
    // A comparison series wears its measure's colour, faded and dashed (line) or muted (bar).
    if (s.compare) {
      const color = colorFor(i - mainCount);
      const asLine = type === "line" || type === "area";
      return asLine
        ? { name: s.name, type: "line", step, yAxisIndex: seriesAxis(dual, i - mainCount), data: s.data, showSymbol: false, z: 1,
            lineStyle: { width: 2, type: comparisonDash(pattern), color, opacity: 0.7 }, itemStyle: { color, opacity: 0.7 }, emphasis: { focus: "series" } }
        : { name: s.name, type: "bar", data: s.data, barMaxWidth: 40,
            // Hatched as well as faded, so it reads as "the other period" without relying on colour.
            itemStyle: { color: c.muted, opacity: 0.55, borderRadius: horizontal ? [0, c.radius, c.radius, 0] : [c.radius, c.radius, 0, 0],
              decal: { symbol: "rect", symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: c.surface } },
            emphasis: { itemStyle: { opacity: 0.8 } } };
    }
    const cue = cueOf(i);
    const color = cue ? c.muted : colorFor(i, s.name); // a cued measure's swatch (and a missing value's mark) is neutral: the cue, not a hue, names the measure
    // line/area always draw as a line; in a combo the 1st measure is a bar and the rest are lines.
    const rightBars = isCombo && i >= 1 && secondary === "bar";
    const asLine = !rightBars && (type === "line" || type === "area" || (isCombo && i >= 1));
    if (asLine) {
      // Size: each marker's own size; a colour measure: each marker its value's colour, the line a gradient along it (nulls keep the neighbour's).
      const stroke = byValue ? lineGradient(byValue.colours, horizontal, color) : color;
      const markerSized = Boolean(sizeFr) && sizeMode === "marker"; // an area / stepped line: Size scales the markers (a straight line's thickness is the overlay below)
      const lineData = markerSized || byValue
        ? s.data.map((v, di) => (v == null ? v : { value: v, ...(markerSized ? { symbolSize: markerSizeFor(sizeFr[i]?.[di]) } : {}), ...(byValue?.colours[di] ? { itemStyle: { color: byValue.colours[di], ...(format.markBorder && format.markBorder !== "none" ? edge : {}) } } : {}) }))
        : s.data;
      if (sizeFr && sizeMode === "width") widthLines.push({ s, i, stroke: byValue ? byValue.colours : null, color, axis: seriesAxis(dual, i, isCombo) });
      // Format → Line markers All / None decide the dots themselves; a marker that is data (a Size-sized marker, a cued line's marker) always stays.
      const mk = markerPlan({ mode: format.lineMarkers, forced: markerSized || Boolean(cue), labelled: Boolean(pointLabels || seriesLabels || format.dataLabels), data: s.data });
      const dots = mk ? mk.show : s.data.length <= 60 || format.markerSize != null || markerSized || Boolean(cue); // dots only when they won't crowd (unless a marker size is chosen; a cued line's markers name it)
      // Format → Label marks on a line with no dots (a long one): a label sits on its mark's dot, so only the labelled marks show one (the rest are clear until hovered).
      const labelDots = !mk && !dots && Boolean(mask) && !mask.hover && Boolean(pointLabels || seriesLabels || format.dataLabels);
      const dotted = labelDots ? lineData.map((d, di) => (d == null ? d : { ...(isObjectItem(d) ? d : { value: d }), ...(mask.at(i, di) ? {} : { itemStyle: { ...(isObjectItem(d) ? d.itemStyle : {}), opacity: 0 }, emphasis: { itemStyle: { opacity: 1 } } }) })) : mk?.clear ? clearDots(lineData, mk.clear, { color, edge: format.markBorder && format.markBorder !== "none" ? edge : null }) : lineData; // an unlabelled mark keeps its normal size but is clear: the hover dot and the tooltip work as on a plain long line (Line markers None: every dot but a lone value's)
      const dash = lineDash({ pattern: format.linePattern, cue, thick: patternThick });
      return {
        name: s.name, type: "line", step,
        yAxisIndex: seriesAxis(dual, i, isCombo),
        z: sizeFr && sizeMode === "width" ? 3 : undefined, // markers and the thin line stay above their thickness
        data: dotted,
        showSymbol: dots || labelDots, ...(labelDots || mk?.all ? { showAllSymbol: true } : {}), // ECharts thins dense symbols ("auto") — a labelled mark's must stay
        symbol: cue ? cue.symbol : markerSymbol(format.markerShape), symbolSize: markerSizeOr(format.markerSize, 8), // ≥8px markers (dataviz mark spec) unless Format → Marker size
        areaStyle: type === "area" || (isCombo && secondary === "area") ? { opacity: 0.18, color: stroke } : undefined,
        lineStyle: { width: 2, color: stroke, ...(dash !== undefined ? { type: dash } : {}) }, // a cue's own dash, else Format → Line pattern (solid = no type, as before)
        itemStyle: { color, ...(format.markBorder && format.markBorder !== "none" ? edge : {}) },
        label: dataLabel(i, true),
        emphasis: { focus: focusOf, ...hoverLabel },
      };
    }
    const stacked = type === "stacked";
    // Round the "growing" end of the bar: top for vertical, right for horizontal; none when stacked.
    const barRadius = stacked ? [0, 0, 0, 0] : (horizontal ? [0, c.radius, c.radius, 0] : [c.radius, c.radius, 0, 0]);
    // The "Other" bar (everything past the limit) wears the muted ink (≥ 3:1 on the surface, apart from
    // the series hue); its label says what it is.
    // A cued bar keeps its pattern; stacked segments of one bar share a colour, so a surface stroke (unless a border is chosen) separates them.
    const barEdge = cue && stacked && !(format.markBorder && format.markBorder !== "none") ? { borderColor: c.surface, borderWidth: 1 } : edge;
    const cueStyle = cue?.decal ? { decal: { ...cue.decal, color: c.surface } } : {};
    const otherItem = (v) => ({ value: v, itemStyle: { color: c.muted, borderRadius: barRadius, ...barEdge } });
    if (sizeFr && type === "bar") {
      const fillAt = (di) => (di === otherIndex ? c.muted : byValue?.colours[di] ?? (colorByDim ? memberColor(labels[di], c.cat[di % c.cat.length]) : null));
      return variableBars({ s, color, sizeFr: sizeFr[i] ?? [], sizes: sz.grid[i] ?? [], slot: { at: i, of: mainCount }, horizontal, c, edge, fillAt, hover: Boolean(mask?.hover), dataLabel: (pointLabels || seriesLabels || format.dataLabels) ? (di, v) => (mask && !mask.at(i, di) ? "" : pointLabels || seriesLabels ? String(labelAt(i, di) ?? "") : fmtVal(v)) : null });
    }
    return {
      name: s.name, type: "bar",
      yAxisIndex: rightBars ? 1 : 0,
      stack: stacked ? "total" : undefined,
      // Colour-by-dimension: per-bar colours; otherwise the series colour.
      data: colorByDim
        ? s.data.map((v, di) => (di === otherIndex ? otherItem(v) : { value: v, itemStyle: { color: memberColor(labels[di], c.cat[di % c.cat.length]), borderRadius: barRadius, ...edge } }))
        : s.data.map((v, di) => (di === otherIndex ? otherItem(v) : byValue?.colours[di] ? { value: v, itemStyle: { color: byValue.colours[di], borderRadius: barRadius, ...barEdge } } : v)),
      barMaxWidth: 40,
      itemStyle: { color, borderRadius: barRadius, ...barEdge, ...cueStyle },
      label: dataLabel(i),
      emphasis: { focus: focusOf, itemStyle: colorByDim ? { opacity: 0.85 } : { color, opacity: 0.85 }, ...hoverLabel },
    };
  });
  for (const w of widthLines) base.series.push(thickLine({ ...w, share: sizeFr[w.i] ?? [], horizontal, opacity: markOpacityOf(format) }));
  if (analytics) addAnalytics(base, analytics, { c, fmtVal, horizontal, trendDash: trendDash(pattern) });
  return base;
}

// Analytics overlays on a cartesian chart: a dashed reference line (labelled with its value), a
// shaded band (labelled), and a dotted trend line named at its end — each carries words, never colour alone.
function addAnalytics(base, a, { c, fmtVal, horizontal, trendDash = "dotted" }) {
  const s0 = base.series[a.measure ?? 0]; // the reference line and band sit on their own measure's axis (the trend follows the first)
  if (!s0) return;
  const axis = horizontal ? "xAxis" : "yAxis";
  if (a.ref) {
    s0.markLine = { silent: true, symbol: "none", animation: false,
      lineStyle: { color: c.ink, type: "dashed", width: 1.5 },
      label: { formatter: `${a.ref.name}: ${fmtVal(a.ref.value)}`, color: c.label, fontFamily: c.font, position: "insideEndTop", distance: 6, backgroundColor: c.surface, padding: [2, 4], borderRadius: c.radius }, // sits above the line on a surface backing, never across it
      data: [{ [axis]: a.ref.value }] };
  }
  if (a.band) {
    s0.markArea = { silent: true, animation: false, itemStyle: { color: c.grid, opacity: 0.7 },
      label: { show: true, formatter: `${a.band.name ?? "Band"} ${fmtVal(a.band.from)}–${fmtVal(a.band.to)}`, color: c.muted, fontFamily: c.font, position: "insideTopLeft", backgroundColor: c.surface, padding: [2, 4], borderRadius: c.radius },
      data: [[{ [axis]: a.band.from }, { [axis]: a.band.to }]] };
  }
  if (a.trend) {
    base.series.push({ id: `${ANALYTICS_ID}trend`, name: a.trend.name, type: "line", data: a.trend.data, showSymbol: false, z: 4, animation: false,
      lineStyle: { width: 2, type: trendDash, color: c.muted }, itemStyle: { color: c.muted },
      endLabel: { show: true, formatter: a.trend.short ?? a.trend.name, color: c.muted, backgroundColor: c.surface, padding: [2, 4], fontFamily: c.font, fontSize: 14 },
      tooltip: { valueFormatter: fmtVal } });
    base.grid.right = (Number(base.grid.right) || 0) + Math.max(84, Math.ceil((a.trend.short ?? a.trend.name).length * 8) + 8); // room for the short end label (14px text, ~8px a character)
  }
}

// pie / donut — one dimension (slices) × one measure (size). Colour IS the encoding, so a legend
// shows by default (dataviz: identity never colour-alone; the legend supplies the labels).
const PIE_PERCENT_SLICES = 6; // with Data labels on, up to this many slices also show their percent
function buildPie({ type, categories, series, format = {}, pointLabels, tooltipExtra, tooltipText, tooltipFields, tooltipStyle, tooltipFormats, otherIndex = -1, colorValues, colorName, split, labelMarks }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = (categories ?? []).map((l) => l ?? "—");
  // A colour measure colours each slice by its value (replacing the palette and member colours); the slice list stays the legend of members.
  const byValue = Array.isArray(colorValues) ? colourByValue(colorValues, c, fmtVal, colorName) : null;
  // A Colour field splits each slice into sub-slices, one per member of the field: a sub-slice is named for its member (so the legend lists the members and a
  // legend click lights every sub-slice of one), wears its member's colour, and says "slice · member" in its label and tooltip. `split` = { members: [{ name }],
  // memberIndex: per sub-slice (-1 = the Other remainder), memberNames: per sub-slice }.
  const memberName = (i) => (split && split.memberIndex[i] >= 0 ? split.memberNames[i] : labels[i]);
  const mask = labelMarks ? labelMask(labelMarks.mode, { series: [series[0].data], skip: otherIndex >= 0 ? [otherIndex] : [], selected: labelMarks.selected, recent: labelMarks.recent }) : null; // Format → Label marks
  const noLabel = { label: { show: false }, labelLine: { show: false } }; // a slice that carries no label has no leader line pointing at nothing
  const data = labels.map((full, i) => split
    ? { name: memberName(i), full, value: series[0].data[i], itemStyle: { color: i === otherIndex || split.memberIndex[i] < 0 ? c.muted : memberColor(split.memberNames[i], c.cat[split.memberIndex[i] % c.cat.length]) } }
    : { name: full, value: series[0].data[i], ...(i === otherIndex ? { itemStyle: { color: c.muted } } : byValue?.colours[i] ? { itemStyle: { color: byValue.colours[i] } } : !byValue && memberColors().has(full) ? { itemStyle: { color: memberColors().get(full) } } : {}) });
  const markedData = mask && !mask.hover ? data.map((d, i) => (mask.at(0, i) ? d : { ...d, ...noLabel })) : data;
  const fullName = (p) => p.data?.full ?? p.name;
  const { pos, legend } = legendFor(format, c, split ? [...new Set(data.map((d) => d.name))] : labels, true);
  const showLabels = !!format.dataLabels || !!pointLabels; // Label field forces slice labels on
  const fewSlices = labels.length <= PIE_PERCENT_SLICES; // few slices: the label adds the share

  return {
    color: c.cat,
    textStyle: { fontFamily: c.font, color: c.label },
    legend,
    ...(byValue?.legend ?? {}),
    tooltip: {
      trigger: "item",
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => tooltipText
        ? customTip(tooltipText, tooltipFields, tooltipStyle, tooltipFormats, fmtVal, format, p.dataIndex, { [String(series[0].name)]: p.value, Percent: `${p.percent}%` })
        :
        `<span style="color:${c.muted}">${escapeHtml(String(fullName(p)))}</span><br>` +
        `<b>${escapeHtml(String(series[0].name))}:</b> ${fmtVal(p.value)} (${p.percent}%)` +
        (byValue && colorValues[p.dataIndex] != null ? `<br><b>${escapeHtml(String(colorName || "colour"))}:</b> ${fmtVal(colorValues[p.dataIndex])}` : "") +
        extraTooltip(tooltipExtra, p.dataIndex, c),
    },
    series: [{
      type: "pie",
      radius: byValue ? (type === "donut" ? ["35%", "58%"] : "58%") : type === "donut" ? ["45%", "72%"] : "72%",
      center: legend && (pos === "left" || pos === "right") ? ["42%", byValue ? "46%" : "52%"] : ["50%", byValue ? "46%" : "54%"],
      data: markedData,
      label: { show: showLabels && !mask?.hover, color: c.label, fontFamily: c.font,
        formatter: (p) => (pointLabels ? String(pointLabels[p.dataIndex] ?? "") : `${fullName(p)}: ${fmtVal(p.value)}${fewSlices ? ` (${p.percent}%)` : ""}`) },
      labelLine: { show: showLabels && !mask?.hover },
      itemStyle: edgeOr(format.markBorder, borderInk(format.markBorderColor, c), { borderColor: c.surface, borderWidth: 2 }),
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.2)" }, ...(mask?.hover && showLabels ? { label: { show: true }, labelLine: { show: true } } : {}) }, // Highlighted: the label and its leader appear with the slice's emphasis
    }],
  };
}

// scatter — two measures map to the X and Y value axes; dimension keys label the points. marks:
// `sizes` scales the symbol (bubble), `colorValues` ramps a continuous gradient (visualMap legend),
// `pointLabels` writes a field on each point, `tooltipExtra` appends field lines to the tooltip.
function buildScatter({ categories, series, format = {}, sizes, sizeName, sizeMembers, sizeOrder, colorValues, colorName, pointLabels, tooltipExtra, tooltipText, tooltipFields, tooltipStyle, tooltipFormats, symbol, labelMarks }) {
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
    return { value: arr, name, ...(sizeMembers ? { sizeMember: sizeMembers[i] } : {}), ...(colorByDim ? { itemStyle: { color: memberColor(name, c.cat[i % c.cat.length]) } } : {}) };
  });
  const mask = labelMarks ? labelMask(labelMarks.mode, { series: [series[1].data], selected: labelMarks.selected, recent: labelMarks.recent }) : null; // Format → Label marks, over the Y values
  const symbolSize = sizeDim >= 0 ? sizeScaler(sizes, (v) => v[sizeDim], { format, order: sizeOrder }) : markerSizeOr(format.markerSize, 14); // a Size field wins
  const sizeShown = (p) => (p.data?.sizeMember != null ? p.data.sizeMember : fmtVal(p.value[sizeDim]));
  const legend = colorDim >= 0 ? continuousVisualMap(colorValues, colorDim, c, fmtVal, colorName) : undefined;
  const sizeNote = sizeDim >= 0 ? sizeLegend(sizes, sizeName, c, fmtVal, 2, { order: sizeOrder, reversed: sizeScaleOf(format).reversed }) : null;

  return {
    textStyle: { fontFamily: c.font, color: c.label },
    grid: { left: 6, right: 18, top: 18 + (sizeNote ? 24 : 0), bottom: 6 + 24 + (legend ? 24 + (legend.title ? 24 : 0) : 0), containLabel: true },
    ...legend,
    ...(sizeNote ?? {}),
    tooltip: {
      trigger: "item",
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => tooltipText
        ? customTip(tooltipText, tooltipFields, tooltipStyle, tooltipFormats, fmtVal, format, p.dataIndex, { [xName]: p.value[0], [yName]: p.value[1],
          ...(sizeDim >= 0 ? { [sizeName || "size"]: p.data?.sizeMember ?? p.value[sizeDim] } : {}),
          ...(colorDim >= 0 ? { [colorName || "colour"]: p.value[colorDim] } : {}) })
        :
        `<span style="color:${c.muted}">${escapeHtml(String(p.name ?? ""))}</span><br>` +
        `<b>${escapeHtml(xName)}:</b> ${fmtVal(p.value[0])}<br><b>${escapeHtml(yName)}:</b> ${fmtVal(p.value[1])}` +
        (sizeDim >= 0 ? `<br><b>${escapeHtml(sizeName || "size")}:</b> ${escapeHtml(String(sizeShown(p)))}` : "") +
        (colorDim >= 0 ? `<br><b>${escapeHtml(colorName || "colour")}:</b> ${fmtVal(p.value[colorDim])}` : "") +
        extraTooltip(tooltipExtra, p.dataIndex, c),
    },
    xAxis: {
      type: "value", scale: true, name: xName, nameLocation: "middle", nameGap: 28,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600 },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.muted, formatter: fmtVal },
    },
    yAxis: {
      type: "value", scale: true, name: yName, nameLocation: "end", nameGap: 12,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600, align: "left" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.muted, formatter: fmtVal },
    },
    series: [{
      type: "scatter", data, symbolSize, symbol: symbol || "circle", // square/circle marks
      itemStyle: { ...(colorByDim || continuous ? {} : { color: c.series, opacity: 0.8 }), ...pointEdge(format, c) },
      label: (pointLabels || format.dataLabels)
        ? { show: !mask?.hover, position: labelPositionSymbol(format.labelPosition) ?? "top", color: c.muted, fontFamily: c.font, fontSize: 14,
            formatter: (p) => (mask && !mask.at(0, p.dataIndex) ? "" : pointLabels ? String(pointLabels[p.dataIndex] ?? "") : String(p.name ?? "")) }
        : { show: false },
      emphasis: { focus: "self", itemStyle: { borderColor: c.ink, borderWidth: 1 }, ...(mask?.hover && (pointLabels || format.dataLabels) ? { label: { show: true } } : {}) },
    }],
  };
}

// scatterShapes — one scatter series per Shape-dimension value, each a distinct symbol so
// identity survives greyscale (shape is a non-colour channel). X/Y are the two shelf measures; an
// optional Size dim scales the symbol. spec: { groups:[{name, points:[{value:[x,y,size?], name, row (the result row behind the point)}], colour?: { index, name }, shape?: { index } }],
// symbol (the mark type's symbol when a group has no Shape), xName, yName, hasSize, sizeName, format }. A group with a Colour member wears that
// member's colour (a member colour from Format wins over the palette slot); one with a Shape member its symbol; shape alone keeps one palette colour per series.
// A Shape member wears the symbol chosen for it (`memberShapes`: displayed name -> shape key, Edit member shapes), else the one at its position in the set; a bin of a Shape measure its bin's symbol. `shapeName`
// names a Shape measure in the tooltip, which then also says the point's exact value.
function buildScatterShapes({ groups, symbol, xName, yName, hasSize, sizeName, sizeOrder, shapeName, memberShapes = new Map(), format = {}, rowLabels, labelMarks }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const allSizes = hasSize ? groups.flatMap((g) => g.points.map((p) => p.value[2])) : null;
  const symbolSize = hasSize ? sizeScaler(allSizes, (v) => v[2], { format, order: sizeOrder }) : markerSizeOr(format.markerSize, 12);
  const names = groups.map((g) => g.name);
  const { show, pos, legend } = legendFor(format, c, names, true);
  const symbolOf = (g) => (g.shape ? (shapeName ? symbolAt(g.shape.index) : memberShapes.has(g.shape.name) ? shapeSymbol(memberShapes.get(g.shape.name)) : symbolAt(g.shape.index)) : symbol || "circle");
  const colourOf = (g, i) => (g.colour ? memberColor(g.colour.name, c.cat[g.colour.index % c.cat.length]) : c.cat[i % c.cat.length]);
  if (legend && groups.some((g) => g.shape)) legend.data = groups.map((g) => (g.shape ? { name: g.name, icon: symbolOf(g) } : g.name)); // the legend swatch wears the symbol too
  const sizeNote = hasSize ? sizeLegend(allSizes, sizeName, c, fmtVal, show && pos === "top" ? 24 : 2, { order: sizeOrder, reversed: sizeScaleOf(format).reversed }) : null;
  // Labels (Data labels, or a Label field written per result row): one per mark, in the member's series. Min & max is per member; Selected and Most recent name result
  // rows, which every point carries. A point with no name of its own (Colour or Shape is the only dimension) says its member, so a label is never blank.
  const labelled = Boolean(format.dataLabels || rowLabels);
  const mask = labelled && labelMarks ? labelMask(labelMarks.mode, { series: groups.map((g) => g.points.map((p) => p.value[1])), selected: labelMarks.selected, recent: labelMarks.recent, keyOf: (si, di) => groups[si].points[di]?.row ?? di }) : null;
  const labelPos = labelPositionSymbol(format.labelPosition) ?? "top";
  const labelOf = (g, mark) => (rowLabels && mark?.row != null ? String(rowLabels[mark.row] ?? "") : mark?.name || g.name);
  const seriesLabel = (g, si) => (labelled ? {
    show: !mask?.hover, position: labelPos, color: c.muted, fontFamily: c.font, fontSize: 14,
    formatter: (p) => (mask && !mask.at(si, p.dataIndex) ? "" : labelOf(g, g.points[p.dataIndex])),
  } : undefined);
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    legend,
    ...(sizeNote ?? {}),
    grid: {
      left: 6 + (show && pos === "left" ? 96 : 0), right: 18 + (show && pos === "right" ? 96 : 0),
      top: 24 + (show && pos === "top" ? 18 : 0) + (sizeNote ? 24 : 0), bottom: 6 + 24 + (show && pos === "bottom" ? 22 : 0), containLabel: true,
    },
    tooltip: {
      trigger: "item", backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) =>
        `<span style="color:${c.muted}">${escapeHtml(String(p.seriesName))}${p.data && p.data.name ? " · " + escapeHtml(String(p.data.name)) : ""}</span><br>` +
        `<b>${escapeHtml(xName)}:</b> ${fmtVal(p.value[0])}<br><b>${escapeHtml(yName)}:</b> ${fmtVal(p.value[1])}` +
        (hasSize ? `<br><b>${escapeHtml(sizeName || "size")}:</b> ${escapeHtml(String(p.data?.sizeMember != null ? p.data.sizeMember : fmtVal(p.value[2])))}` : "") +
        (shapeName && p.data?.shapeValue != null ? `<br><b>${escapeHtml(shapeName)}:</b> ${escapeHtml(String(p.data.shapeValue))}` : ""),
    },
    xAxis: {
      type: "value", scale: true, name: xName, nameLocation: "middle", nameGap: 28,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600 },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, formatter: fmtVal },
    },
    yAxis: {
      type: "value", scale: true, name: yName, nameLocation: "end", nameGap: 12,
      nameTextStyle: { color: c.label, fontFamily: c.font, fontWeight: 600, align: "left" },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, formatter: fmtVal },
    },
    series: groups.map((g, i) => ({
      name: g.name, type: "scatter", symbol: g.shape || g.colour ? symbolOf(g) : symbolAt(i), symbolSize,
      data: g.points, itemStyle: { color: colourOf(g, i), opacity: 0.85, ...pointEdge(format, c) },
      ...(labelled ? { label: seriesLabel(g, i) } : {}),
      emphasis: { focus: mask?.hover ? "self" : "series", itemStyle: { borderColor: c.ink, borderWidth: 1 }, ...(mask?.hover ? { label: { show: true } } : {}) }, // Highlighted: a label appears with its own mark's emphasis, so the focus is the mark, not the member
    })),
  };
}

// heatmap — two dimensions on the axes, one measure as colour intensity. Colour IS a channel
// here, so a visualMap legend accompanies it (identity also comes from the x/y labels).
// spec: { xCats:string[], yCats:string[], cells:[[xi, yi, value]], format }
function buildHeatmap({ xCats, yCats, cells, format = {} }) {
  const live = drawing ?? { instance: null }; // this container's state, read when ECharts sizes the circles
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const circles = format.heatmapShape === "circle";
  // The cell separator stays the surface-coloured hairline unless a border is chosen.
  const cellEdge = format.markBorder && format.markBorder !== "none" ? markBorder(format.markBorder, borderInk(format.markBorderColor, c))
    : { borderColor: drawing?.colorSteps ? c.axis : c.surface, borderWidth: 1 }; // stepped: a visible hairline so a pale step is not a gap
  const vals = cells.map((d) => d[2]).filter((v) => v != null);
  const range = colourScaleRange(vals, true);
  const { min, max } = range;
  const legendNote = [centreNote(range, fmtVal), outOfRangeNote()].filter(Boolean).join(" · ");
  const chartW = () => live.instance?.getWidth() ?? 800, chartH = () => live.instance?.getHeight() ?? 450;
  const diameter = () => format.markerSize != null ? markerSizeOr(format.markerSize, 6) : circleSize(chartW() - HEATMAP_GUTTER.x, chartH() - HEATMAP_GUTTER.y, xCats.length, yCats.length);
  // Value labels: Format → Data labels forces them on; otherwise they appear when the longest one fits a cell (read from the live chart on every
  // draw, so a resize can show or hide them), in the ink that reads on that cell's own colour.
  const forced = !!format.dataLabels;
  const text = (v) => (v == null || !Number.isFinite(Number(v)) ? "" : fmtVal(v));
  const longest = cells.reduce((a, d) => { const t = text(d[2]); return t.length > a.length ? t : a; }, "");
  const inks = [c.ink, c.surface, "#000000", "#ffffff"];
  const labelled = (list) => { const col = valueColours(list.map((d) => d[2]), c).colours, k = markOpacityOf(format); return list.map((d, i) => ({ value: d, label: { color: col[i] ? pickInk(k < 1 ? mixHex(c.surface, col[i], k) : col[i], inks) : c.ink } })); }; // the ink reads on the cell as it shows (Format → Opacity blends it into the surface)
  const cellLabel = (size) => ({
    show: true, fontFamily: c.font, fontSize: LABEL_FONT, color: c.ink,
    formatter: (p) => { const { w, h } = size(); return labelsShown({ forced, cellW: w, cellH: h, texts: [longest] }) ? text(p.value[2]) : ""; },
  });
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
    ...colourLegend({ min, max, ramp: rampOf(range, c), dimension: 2, c, fmtVal, note: legendNote, bottom: 6 }),
    series: [circles
      // Circles = scatter marks on the same category grid, sized by the cell, coloured by the
      // value through the same visualMap (dimension 2); the value label sits inside each circle.
      ? {
        // Empty cells draw nothing; the size is re-read from the live chart on every draw, so it follows the pane.
        type: "scatter", data: labelled(circleCells(cells)), symbol: "circle",
        symbolSize: diameter,
        label: cellLabel(() => ({ w: diameter(), h: diameter() })),
        itemStyle: { opacity: 1, ...cellEdge },
        emphasis: { itemStyle: { borderColor: c.ink, borderWidth: 2 } },
      }
      : {
        type: "heatmap", data: labelled(cells),
        label: cellLabel(() => cellSizeOf(chartW(), chartH(), xCats.length, yCats.length, HEATMAP_GUTTER)),
        itemStyle: cellEdge,
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(0,0,0,0.25)" } },
      }],
  };
}

// treemap — nested rectangles sized by a measure; one or two dimensions form the hierarchy.
// spec: { tree:[{ name, value, shelf?, size?, colour?, children? }], sizeName?, colourName?, shelfName?, format }. With a Size measure
// a tile's area is `value` (= size) and the shelf measure is the label's second line; a colour measure colours each leaf by its value
// on the legend's scale (a parent keeps a neutral fill under its children). Without either, each top-level tile takes a category colour.
function buildTreemap({ tree, sizeName, colourName, shelfName, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const leaves = [];
  const walk = (nodes) => nodes.forEach((n) => (n.children ? walk(n.children) : leaves.push(n)));
  walk(tree);
  const hasColour = leaves.some((n) => n.colour !== undefined);
  const hasSize = leaves.some((n) => n.size !== undefined);
  const byValue = hasColour ? colourByValue(leaves.map((n) => n.colour), c, fmtVal, colourName) : null;
  const colourOf = new Map(leaves.map((n, i) => [n, byValue?.colours[i] ?? null]));
  const sizeNote = hasSize ? sizeLegend(leaves.map((n) => n.size), sizeName, c, fmtVal) : null;
  // Label ink per tile: the tile colour is the top-level node's category colour (by index), and every
  // descendant keeps that hue, so pick the ink with the best contrast against it (>= 4.5:1).
  const inks = [c.ink, c.surface, "#000000", "#ffffff"];
  const withInk = (node, ink) => ({ ...node, label: { ...node.label, color: ink }, ...(node.children ? { children: node.children.map((k) => withInk(k, ink)) } : {}) });
  // A colour measure: each leaf its own colour and ink; a parent the neutral grid colour behind its children.
  // Format → Opacity: a tile takes no itemStyle opacity, so its colour is drawn with alpha, and its ink is picked against the tile as it shows (the colour blended into the surface).
  const k = markOpacityOf(format);
  const seen = (hex) => (k < 1 ? mixHex(c.surface, hex, k) : hex);
  const paint = (node) => node.children
    ? { ...node, itemStyle: { color: withAlpha(c.grid, k) }, label: { color: c.ink }, children: node.children.map(paint) }
    : { ...node, itemStyle: { color: withAlpha(colourOf.get(node) ?? c.muted, k) }, label: { color: pickInk(seen(colourOf.get(node) ?? c.muted), inks) } };
  const data = hasColour ? tree.map(paint) : tree.map((n, i) => withInk(n, pickInk(seen(c.cat[i % c.cat.length]), inks)));
  const sub = (label, v) => (v == null ? "" : `<br><b>${escapeHtml(String(label))}:</b> ${fmtVal(v)}`);
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    ...(byValue?.legend ?? {}),
    ...(sizeNote ?? {}),
    tooltip: {
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => {
        const d = p.data ?? {};
        const head = `<span style="color:${c.muted}">${escapeHtml(String(p.name))}</span>`;
        if (d.size === undefined && d.colour === undefined) return `${head}<br><b>${fmtVal(p.value)}</b>`;
        return head + sub(sizeName || "size", d.size) + (d.shelf !== undefined && d.size !== undefined ? sub(shelfName || "value", d.shelf) : "") + sub(colourName || "colour", d.colour) + (d.size === undefined ? sub(shelfName || "value", d.shelf) : "");
      },
    },
    series: [{
      type: "treemap", data, roam: false, nodeClick: false,
      ...(sizeNote || byValue ? { top: sizeNote ? 30 : 6, bottom: byValue ? byValue.room + 6 : 6 } : {}), // a plain treemap keeps ECharts' own box
      breadcrumb: { show: false },
      label: { show: true, fontFamily: c.font, lineHeight: 16, formatter: (p) => (p.data?.size !== undefined && p.data?.shelf !== undefined ? `${p.name}\n${fmtVal(p.data.shelf)}` : p.name) },
      itemStyle: { ...edgeOr(format.markBorder, borderInk(format.markBorderColor, c), { borderColor: c.surface, borderWidth: 2 }), gapWidth: 2 },
      levels: hasColour ? [{}] : [{ color: k < 1 ? c.cat.map((h) => withAlpha(h, k)) : c.cat, colorMappingBy: "index" }],
    }],
  };
}

// histogram — equal-width numeric bins from the server; a gapless bar of counts.
// spec: { bins:[{x0, x1, count}], format }
function buildHistogram({ bins, whole = false, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = bins.map((b) => histogramLabel(b, whole, fmtVal));
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
      itemStyle: { color: c.series, ...edgeOr(format.markBorder, borderInk(format.markBorderColor, c), { borderColor: c.surface, borderWidth: 1 }) },
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
      itemStyle: { color: c.brandSoft, borderColor: c.series, ...pointEdge(format, c) },
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
const pointEdge = (format, c) => (format.markBorder && format.markBorder !== "none" ? markBorder(format.markBorder, borderInk(format.markBorderColor, c)) : {});
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
              { type: "rect", shape: { x: a[0] - w / 2, y: top, width: w, height: h, r: 2 }, style: { fill: colour[st.kind], ...(markOpacityOf(format) < 1 ? { opacity: markOpacityOf(format) } : {}), ...strokeOf(format.markBorder, borderInk(format.markBorderColor, c)) } },
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
      data, itemStyle: edgeOr(format.markBorder, borderInk(format.markBorderColor, c), { borderColor: c.surface, borderWidth: 1 }),
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
      { type: "bar", name, data: vals, barWidth: "24%", barGap: "-70%", z: 3, itemStyle: { color: c.ink, ...pointEdge(format, c) } },
      { type: "scatter", name: "Target", data: cats.map((_, i) => (ts[i] == null ? null : [ts[i], i])), symbol: "rect", symbolSize: [3, 26], z: 4,
        itemStyle: { color: c.series } },
    ],
  };
}

// gantt — one horizontal bar per row from its start to its end (start + length, or the end field), first row on top; the length
// is written at the bar's end and named in the tooltip. A Colour field makes one series per member (its own colour, a legend that
// highlights), several bars may share a row; a selected row keeps full strength and the others fade.
function buildGantt({ categories, gantt, name, format = {}, selectedIndices, onLegend, focus }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const { bars, isDate, hasTime, groups } = gantt;
  const at = (v) => (isDate ? ganttTime(v, hasTime) : fmtVal(v));
  const len = (b) => (isDate ? `${fmtVal(b.duration)} ${b.duration === 1 ? "day" : "days"}` : fmtVal(b.duration));
  const label = name || "Length";
  const axisTime = ganttAxisTime(bars, hasTime);
  const keep = new Set([].concat(selectedIndices ?? []).filter((i) => Number.isInteger(i) && i >= 0));
  // One series per colour member, else one for all the bars.
  const split = groups.length > 0;
  const lists = split ? groups.map((_, gi) => bars.filter((b) => b.group === gi)) : [bars];
  const colourOf = (gi) => (split ? memberColor(groups[gi], c.cat[gi % c.cat.length]) : c.cat[0]);
  const names = split ? groups : [label];
  return {
    color: names.map((_, gi) => colourOf(gi)),
    textStyle: { fontFamily: c.font, color: c.label },
    legend: { top: 0, left: "center", data: names, selectedMode: split && typeof onLegend === "function", textStyle: { color: c.label, fontFamily: c.font }, icon: "roundRect" },
    grid: { left: 6, right: ganttLabelMargin(bars.map(len)), top: 36, bottom: 6, containLabel: true },
    tooltip: { trigger: "item", ...tipBox(c),
      formatter: (p) => { const b = lists[p.seriesIndex]?.[p.dataIndex]; return b ? `<span style="color:${c.muted}">${escapeHtml(String(b.name ?? ""))}${split ? ` · ${escapeHtml(String(groups[b.group] ?? ""))}` : ""}</span><br>${at(b.start)} → ${at(b.end)}<br><b>${escapeHtml(label)}:</b> ${len(b)}` : ""; } },
    xAxis: valueAxis(c, isDate ? undefined : fmtVal, isDate
      ? { type: "time", axisLabel: { color: c.muted, formatter: (v) => ganttTime(v, axisTime), hideOverlap: true } } : { scale: true }),
    yAxis: catAxis(c, categories ?? [], { inverse: true }),
    series: lists.map((list, gi) => ({
      type: "custom", name: names[gi], data: list.map((b) => [b.i, b.start, b.end]), encode: { x: [1, 2], y: 0 }, emphasis: { focus: "series" },
      renderItem: (params, api) => {
        const b = list[params.dataIndex];
        const a = api.coord([api.value(1), api.value(0)]), e = api.coord([api.value(2), api.value(0)]);
        const h = Math.min(28, api.size([0, 1])[1] * 0.6);
        const opacity = (keep.size && !keep.has(b.i)) || (split && focus && names[gi] !== focus) ? 0.35 : 1; // a legend-focused member keeps full strength (ECharts does not blur custom marks)
        return { type: "group", children: [
          { type: "rect", shape: { x: a[0], y: a[1] - h / 2, width: Math.max(2, e[0] - a[0]), height: h, r: 2 }, style: { fill: colourOf(gi), opacity: opacity * markOpacityOf(format), ...strokeOf(format.markBorder, borderInk(format.markBorderColor, c)) }, emphasis: { style: { stroke: c.ink, lineWidth: 1 } } },
          { type: "text", style: { text: len(b), x: Math.max(e[0], a[0] + 2) + 4, y: a[1], align: "left", verticalAlign: "middle", fill: c.label, opacity, font: `14px ${c.font}` } },
        ] };
      } })),
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
      itemStyle: edgeOr(format.markBorder, borderInk(format.markBorderColor, c), { borderColor: c.surface, borderWidth: 1 }),
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
// Bubbles start at zero unless Format → Edit Sizes says otherwise; a dimension's members (`order`) are steps; the setting can reverse the sizes or keep
// them inside a part of the 8–36 px range.
function sizeScaler(values, accessor, { format, order } = {}) {
  const scale = sizeScaleOf(format);
  const nums = (values ?? []).map((v) => Number(v) || 0);
  const share = order ? memberShareFn(order.length, scale) : measureShareFn(nums, { zero: scale.fromZero ?? true, point: true, scale });
  return (val) => { const v = accessor ? accessor(val) : (Number(val) || 0); return 8 + (share(order ? v : Number(v) || 0) ?? 0) * (36 - 8); };
}
// The scale's ends: the data span unless Format pinned one.
// Unpinned, a heatmap keeps its plain data span (`plain`); a scatter always gets a non-empty one.
// A diverging scale has no pins (its ends follow the centre), so Format hides them and a stored pin is ignored.
const colourPinned = () => drawing?.colorScale !== "diverging" && (drawing?.colorMin != null || drawing?.colorMax != null);
// Use full colour range applies to a smooth diverging scale; steps already wear both end colours, so they keep the symmetric split.
const fullRangeOn = () => drawing?.colorScale === "diverging" && drawing?.colorFullRange === true && !drawing?.colorSteps;
const colourScaleRange = (nums, plain = false) => {
  if (drawing?.colorScale === "diverging") { // symmetric about the centre (so the middle colour sits on it), or each side its own span with Use full colour range
    const r = rangeOf(nums);
    return divergingRange(r.min, r.max, drawing?.colorCentre, fullRangeOn());
  }
  if (plain && !colourPinned()) { const v = nums.filter((x) => Number.isFinite(x)); return { min: v.length ? Math.min(...v) : 0, max: v.length ? Math.max(...v) : 1 }; }
  return rangeOf(nums, drawing?.colorMin, drawing?.colorMax);
};
// The ramp a range is drawn on: the token ramp, or (full range, an off-centre centre) stops resampled so the centre colour stays on the centre.
const rampOf = (range, c) => (range.full ? fullRangeRamp(c.ramp, range.min, range.max, range.centre) : c.ramp);
// A pinned end saturates: values beyond it take that end's colour (the visualMap clamps), so a pin never reads as "missing".
const outOfRangeNote = () => (colourPinned() ? "beyond range: end colour" : "");
// A diverging legend names its centre in words (never colour alone): "centre 0".
const centreNote = (range, fmtVal) => (drawing?.colorScale === "diverging" ? `centre ${fmtVal(range.centre ?? (range.min + range.max) / 2)}` : "");
// A continuous visualMap (the gradient legend) over `values`, coloured on the single-hue token ramp.
function continuousVisualMap(values, dimension, c, fmtVal, name) {
  const range = colourScaleRange((values ?? []).map((v) => Number(v)));
  const note = [name ? String(name) : "", centreNote(range, fmtVal), outOfRangeNote()].filter(Boolean).join(" · ");
  return colourLegend({ min: range.min, max: range.max, ramp: rampOf(range, c), dimension, c, fmtVal, note, bottom: 0 });
}
// The colour legend + its note as chart options: a gradient bar, or (Format → Steps) a piecewise legend whose
// swatches are labelled with their boundaries in words. A piecewise legend has no text slot, so its note is a title.
// A Diverging ramp's centre is the surface, which vanishes against the page; stepped, it is the surface nudged toward
// the ink so the neutral step reads as a swatch and a cell in both themes (a continuous gradient keeps the surface).
const stepRamp = (c) => (c.ramp.length === 3 ? [c.ramp[0], mixHex(c.surface, c.ink, 0.15), c.ramp[2]] : c.ramp);
// `only` = a display-only legend for marks coloured by `valueColours` (a bar, a line, a slice, a tile): it drives no series, so its handles and steps are inert.
function colourLegend({ min, max, ramp, dimension, c, fmtVal, note, bottom, only = false }) {
  const textStyle = { color: c.muted, fontFamily: c.font };
  const n = drawing?.colorSteps ?? 0;
  const inert = only ? { seriesIndex: [], hoverLink: false } : {}; // no hover link either: a hover would re-draw the marks under the pointer and swallow the click
  if (!n) {
    return { visualMap: { type: "continuous", min, max, dimension, calculable: !only, ...inert, orient: "horizontal", left: "center", bottom,
      inRange: { color: ramp ?? c.ramp }, text: note ? [note, ""] : undefined, textStyle, formatter: (v) => fmtVal(v) } };
  }
  return {
    visualMap: { type: "piecewise", dimension, ...inert, ...(only ? { selectedMode: false } : {}), orient: "horizontal", left: "center", bottom, itemWidth: 16, itemHeight: 12, itemGap: 8,
      pieces: stepPieces(min, max, n, stepRamp(c), fmtVal), textStyle },
    ...(note ? { title: { text: note, left: "center", bottom: bottom + 24, textStyle: { ...textStyle, fontSize: 14, fontWeight: "normal" } } } : {}),
  };
}
// The room a colour legend takes under the plot: its row, plus the note's title row when stepped.
const legendRoom = (legend) => 24 + (legend.title ? 24 : 0);
// Each value's colour on the legend's own scale (the same range, ramp, pins, centre and steps as the visualMap), for marks ECharts'
// visualMap can't reach (a bar, a line stretch, a slice, a tile). A missing value has no colour (null).
function valueColours(values, c) {
  const nums = (values ?? []).map((v) => (v == null || v === "" ? NaN : Number(v)));
  const range = colourScaleRange(nums);
  const { min, max } = range, ramp = rampOf(range, c);
  const n = drawing?.colorSteps ?? 0;
  const stepCols = n ? stepColours(stepRamp(c), n) : null;
  const ec = window.echarts.color;
  const at = (v) => {
    if (stepCols) { const i = stepIndexOf(v, min, max, n); return i == null ? null : stepCols[i]; }
    const t = positionOf(v, min, max);
    return t == null ? null : hexOf(ec.parse(ec.lerp(t, ramp)));
  };
  return { min, max, centre: range.centre, ramp, colours: nums.map(at) };
}
// [r, g, b] (echarts.color.parse) as #rrggbb.
const hexOf = ([r, g, b]) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
// A colour measure on a bar / line / area / pie / tile: per-mark colours plus the display-only legend (and the room it needs).
function colourByValue(values, c, fmtVal, name, bottom = 0) {
  const vc = valueColours(values, c);
  const note = [name ? String(name) : "", centreNote(vc, fmtVal), outOfRangeNote()].filter(Boolean).join(" · ");
  const legend = colourLegend({ min: vc.min, max: vc.max, ramp: vc.ramp, dimension: 2, c, fmtVal, note, bottom, only: true });
  return { colours: vc.colours, legend, room: legendRoom(legend) + bottom };
}
// A line's stroke (and area fill) coloured stretch by stretch: a linear gradient across the line's own extent, a colour at each point
// (hard bands when stepped). A point with no colour keeps its neighbour's.
function lineGradient(colours, vertical, fallback) {
  const first = colours.find((x) => x) ?? fallback;
  let last = first;
  const cols = colours.map((x) => (last = x ?? last));
  const n = cols.length;
  if (n < 2) return cols[0] ?? fallback;
  const stops = [];
  cols.forEach((col, i) => {
    if (drawing?.colorSteps) stops.push({ offset: Math.max(0, (i - 0.5) / (n - 1)), color: col }, { offset: Math.min(1, (i + 0.5) / (n - 1)), color: col });
    else stops.push({ offset: i / (n - 1), color: col });
  });
  return { type: "linear", x: 0, y: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0, colorStops: stops };
}
// The Size legend, in words (never size alone): the field and its smallest and largest value (or member), at the top right of the chart.
// `opts.order` = a dimension's member names smallest step first; `opts.reversed` says the scale runs the other way.
function sizeLegend(values, name, c, fmtVal, top = 2, opts = {}) {
  const r = sizeRange(values);
  if (!name || (!opts.order && !r)) return null;
  const text = sizeLegendText(name, { range: r, members: opts.order, reversed: opts.reversed, fmtVal });
  return { graphic: [{ type: "text", right: 18, top, silent: true, style: { text, fill: c.muted, font: `14px ${c.font}`, textAlign: "right" } }] };
}
// A cartesian chart's Size as shares: { fr[series][category] (0..1), grid (the values), flat }, or null where Size isn't drawn. Beside a Colour split
// (`sizeGrid`, one row per member series) every bar / marker has its own cell; otherwise one array serves every series. A dimension's `sizeOrder`
// makes the values steps; a measure shares the data's span (Format → Edit Sizes: reversed, a smallest..largest part of the range, From zero).
function cartesianSizes({ sizes, sizeGrid, sizeOrder, type, mainCount, format }) {
  const have = sizeGrid ?? (Array.isArray(sizes) ? Array.from({ length: mainCount }, () => sizes) : null);
  if (!have || !drawsSize(type, sizeGrid ? 1 : mainCount)) return null;
  const scale = sizeScaleOf(format);
  const flat = (sizeGrid ?? [sizes]).flat();
  const share = sizeOrder ? memberShareFn(sizeOrder.length, scale) : measureShareFn(flat, { zero: scale.fromZero ?? false, scale });
  return { fr: have.map((row) => row.map(share)), grid: have, flat };
}
const isObjectItem = (d) => d !== null && typeof d === "object" && !Array.isArray(d);
// Format → Line markers None: every dot `clear` names stays in the option (a label's anchor, a hover target) but is filled and bordered "transparent" — not given
// opacity 0, which a label sitting on it would inherit. Hovering restores the dot's own fill and border; the series' mark opacity still applies to both.
const clearDots = (items, clear, { color, edge }) => items.map((d, di) => {
  if (d == null || !clear(di)) return d;
  const own = isObjectItem(d) ? d : { value: d }, fill = own.itemStyle?.color ?? color;
  return { ...own, itemStyle: { ...own.itemStyle, color: "transparent", ...(edge ? { borderColor: "transparent" } : {}) }, emphasis: { itemStyle: { color: fill, ...(edge ?? {}) } } };
});
// A bar chart whose bars vary in thickness with a Size measure: ECharts has no per-bar width, so the bars are a custom series that
// draws each rectangle itself (value = [position, value, size], swapped when horizontal). Rounded growing end, per-item colour (colour
// measure, Other, Colour by category) from the item's own style, a label per bar, and the same tooltip / click / selection fade as a bar.
function variableBars({ s, color, sizeFr, sizes, slot = { at: 0, of: 1 }, horizontal, c, edge, fillAt, dataLabel, hover = false }) {
  const radius = horizontal ? [0, c.radius, c.radius, 0] : [c.radius, c.radius, 0, 0];
  const item = (v, di) => {
    const fill = fillAt(di); // the Other bar, a colour measure's value, or a category's colour; else the series colour
    return { value: horizontal ? [v, di, sizes[di]] : [di, v, sizes[di]], ...(fill ? { itemStyle: { color: fill } } : {}) };
  };
  return {
    name: s.name, type: "custom", encode: { x: 0, y: 1 },
    data: s.data.map((v, di) => item(v, di)),
    itemStyle: { color, ...edge },
    emphasis: { focus: hover ? "self" : "series", itemStyle: { opacity: 0.85 } },
    renderItem: (params, api) => {
      const di = params.dataIndex, v = s.data[di];
      if (v == null || !Number.isFinite(Number(v))) return null;
      const band = api.size(horizontal ? [0, 1] : [1, 0])[horizontal ? 1 : 0];
      const room = band / slot.of, shift = (slot.at - (slot.of - 1) / 2) * room; // beside a Colour split the members' bars share the band, side by side
      const th = barThickness(sizeFr[di], room);
      const base = horizontal ? api.coord([0, di]) : api.coord([di, 0]);
      const tip = horizontal ? api.coord([Number(v), di]) : api.coord([di, Number(v)]);
      const shape = horizontal
        ? { x: Math.min(base[0], tip[0]), y: tip[1] + shift - th / 2, width: Math.abs(tip[0] - base[0]), height: th, r: radius }
        : { x: tip[0] + shift - th / 2, y: Math.min(base[1], tip[1]), width: th, height: Math.abs(base[1] - tip[1]), r: radius };
      return { type: "rect", shape, style: api.style(), emphasis: { style: api.styleEmphasis() },
        ...(dataLabel ? { textContent: { style: { text: dataLabel(di, v), fill: c.label, font: `14px ${c.font}`, ...(hover ? { opacity: 0 } : {}) }, ...(hover ? { emphasis: { style: { opacity: 1 } } } : {}) }, textConfig: { position: horizontal ? "right" : "top" } } : {}) }; // Highlighted: the label is there but unseen until the bar is highlighted
    },
  };
}
// A straight line whose own thickness follows Size: ECharts draws one stroke width per line, so a silent custom series draws one quadrilateral per
// segment (its width tapering from one point's thickness to the next, in the line's colour or the colour measure's value at the segment's end) beneath
// the real line, which keeps the markers, tooltip, click and legend. It shares the line's name, so one legend entry toggles both.
const WIDTH_ID = "size-width:";
function thickLine({ s, i, share, horizontal, stroke, color, axis, opacity = 1 }) {
  const at = (di) => (horizontal ? [Number(s.data[di]), di] : [di, Number(s.data[di])]);
  return {
    id: `${WIDTH_ID}${i}`, name: s.name, type: "custom", silent: true, z: 2, yAxisIndex: axis, encode: { x: 0, y: 1 }, tooltip: { show: false },
    data: s.data.map((v, di) => (horizontal ? [v, di] : [di, v])),
    renderItem: (params, api) => {
      const di = params.dataIndex;
      if (di >= s.data.length - 1 || s.data[di] == null || s.data[di + 1] == null) return null;
      const p0 = api.coord(at(di)), p1 = api.coord(at(di + 1));
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len, w0 = lineWidthFor(share[di]) / 2, w1 = lineWidthFor(share[di + 1]) / 2;
      return { type: "polygon", silent: true, shape: { points: [[p0[0] + nx * w0, p0[1] + ny * w0], [p1[0] + nx * w1, p1[1] + ny * w1], [p1[0] - nx * w1, p1[1] - ny * w1], [p0[0] - nx * w0, p0[1] - ny * w0]] },
        style: { fill: stroke?.[di + 1] ?? stroke?.[di] ?? color, ...(opacity < 1 ? { opacity } : {}) } };
    },
  };
}
// The user's tooltip template → safe HTML. `measures` maps a measure name → its formatted value for
// this mark (raw numbers, formatted by tipLookup); group-by / mark fields come from `tooltipFields` ([{ name, values }] by dataIndex).
function customTip(text, tooltipFields, style, formats, fmtVal, format, dataIndex, measures) {
  const dims = new Map((tooltipFields ?? []).map((f) => [f.name, f.values?.[dataIndex]]));
  return tooltipHtml(text, tipLookup({ measures, dims, formats, fmtVal, format }), style); // raw measure values; per-field formats (tooltip-formats.js)
}
// Extra tooltip lines for the Tooltip encoding: one "<field>: <value>" per chosen field.
function extraTooltip(tooltipExtra, dataIndex, c) {
  if (!Array.isArray(tooltipExtra) || !tooltipExtra.length) return "";
  return tooltipExtra
    .map((t) => `<br><span style="color:${c.muted}">${escapeHtml(String(t.name))}:</span> ${escapeHtml(String(t.values?.[dataIndex] ?? ""))}`)
    .join("");
}
