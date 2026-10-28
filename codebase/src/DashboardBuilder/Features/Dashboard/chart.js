import { makeValueFormatter } from "../Core/format.js";
import { pickInk } from "./contrast.js";
import { tooltipHtml } from "./tooltip-model.js";
import { chartFit, markCount, applyFitMode, FIT } from "./chart-fit.js";

// Charting adapter (P9; formatting P10). Renders worksheet results through the self-hosted ECharts library
// (wwwroot/js/vendor/echarts.min.js, loaded as a global before the module graph — no CDN).
// The rest of the app stays vanilla-JS: this is a thin mapper from our { categories, series }
// result to an ECharts option, themed entirely from the CSS design tokens so charts match the
// RED/BLACK/WHITE system. One live instance at a time; call disposeChart() before re-rendering.
//
// Series: one per measure (multiple Rows/Columns measures → multiple series); the category axis
// carries the concatenated dimension keys. A single series wears the brand accent; multiple series
// draw from the dataviz-validated categorical palette in fixed order (with a legend, since identity
// must never be colour-alone). See references/palette.md and site.css --chart-cat-*.

let instance = null;
let resizeObserver = null;
let lastOption = null; // the option on screen — re-drawn as SVG for export when the chart is on canvas
let onCanvas = false;

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
  const catFallback = ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834", "#4a3aa7", "#e34948"];
  const cat = catFallback.map((hex, i) => t(`--chart-cat-${i + 1}`, hex));
  return {
    series: t("--chart-series", "#c4142c"),
    cat,
    axis: t("--chart-axis", "#d9cfd1"),
    grid: t("--chart-grid", "#ebe4e5"),
    label: t("--chart-label", "#423a3d"),
    muted: t("--chart-muted", "#6b6165"),
    surface: t("--surface", "#ffffff"),
    ink: t("--ink", "#1c1719"),
    font: t("--font", "system-ui, sans-serif"),
    // Brand stops for the sequential heatmap ramp (single-hue soft→saturated, token-driven).
    brand: t("--accent", "#c4142c"),
    brandSoft: t("--accent-soft", "#fdeff1"),
  };
}

/**
 * Render a chart into `container`. Types (P11): cartesian `bar` (grouped when ≥2 measures),
 * `stacked`, `line`, `area`, `combo` (dual-axis: 1st measure bars, rest line on a 2nd axis);
 * circular `pie` / `donut` (1 dimension × 1 measure); and `scatter` (two measures → X, Y).
 * One series per measure; the category axis carries the concatenated dimension keys.
 * @param container the #ws-chart element (a positioned host is created inside it)
 * @param spec { type, categories: string[], series: [{ name, data: number[] }],
 *              format?: sheet format config (P10 — value/date format, axis titles, legend, labels, colour-by) }
 */
