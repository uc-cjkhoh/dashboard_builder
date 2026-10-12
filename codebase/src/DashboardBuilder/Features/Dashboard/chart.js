import { makeValueFormatter } from "../Core/format.js";

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
    series: t("--chart-series", "#2563eb"),
    cat,
    axis: t("--chart-axis", "#d4d4d8"),
    grid: t("--chart-grid", "#e4e4e7"),
    label: t("--chart-label", "#3f3f46"),
    muted: t("--chart-muted", "#71717a"),
    surface: t("--surface", "#ffffff"),
    ink: t("--ink", "#0a0a0a"),
    font: t("--font", "system-ui, sans-serif"),
    // Brand stops for the sequential heatmap ramp (single-hue soft→saturated, token-driven).
    brand: t("--accent", "#2563eb"),
    brandSoft: t("--accent-soft", "#fce8e8"),
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

  // SVG renderer: crisp at any zoom, no canvas-sizing surprises, lighter DOM for our small charts.
  instance = window.echarts.init(host, null, { renderer: "svg" });
  instance.setOption(buildOption(spec));

  // P15 click-to-filter: forward mark clicks to the caller, which maps dataIndex → a dimension value.
  if (typeof spec.onSelect === "function") instance.on("click", spec.onSelect);

  resizeObserver = new ResizeObserver(() => instance && instance.resize());
  resizeObserver.observe(host);
  return instance;
}

/** Is there a live ECharts instance to export? (Table/KPI render as native DOM, so there isn't.) */
export function hasChartInstance() { return instance !== null; }

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

  let svg = currentSvgString(w, h);
  if (!svg) return null;
  if (kind === "svg") return { blob: new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), ext: "svg" };
  const blob = await svgToPng(svg, w, h);
  return blob ? { blob, ext: "png" } : null;
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
function buildCartesian({ type, categories, series, format = {}, orientation = "vertical", pointLabels, tooltipExtra }) {
  const c = tokens();
  const labels = (categories ?? []).map((l) => l ?? "—");
  const multi = series.length > 1;
  const isCombo = type === "combo";
  const horizontal = orientation === "horizontal" && !isCombo;
  const fmtVal = makeValueFormatter(format); // P10 — measure value format (tooltip, axis, labels)

  const colorFor = (i) => (multi ? c.cat[i % c.cat.length] : c.series);
  // Colour-by-dimension (P10): a single-measure bar chart colours each bar by its category. The
  // category axis already labels each bar, so colour restates identity (never colour-alone).
  const colorByDim = type === "bar" && !multi && !!format.colorByDimension;

  const { show: showLegend, pos, legend } = legendFor(format, c, series.map((s) => s.name), multi || isCombo);
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
    return {
      name: s.name, type: "bar",
      yAxisIndex: 0,
      stack: stacked ? "total" : undefined,
      // Colour-by-dimension: per-bar colours; otherwise the series colour.
      data: colorByDim
        ? s.data.map((v, di) => ({ value: v, itemStyle: { color: c.cat[di % c.cat.length], borderRadius: barRadius } }))
        : s.data,
      barMaxWidth: 40,
      itemStyle: { color, borderRadius: barRadius },
      label: dataLabel,
      emphasis: { itemStyle: colorByDim ? { opacity: 0.85 } : { color, opacity: 0.85 } },
    };
  });
  return base;
}

// pie / donut — one dimension (slices) × one measure (size). Colour IS the encoding, so a legend
// shows by default (dataviz: identity never colour-alone; the legend supplies the labels).
function buildPie({ type, categories, series, format = {}, pointLabels, tooltipExtra }) {
  const c = tokens();
  const fmtVal = makeValueFormatter(format);
  const labels = (categories ?? []).map((l) => l ?? "—");
  const data = labels.map((name, i) => ({ name, value: series[0].data[i] }));
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
      formatter: (p) =>
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
function buildScatter({ categories, series, format = {}, sizes, sizeName, colorValues, colorName, pointLabels, tooltipExtra, symbol }) {
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
      formatter: (p) =>
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
      emphasis: { focus: "self", itemStyle: { borderColor: c.ink, borderWidth: 1 } },
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
  return {
    textStyle: { fontFamily: c.font, color: c.label },
    tooltip: {
      backgroundColor: c.surface, borderColor: c.grid, borderWidth: 1,
      textStyle: { color: c.ink, fontFamily: c.font },
      formatter: (p) => `<span style="color:${c.muted}">${escapeHtml(String(p.name))}</span><br><b>${fmtVal(p.value)}</b>`,
    },
    series: [{
      type: "treemap", data: tree, roam: false, nodeClick: false,
      breadcrumb: { show: false },
      label: { show: true, color: "#fff", fontFamily: c.font, formatter: (p) => p.name },
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
// Extra tooltip lines for the P18 Tooltip encoding: one "<field>: <value>" per chosen field.
function extraTooltip(tooltipExtra, dataIndex, c) {
  if (!Array.isArray(tooltipExtra) || !tooltipExtra.length) return "";
  return tooltipExtra
    .map((t) => `<br><span style="color:${c.muted}">${escapeHtml(String(t.name))}:</span> ${escapeHtml(String(t.values?.[dataIndex] ?? ""))}`)
    .join("");
}
