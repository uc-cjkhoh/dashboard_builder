// P21 analytics pane — pure, DOM-free (unit-tested in tests/js/analytics-model.test.mjs). Everything is
// computed in the browser over the rows the query returned: reference lines / bands, a trend line (with
// R²) and a short forecast that extends it, and crosstab totals that respect each measure's aggregation.
// sheet.analytics = { ref: { kind, value? }, band: { from, to } | null, trend: none|linear|log|poly2,
//                     forecast: 0|3|6|12, totals: { grand, sub } }
export const REF_CHOICES = [["none", "None"], ["average", "Average"], ["median", "Median"], ["min", "Minimum"], ["max", "Maximum"], ["constant", "Constant"]];
export const TREND_CHOICES = [["none", "None"], ["linear", "Linear"], ["log", "Logarithmic"], ["poly2", "Polynomial (2nd order)"]];
export const FORECAST_CHOICES = [[0, "None"], [3, "3 steps"], [6, "6 steps"], [12, "12 steps"]];
export const defaultAnalytics = () => ({ ref: { kind: "none" }, band: null, trend: "none", forecast: 0, totals: { grand: false, sub: false } });

const nums = (values) => values.map((v) => (v == null || v === "" ? NaN : Number(v))).filter(Number.isFinite);

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