export function renderChart(container, spec) {
  disposeChart();
  const host = document.createElement("div");
  host.className = "ws-chart-canvas";
  container.append(host);

  // Every category keeps a slot and a label: a chart with more categories than fit takes the room it
  // needs and the pane (#ws-chart) scrolls, instead of squeezing bars and skipping labels.
  const inset = () => 2 * parseFloat(getComputedStyle(host).left || 0);
  const paneWidth = () => container.clientWidth - inset();
  const paneHeight = () => container.clientHeight - inset();
  const fitMode = spec.format?.fit ?? "standard"; // P23 Format → Fit
  let fit = applyFitMode(chartFit(spec, paneWidth(), paneHeight()), fitMode);
  host.style.setProperty("--chart-min-w", `${fit.minWidth}px`);
  host.style.setProperty("--chart-min-h", `${fit.minHeight}px`);

  // SVG renderer: crisp at any zoom, no canvas-sizing surprises, lighter DOM for our small charts. A
  // big chart (thousands of marks) draws on canvas instead — SVG slows down with that many nodes.
  onCanvas = markCount(spec) > FIT.canvasMarks;
  instance = window.echarts.init(host, null, { renderer: onCanvas ? "canvas" : "svg" });
  const option = buildOption(spec.type === "multiples" ? { ...spec, width: paneWidth(), height: paneHeight() } : spec);
  if (spec.type !== "multiples") showEveryCategory(option, fit.rotate, fit); // panels keep their own sparse labels
  if (fit.zoom) addZoom(option, fit);
  if (onCanvas) tuneForSize(option);
  lastOption = option;
  instance.setOption({ ...option, ...motionOption(animateNext && !onCanvas) });

  // P15 click-to-filter: forward mark clicks to the caller, which maps dataIndex → a dimension value.
  if (typeof spec.onSelect === "function") instance.on("click", (p) => { if (p.componentType !== "legend") spec.onSelect(p); });
  // P29: a legend click highlights (and can select) instead of hiding the series — ECharts toggles the
  // item, so every item is shown again straight away and the click goes to the worksheet.
  if (typeof spec.onLegend === "function") instance.on("legendselectchanged", (p) => {
    instance.dispatchAction({ type: "legendAllSelect" });
    // Next tick: the worksheet may re-render (dispose this instance) — not while ECharts is mid-event.
    setTimeout(() => spec.onLegend(p.name), 0);
  });
  if (spec.focus) focusSeries(spec.focus, spec.type);

  resizeObserver = new ResizeObserver(() => {
    if (!instance) return;
    instance.resize();
    const next = applyFitMode(chartFit(spec, paneWidth(), paneHeight()), fitMode);
    if (next.rotate !== fit.rotate) {
      fit = next;
      instance.setOption({ xAxis: [].concat(option.xAxis).map(() => ({ axisLabel: { rotate: fit.rotate } })) });
    }
  });
  resizeObserver.observe(host);
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
    // A fitted axis (P23) shares the pane: labels thin out instead of forcing a slot each.
    if (bottom ? fit.fittedX : fit.fittedY) return { ...axis, axisLabel: { ...axis.axisLabel, hideOverlap: true, width: bottom ? FIT.labelMax : FIT.sideMax, overflow: "truncate" } };
    return { ...axis, axisLabel: { ...axis.axisLabel, interval: 0, hideOverlap: false,
      width: bottom ? FIT.labelMax : FIT.sideMax, overflow: "truncate", ...(bottom ? { rotate } : {}) } };
  };
  const each = (axes, bottom) => (Array.isArray(axes) ? axes.map((a) => fix(a, bottom)) : fix(axes, bottom));
  if (option.xAxis) option.xAxis = each(option.xAxis, true);
  if (option.yAxis) option.yAxis = each(option.yAxis, false);
}

/** P29: highlight one series (or a pie slice) and dim the rest; null clears. */
export function focusSeries(name, type) {
  if (!instance) return;
  instance.dispatchAction({ type: "downplay" });
  if (name == null) return;
  if (type === "pie" || type === "donut" || type === "funnel") instance.dispatchAction({ type: "highlight", name });
  else instance.dispatchAction({ type: "highlight", seriesName: name });
}

/** Is there a live ECharts instance to export? (Table/KPI render as native DOM, so there isn't.) */
export function hasChartInstance() { return instance !== null; }

// Motion: a short, decelerating entrance (300ms, not ECharts' default 1s) when the data is fresh from
// ClickHouse; none when re-rendering a cached result or under prefers-reduced-motion.
let animateNext = true;
/** Draw the live chart at a fixed size (printing), or back to its pane's size with null. */
export function sizeChart(size) {
  if (!instance) return;
  instance.resize(size ? { ...size, animation: { duration: 0 } } : { width: "auto", height: "auto", animation: { duration: 0 } });
}

/** Whether the next renderChart animates its entrance (the worksheet sets this per result). */
export function animateNextChart(on) { animateNext = Boolean(on); }
function motionOption(on) {
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return on && !reduce
    ? { animation: true, animationDuration: 300, animationEasing: "cubicOut", animationDurationUpdate: 250, animationEasingUpdate: "cubicInOut" }
    : { animation: false };
}

/**
 * Export the current chart as an image (P13). We use the SVG renderer, so the SVG is already in the
 * DOM — we serialise that element (robust across ECharts builds; `renderToSVGString` only exists on
 * SSR instances). PNG is rasterised from the SVG through a canvas. Returns { blob, ext } or null.
 * @param kind "svg" | "png"
 */
