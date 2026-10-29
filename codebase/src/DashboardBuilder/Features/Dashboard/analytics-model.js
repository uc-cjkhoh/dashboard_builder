// P21 analytics pane — pure, DOM-free (unit-tested in tests/js/analytics-model.test.mjs). Everything is
// computed in the browser over the rows the query returned: reference lines / bands, a trend line (with
// R²) and a short forecast that extends it, and crosstab totals that respect each measure's aggregation.
// sheet.analytics = { ref: { kind, value? }, band: { from, to } | null, trend: none|linear|log|poly2,
//                     forecast: 0|3|6|12, totals: { grand, sub } }; a constant ref may carry `param` (a number parameter's id): refConstant().
export const REF_CHOICES = [["none", "None"], ["average", "Average"], ["median", "Median"], ["min", "Minimum"], ["max", "Maximum"], ["constant", "Constant"]];
export const TREND_CHOICES = [["none", "None"], ["linear", "Linear"], ["log", "Logarithmic"], ["poly2", "Polynomial (2nd order)"]];
export const FORECAST_CHOICES = [[0, "None"], [3, "3 steps"], [6, "6 steps"], [12, "12 steps"]];
// A band is typed numbers ({ from, to }), mean ± k standard deviations ({ kind: "stddev", k }) or a percentile range ({ kind: "percentile", lo, hi });
// the reference line and the band read the measure `ref.measure` (a shown-measure index, default 0) over the rows shown.
export const BAND_CHOICES = [["none", "None"], ["range", "Typed range"], ["stddev1", "Mean ± 1σ"], ["stddev2", "Mean ± 2σ"], ["p25-75", "P25–P75"], ["p10-90", "P10–P90"]];
export const defaultAnalytics = () => ({ ref: { kind: "none" }, band: null, trend: "none", forecast: 0, totals: { grand: false, sub: false } });

const nums = (values) => values.map((v) => (v == null || v === "" ? NaN : Number(v))).filter(Number.isFinite);

/** A constant reference line's number: the bound number parameter's current value, else its own `value`. A bound parameter that is gone (or not a number) falls back to `value`. */
export function refConstant(ref, params) {
  const p = ref?.param ? (params ?? []).find((x) => x.id === ref.param && x.type === "number") : null;
  return p && Number.isFinite(Number(p.value)) ? Number(p.value) : ref?.value;
}