export async function exportChart(kind) {
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
    const svg = offscreenSvg(w, h);
    return svg ? { blob: new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), ext: "svg" } : null;
  }

  let svg = currentSvgString(w, h);
  if (!svg) return null;
  if (kind === "svg") return { blob: new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), ext: "svg" };
  const blob = await svgToPng(svg, w, h);
  return blob ? { blob, ext: "png" } : null;
}

// Draw the on-screen option once more with the SVG renderer, in a detached box of the same size.
function offscreenSvg(w, h) {
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
function currentSvgString(w, h) {
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
export function disposeChart() {
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
  if (instance) { instance.dispose(); instance = null; }
  lastOption = null; onCanvas = false;
}

// Dispatch by chart-type family (P11): circular (pie/donut), scatter (two value axes), or the
// shared cartesian builder (bar/stacked/line/area/combo).
function buildOption(spec) {
  if (spec.type === "pie" || spec.type === "donut") return buildPie(spec);
  if (spec.type === "scatterShapes") return buildScatterShapes(spec); // P19 shape-split scatter
  if (spec.type === "scatter" || spec.type === "square" || spec.type === "circle") return buildScatter(spec); // P19 point marks
  if (spec.type === "heatmap") return buildHeatmap(spec);
  if (spec.type === "treemap") return buildTreemap(spec);
  if (spec.type === "histogram") return buildHistogram(spec);
  if (spec.type === "boxplot") return buildBoxplot(spec);
  // P36 types.
  if (spec.type === "waterfall") return buildWaterfall(spec);
  if (spec.type === "funnel") return buildFunnel(spec);
  if (spec.type === "gauge") return buildGauge(spec);
  if (spec.type === "bullet") return buildBullet(spec);
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
function buildCartesian({ type, categories, series, format = {}, orientation = "vertical", pointLabels, tooltipExtra, tooltipText, tooltipFields, otherIndex = -1, analytics = null }) {
  const c = tokens();
  const labels = (categories ?? []).map((l) => l ?? "—");
  // P35 comparison series (compare: true) ride beside their measure: they don't make a chart "multi"
  // (the main series keeps the brand colour), but they do bring the legend so the dashed line is named.
  const mainCount = series.filter((s) => !s.compare).length;
  const hasCompare = mainCount < series.length;
  const multi = mainCount > 1;
  const isCombo = type === "combo";
  const horizontal = orientation === "horizontal" && !isCombo;
  const fmtVal = makeValueFormatter(format); // P10 — measure value format (tooltip, axis, labels)

  const colorFor = (i) => (multi ? c.cat[i % c.cat.length] : c.series);
  // Colour-by-dimension (P10): a single-measure bar chart colours each bar by its category. The
  // category axis already labels each bar, so colour restates identity (never colour-alone).
  const colorByDim = type === "bar" && !multi && !!format.colorByDimension;

  const { show: showLegend, pos, legend } = legendFor(format, c, series.map((s) => s.name), multi || isCombo || hasCompare);
  const xTitle = format.xTitle || null;
  const yTitle = format.yTitle || null;

  // P18 Label: when a Label field is mapped, marks show its per-row value; otherwise the P10 toggle
  // shows the measure value. `pointLabels` is indexed by category (dataIndex).
  const labelPos = horizontal ? "right" : "top";
  const dataLabel = (pointLabels || format.dataLabels)
    ? { show: true, position: labelPos, color: c.label, fontFamily: c.font, fontSize: 11,
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
  if (isCombo) {
    // Combo: category on x, dual value axes on y (unchanged).
    xAxis = withName(categoryAxis, xTitle, true);
    yAxis = [
      withName(valueAxisBase(), yTitle || series[0]?.name, false),
      { ...withName(valueAxisBase({ position: "right", splitLine: { show: false } }), series[1]?.name, false) },
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
      right: 18 + (showLegend && pos === "right" ? 96 : 0) + (isCombo ? 36 : 0),
      top: 18 + (showLegend && pos === "top" ? 18 : 0) + (yTitle || isCombo ? 18 : 0),
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
        if (tooltipText) return customTip(tooltipText, tooltipFields, arr[0].dataIndex, Object.fromEntries(arr.map((d) => [String(d.seriesName), fmtVal(d.value)]))); // T01-19
        const head = `<span style="color:${c.muted}">${escapeHtml(String(arr[0].axisValueLabel ?? arr[0].name ?? ""))}</span>`;
        const lines = arr.map((d) =>
          `<br><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${d.color};margin-right:6px"></span>` +
          `<b>${escapeHtml(String(d.seriesName))}:</b> ${fmtVal(d.value)}`).join("");
        return head + lines + extraTooltip(tooltipExtra, arr[0].dataIndex, c); // P18 custom tooltip fields
      },
    },
    xAxis,
    yAxis,
  };

  base.series = series.map((s, i) => {
    // A comparison series wears its measure's colour, faded and dashed (line) or muted (bar).
    if (s.compare) {
      const color = colorFor(i - mainCount);
      const asLine = type === "line" || type === "area";
      return asLine
        ? { name: s.name, type: "line", data: s.data, showSymbol: false, z: 1,
            lineStyle: { width: 2, type: "dashed", color, opacity: 0.7 }, itemStyle: { color, opacity: 0.7 }, emphasis: { focus: "series" } }
        : { name: s.name, type: "bar", data: s.data, barMaxWidth: 40,
            // Hatched as well as faded, so it reads as "the other period" without relying on colour.
            itemStyle: { color: c.muted, opacity: 0.55, borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
              decal: { symbol: "rect", symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: c.surface } },
            emphasis: { itemStyle: { opacity: 0.8 } } };
    }
    const color = colorFor(i);
    // line/area always draw as a line; in a combo the 1st measure is a bar and the rest are lines.
    const asLine = type === "line" || type === "area" || (isCombo && i >= 1);
    if (asLine) {
      return {
        name: s.name, type: "line",
        yAxisIndex: isCombo ? 1 : 0,
        data: s.data,
        showSymbol: s.data.length <= 60,     // dots only when they won't crowd
        symbolSize: 8,                        // ≥8px markers (dataviz mark spec)
        areaStyle: type === "area" ? { opacity: 0.18, color } : undefined,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        label: dataLabel,
        emphasis: { focus: "series" },
      };
    }
    const stacked = type === "stacked";
    // Round the "growing" end of the bar: top for vertical, right for horizontal; none when stacked.
    const barRadius = stacked ? [0, 0, 0, 0] : (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]);
    // The "Other" bar (everything past the limit) wears the muted ink (≥ 3:1 on the surface, apart from
    // the series hue); its label says what it is.
    const otherItem = (v) => ({ value: v, itemStyle: { color: c.muted, borderRadius: barRadius } });
    return {
      name: s.name, type: "bar",
      yAxisIndex: 0,
      stack: stacked ? "total" : undefined,
      // Colour-by-dimension: per-bar colours; otherwise the series colour.
      data: colorByDim
        ? s.data.map((v, di) => (di === otherIndex ? otherItem(v) : { value: v, itemStyle: { color: c.cat[di % c.cat.length], borderRadius: barRadius } }))
        : s.data.map((v, di) => (di === otherIndex ? otherItem(v) : v)),
      barMaxWidth: 40,
      itemStyle: { color, borderRadius: barRadius },
      label: dataLabel,
      emphasis: { focus: "series", itemStyle: colorByDim ? { opacity: 0.85 } : { color, opacity: 0.85 } },
    };
  });
  if (analytics) addAnalytics(base, analytics, { c, fmtVal, horizontal });
  return base;
}

// P21 analytics overlays on a cartesian chart: a dashed reference line (labelled with its value), a
// shaded band (labelled), and a dotted trend line named at its end — each carries words, never colour alone.
function addAnalytics(base, a, { c, fmtVal, horizontal }) {
  const s0 = base.series[0];
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
      label: { show: true, formatter: `Band ${fmtVal(a.band.from)}–${fmtVal(a.band.to)}`, color: c.muted, fontFamily: c.font, position: "insideTopLeft" },
      data: [[{ [axis]: a.band.from }, { [axis]: a.band.to }]] };
  }
  if (a.trend) {
    base.series.push({ name: a.trend.name, type: "line", data: a.trend.data, showSymbol: false, z: 4, animation: false,
      lineStyle: { width: 2, type: "dotted", color: c.muted }, itemStyle: { color: c.muted },
      endLabel: { show: true, formatter: a.trend.short ?? a.trend.name, color: c.muted, fontFamily: c.font, fontSize: 11 },
      tooltip: { valueFormatter: fmtVal } });
    base.grid.right = (Number(base.grid.right) || 0) + 84; // room for the short end label
  }
}

// pie / donut — one dimension (slices) × one measure (size). Colour IS the encoding, so a legend
// shows by default (dataviz: identity never colour-alone; the legend supplies the labels).
function buildPie({ type, categories, series, format = {}, pointLabels, tooltipExtra, tooltipText, tooltipFields, otherIndex = -1 }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = (categories ?? []).map((l) => l ?? "—");
  const data = labels.map((name, i) => ({ name, value: series[0].data[i], ...(i === otherIndex ? { itemStyle: { color: c.muted } } : {}) }));
  const { pos, legend } = legendFor(format, c, labels, true);
  const showLabels = !!format.dataLabels || !!pointLabels; // P18 Label field forces slice labels on

  return {
    color: c.cat,
    textStyle: { fontFamily: c.font, color: c.label },
    legend,
    tooltip: {
      trigger: "item",
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => tooltipText
        ? customTip(tooltipText, tooltipFields, p.dataIndex, { [String(series[0].name)]: fmtVal(p.value), Percent: `${p.percent}%` }) // T01-19
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
      itemStyle: { borderColor: c.surface, borderWidth: 2 },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.2)" } },
    }],
  };
}

// scatter — two measures map to the X and Y value axes; dimension keys label the points. P18 marks:
// `sizes` scales the symbol (bubble), `colorValues` ramps a continuous gradient (visualMap legend),
// `pointLabels` writes a field on each point, `tooltipExtra` appends field lines to the tooltip.
function buildScatter({ categories, series, format = {}, sizes, sizeName, colorValues, colorName, pointLabels, tooltipExtra, tooltipText, tooltipFields, symbol }) {
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
    return { value: arr, name, ...(colorByDim ? { itemStyle: { color: c.cat[i % c.cat.length] } } : {}) };
  });
  const symbolSize = sizeDim >= 0 ? sizeScaler(sizes, (v) => v[sizeDim]) : 14;
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
        ? customTip(tooltipText, tooltipFields, p.dataIndex, { [xName]: fmtVal(p.value[0]), [yName]: fmtVal(p.value[1]),
          ...(sizeDim >= 0 ? { [sizeName || "size"]: fmtVal(p.value[sizeDim]) } : {}),
          ...(colorDim >= 0 ? { [colorName || "colour"]: fmtVal(p.value[colorDim]) } : {}) }) // T01-19
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
      type: "scatter", data, symbolSize, symbol: symbol || "circle", // P19 square/circle marks
      itemStyle: colorByDim || continuous ? {} : { color: c.series, opacity: 0.8 },
      label: (pointLabels || format.dataLabels)
        ? { show: true, position: "top", color: c.muted, fontFamily: c.font, fontSize: 11,
            formatter: (p) => (pointLabels ? String(pointLabels[p.dataIndex] ?? "") : String(p.name ?? "")) }
        : { show: false },
      emphasis: { focus: "self", itemStyle: { borderColor: c.ink, borderWidth: 1 } },
    }],
  };
}