/** The reference line's value for a measure's values, or null. */
export function refValue(kind, values, constant) {
  const v = nums(values);
  switch (kind) {
    case "average": return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    case "median": {
      if (!v.length) return null;
      const s = [...v].sort((a, b) => a - b), m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    case "min": return v.length ? Math.min(...v) : null;
    case "max": return v.length ? Math.max(...v) : null;
    case "constant": return Number.isFinite(Number(constant)) && constant !== "" && constant != null ? Number(constant) : null;
    default: return null;
  }
}

/**
 * Least-squares trend over the points (x = position 0, 1, 2, … in category order; blanks skipped).
 * Returns { predict(x), r2 } or null when there are too few points. log fits y = a + b·ln(x + 1);
 * poly2 fits y = a + b·x + c·x².
 */
export function trendFit(type, values) {
  const pts = values.map((y, x) => [x, y == null || y === "" ? NaN : Number(y)]).filter(([, y]) => Number.isFinite(y));
  const need = type === "poly2" ? 3 : 2;
  if (pts.length < need || type === "none") return null;
  const feat = (x) => (type === "log" ? [1, Math.log(x + 1)] : type === "poly2" ? [1, x, x * x] : [1, x]);
  const X = pts.map(([x]) => feat(x)), Y = pts.map(([, y]) => y);
  const k = X[0].length;
  // Normal equations (XᵀX) β = Xᵀy, solved by Gaussian elimination (k ≤ 3).
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const b = Array.from({ length: k }, (_, i) => X.reduce((s, r, n) => s + r[i] * Y[n], 0));
  const beta = solve(A, b);
  if (!beta) return null;
  const predict = (x) => feat(x).reduce((s, f, i) => s + f * beta[i], 0);
  const mean = Y.reduce((a, c) => a + c, 0) / Y.length;
  const ssTot = Y.reduce((s, y) => s + (y - mean) ** 2, 0);
  const ssRes = pts.reduce((s, [x, y]) => s + (y - predict(x)) ** 2, 0);
  return { predict, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * The trend as a series over the categories plus `forecast` steps beyond them: { data, extra } where
 * `extra` is the number of forecast categories appended. null without a fit.
 */
export function trendSeries(type, values, forecast = 0) {
  const fit = trendFit(type === "none" && forecast ? "linear" : type, values);
  if (!fit) return null;
  const total = values.length + forecast;
  return { data: Array.from({ length: total }, (_, x) => fit.predict(x)), extra: forecast, r2: fit.r2 };
}

/**
 * Combine values the way a measure aggregates: sums and counts add, min / max take min / max; an average
 * or a distinct count can't be rebuilt from its parts — null ("—").
 */
export function combine(agg, values) {
  const v = nums(values);
  if (!v.length) return null;
  switch (agg ?? "sum") {
    case "sum": case "count": return v.reduce((a, b) => a + b, 0);
    case "min": return Math.min(...v);
    case "max": return Math.max(...v);
    default: return null;
  }
}

/** The shown measure a reference line / band reads: `index` when it is one of `count` measures, else the first. */
export const pickMeasure = (index, count) => (Number.isInteger(index) && index >= 0 && index < count ? index : 0);

/** The choice key of a band (BAND_CHOICES). */
export function bandChoice(band) {
  if (!band) return "none";
  if (band.kind === "stddev") return `stddev${band.k}`;
  if (band.kind === "percentile") return `p${band.lo}-${band.hi}`;
  return "range";
}
/** A band for a choice key (`prev` keeps a typed range's numbers). */
export function bandFromChoice(key, prev) {
  if (key === "none") return null;
  if (key === "range") return prev && prev.kind == null ? prev : { from: 0, to: 0 };
  if (key.startsWith("stddev")) return { kind: "stddev", k: Number(key.slice(6)) };
  const [lo, hi] = key.slice(1).split("-").map(Number);
  return { kind: "percentile", lo, hi };
}
/** The band's name on the chart. */
export function bandLabel(band) {
  if (band?.kind === "stddev") return `Mean ± ${band.k}σ`;
  if (band?.kind === "percentile") return `P${band.lo}–P${band.hi}`;
  return "Band";
}

function percentileOf(sorted, p) { // linear interpolation between closest ranks
  const pos = (sorted.length - 1) * p / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
/** The band's { from, to } over a measure's values, or null (no values; fewer than two for a standard deviation). */
export function bandBounds(band, values) {
  if (!band) return null;
  if (!band.kind) return band.from === band.to ? null : { from: band.from, to: band.to }; // a typed range with equal ends (just chosen) draws nothing
  const v = nums(values);
  if (band.kind === "stddev") {
    if (v.length < 2) return null;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
    return { from: mean - band.k * sd, to: mean + band.k * sd };
  }
  if (band.kind === "percentile") {
    if (!v.length) return null;
    const s = [...v].sort((a, b) => a - b);
    return { from: percentileOf(s, band.lo), to: percentileOf(s, band.hi) };
  }
  return null;
}

/** A measure's values without the "Other" remainder rows (an aggregate of cut-off members is not a data point). */
export const dataValues = (data, rows) => data.filter((_, i) => !rows[i]?.isOther);

// The Analytics pane's items: each can be dragged onto the chart or added with its button (T07-01).
export const ANALYTICS_ITEMS = [
  { id: "ref", label: "Reference line", icon: "analytics" },
  { id: "band", label: "Band", icon: "analytics" },
  { id: "trend", label: "Trend line", icon: "analytics" },
  { id: "forecast", label: "Forecast", icon: "analytics" },
];
/** The items that apply to a chart type: forecast needs a continuous axis (line / area). */
export const itemsFor = (chartType) => (["bar", "line", "area"].includes(chartType) ? ANALYTICS_ITEMS.filter((i) => i.id !== "forecast" || chartType !== "bar") : []);
/** Whether the item is on in these analytics. */
export function itemActive(a, id) {
  switch (id) {
    case "ref": return !!a.ref && a.ref.kind !== "none";
    case "band": return !!a.band;
    case "trend": return a.trend !== "none";
    case "forecast": return a.forecast > 0;
    default: return false;
  }
}
/** A copy with the item switched on at its default; an item already on is left as it is. */
export function addItem(a, id) {
  if (itemActive(a, id)) return a;
  switch (id) {
    case "ref": return { ...a, ref: { ...a.ref, kind: "average" } };
    case "band": return { ...a, band: bandFromChoice("stddev1") };
    case "trend": return { ...a, trend: "linear" };
    case "forecast": return { ...a, forecast: 3 };
    default: return a;
  }
}
/** A copy with the item switched off. */
export function removeItem(a, id) {
  switch (id) {
    case "ref": return { ...a, ref: { ...(a.ref?.measure ? { measure: a.ref.measure } : {}), kind: "none" } };
    case "band": return { ...a, band: null };
    case "trend": return { ...a, trend: "none" };
    case "forecast": return { ...a, forecast: 0 };
    default: return a;
  }
}