// scatterShapes (P19) — one scatter series per Shape-dimension value, each a distinct symbol so
// identity survives greyscale (shape is a non-colour channel). X/Y are the two shelf measures; an
// optional Size dim scales the symbol. spec: { groups:[{name, points:[{value:[x,y,size?], name}]}],
// xName, yName, hasSize, sizeName, format }.
const SHAPE_SYMBOLS = ["circle", "rect", "triangle", "diamond", "roundRect", "pin", "arrow"];
function buildScatterShapes({ groups, xName, yName, hasSize, sizeName, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const allSizes = hasSize ? groups.flatMap((g) => g.points.map((p) => p.value[2])) : null;
  const symbolSize = hasSize ? sizeScaler(allSizes, (v) => v[2]) : 12;
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
      data: g.points, itemStyle: { color: c.cat[i % c.cat.length], opacity: 0.85 },
      emphasis: { focus: "series", itemStyle: { borderColor: c.ink, borderWidth: 1 } },
    })),
  };
}

// heatmap (P12) — two dimensions on the axes, one measure as colour intensity. Colour IS a channel
// here, so a continuous visualMap legend accompanies it (identity also comes from the x/y labels).
// spec: { xCats:string[], yCats:string[], cells:[[xi, yi, value]], format }
function buildHeatmap({ xCats, yCats, cells, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const vals = cells.map((d) => d[2]).filter((v) => v != null);
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
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
      type: "category", data: xCats, splitArea: { show: true },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      axisLabel: { color: c.muted, hideOverlap: true },
    },
    yAxis: {
      type: "category", data: yCats, splitArea: { show: true },
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      axisLabel: { color: c.muted },
    },
    visualMap: {
      min, max, calculable: true, orient: "horizontal", left: "center", bottom: 6,
      inRange: { color: [c.brandSoft, c.brand] },   // single-hue sequential (soft → saturated), tokens
      textStyle: { color: c.muted, fontFamily: c.font }, formatter: (v) => fmtVal(v),
    },
    series: [{
      type: "heatmap", data: cells,
      label: { show: !!format.dataLabels, color: c.ink, fontFamily: c.font, formatter: (p) => fmtVal(p.value[2]) },
      itemStyle: { borderColor: c.surface, borderWidth: 1 },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(0,0,0,0.25)" } },
    }],
  };
}

// treemap (P12) — nested rectangles sized by a measure; one or two dimensions form the hierarchy.
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
      itemStyle: { borderColor: c.surface, borderWidth: 2, gapWidth: 2 },
      levels: [{ color: c.cat, colorMappingBy: "index" }],
    }],
  };
}

// histogram (P12) — equal-width numeric bins from the server; a gapless bar of counts.
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
      label: { show: !!format.dataLabels, position: "top", color: c.label, fontFamily: c.font, fontSize: 11, formatter: (p) => fmtVal(p.value) },
      emphasis: { itemStyle: { opacity: 0.85 } },
    }],
  };
}

// boxplot (P12) — five-number summary per group from the server.
// spec: { boxes:[{ label, min, q1, median, q3, max }], format }
function buildBoxplot({ boxes, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = boxes.map((b) => (b.label == null ? "—" : String(b.label)));
  const data = boxes.map((b) => [b.min, b.q1, b.median, b.q3, b.max]);
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
    }],
  };
}

// --- P36 chart types ----------------------------------------------------------
const tipBox = (c) => ({ backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1, textStyle: { color: c.ink, fontFamily: c.font } });
const valueAxis = (c, fmtVal, extra = {}) => ({
  type: "value", axisLine: { show: false }, axisTick: { show: false },
  splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, formatter: fmtVal }, ...extra,
});
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
                  align: "center", verticalAlign: "bottom", fill: c.label, font: `11px ${c.font}` } },
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
      data, itemStyle: { borderColor: c.surface, borderWidth: 1 },
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
      title: { offsetCenter: [0, "34%"], color: c.label, fontFamily: c.font, fontSize: 13 },
      detail: { offsetCenter: [0, "4%"], valueAnimation: true, color: c.ink, fontFamily: c.font, fontSize: 28, fontWeight: 600,
        formatter: () => (target != null ? `${fmtVal(v)}\n{t|${((v / max) * 100).toFixed(0)}% of ${fmtVal(target)}}` : fmtVal(v)),
        rich: { t: { fontSize: 12, color: c.muted, fontWeight: 400, padding: [6, 0, 0, 0] } } },
      data: [{ value: Math.min(v, max), name }],
    }],
  };
}

// bullet — per category, the actual value (a dark bar) over three bands (< 50 %, 50–75 %, 75–100 % of
// target) with the target as a tick. Horizontal, first category on top.
function buildBullet({ categories, values, target, name, format = {} }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const t = Number(target);
  const cats = categories ?? [];
  const vals = (values ?? []).map((v) => Number(v) || 0);
  const max = niceMax(Math.max(t * 1.1, ...vals));
  const band = (from, to) => cats.map(() => t * (to - from));
  const bands = [["Below 50% of target", 0, 0.5, 0.12], ["50–75%", 0.5, 0.75, 0.22], ["75–100%", 0.75, 1, 0.32]];
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    legend: { top: 0, left: "center", textStyle: { color: c.label, fontFamily: c.font }, data: [name, "Target", ...bands.map((b) => b[0])] },
    grid: { left: 6, right: 24, top: 36, bottom: 6, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, ...tipBox(c),
      formatter: (p) => { const i = (Array.isArray(p) ? p[0] : p).dataIndex; return `<span style="color:${c.muted}">${escapeHtml(String(cats[i] ?? ""))}</span><br><b>${escapeHtml(String(name))}:</b> ${fmtVal(vals[i])}<br><b>Target:</b> ${fmtVal(t)} (${((vals[i] / t) * 100).toFixed(0)}%)`; } },
    xAxis: valueAxis(c, fmtVal, { max }),
    yAxis: catAxis(c, cats, { inverse: true }),
    series: [
      ...bands.map(([label, from, to, op]) => ({ type: "bar", name: label, stack: "bands", silent: true, barWidth: "60%",
        data: band(from, to), itemStyle: { color: c.muted, opacity: op } })),
      { type: "bar", name, data: vals, barWidth: "24%", barGap: "-70%", z: 3, itemStyle: { color: c.ink } },
      { type: "scatter", name: "Target", data: cats.map((_, i) => [t, i]), symbol: "rect", symbolSize: [3, 26], z: 4,
        itemStyle: { color: c.series } },
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
    titles.push({ text: p.name, left: `${col * cw + 1}%`, top: `${row * rh}%`, textStyle: { color: c.label, fontFamily: c.font, fontSize: 12, fontWeight: 600 } });
    grids.push({ left: `${col * cw + 3}%`, width: `${cw - 5}%`, top: `${row * rh + 5}%`, height: `${rh - 12}%`, containLabel: true });
    xAxes.push({ ...catAxis(c, xCats), gridIndex: i, axisLabel: { color: c.muted, hideOverlap: true, fontSize: 10 } });
    yAxes.push({ ...valueAxis(c, fmtVal), gridIndex: i, min: yMin, max: yMax, splitNumber: 2, axisLabel: { color: c.muted, formatter: fmtVal, fontSize: 10, show: col === 0 } });
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

// --- P18 marks helpers ------------------------------------------------------
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// A symbol-size function mapping a datum's magnitude onto an 8–36px range (bubble scatter).
function sizeScaler(values, accessor) {
  const nums = (values ?? []).map((v) => Number(v) || 0);
  const min = Math.min(...nums, 0), max = Math.max(...nums, 1), span = (max - min) || 1;
  return (val) => { const v = accessor ? accessor(val) : (Number(val) || 0); return 8 + ((v - min) / span) * (36 - 8); };
}
// A continuous visualMap (the gradient legend) over `values`, coloured on the single-hue token ramp.
function continuousVisualMap(values, dimension, c, fmtVal, name) {
  const nums = (values ?? []).map((v) => Number(v)).filter((v) => Number.isFinite(v));
  const min = nums.length ? Math.min(...nums) : 0;
  let max = nums.length ? Math.max(...nums) : 1;
  if (max === min) max = min + 1;
  return {
    type: "continuous", min, max, dimension, calculable: true,
    orient: "horizontal", left: "center", bottom: 0,
    inRange: { color: [c.brandSoft, c.brand] },
    text: name ? [String(name), ""] : undefined,
    textStyle: { color: c.muted, fontFamily: c.font }, formatter: (v) => fmtVal(v),
  };
}
// T01-19: the user's tooltip template → safe HTML. `measures` maps a measure name → its formatted value for
// this mark; group-by / mark fields come from `tooltipFields` ([{ name, values }] by dataIndex).
function customTip(text, tooltipFields, dataIndex, measures) {
  const dims = new Map((tooltipFields ?? []).map((f) => [f.name, f.values?.[dataIndex]]));
  return tooltipHtml(text, (name) => (Object.prototype.hasOwnProperty.call(measures, name) ? measures[name] : dims.get(name)));
}
// Extra tooltip lines for the P18 Tooltip encoding: one "<field>: <value>" per chosen field.
function extraTooltip(tooltipExtra, dataIndex, c) {
  if (!Array.isArray(tooltipExtra) || !tooltipExtra.length) return "";
  return tooltipExtra
    .map((t) => `<br><span style="color:${c.muted}">${escapeHtml(String(t.name))}:</span> ${escapeHtml(String(t.values?.[dataIndex] ?? ""))}`)
    .join("");
}
