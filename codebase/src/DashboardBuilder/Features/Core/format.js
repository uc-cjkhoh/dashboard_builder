// Value + category formatting for the worksheet (P10). Pure functions, no DOM — shared by the
// chart adapter (chart.js) and the crosstab/KPI renderers (dashboards.js) so a sheet's number/date
// format reads the same everywhere. Config shape: store.js defaultFormat().

/**
 * Build a measure-value formatter from a sheet's `format` config.
 * @returns {(n:number|null)=>string} formats a number; null/NaN → "—".
 */
export function makeValueFormatter(fmt = {}) {
  const style = fmt.numberFormat ?? "auto";
  const dec = fmt.decimals;
  const opts = dec == null
    ? { maximumFractionDigits: 2 }
    : { minimumFractionDigits: dec, maximumFractionDigits: dec };
  // `suffix` (e.g. "%" for a percent table calculation, already in percent units) follows the number.
  if (fmt.suffix) {
    const base = makeValueFormatter({ ...fmt, suffix: undefined, numberFormat: "auto" });
    return (n) => { const s = base(n); return s === "—" ? s : s + fmt.suffix; };
  }
  return (n) => {
    if (n == null) return "—";
    const v = Number(n);
    if (Number.isNaN(v)) return typeof n === "string" && n ? n : "—";
    switch (style) {
      case "compact": return compactNumber(v, dec);
      case "currency": return (fmt.currencySymbol || "$") + v.toLocaleString(undefined, opts);
      case "percent": return (v * 100).toLocaleString(undefined, opts) + "%";
      default: return v.toLocaleString(undefined, opts); // "auto" — locale grouping
    }
  };
}

/** Compact number (1.2k, 3.4M, 1B). `dec` null → 1 fraction digit, trimmed of trailing zeros. */
export function compactNumber(n, dec) {
  const a = Math.abs(n);
  const d = dec == null ? 1 : dec;
  if (a >= 1e9) return trimZeros((n / 1e9).toFixed(d)) + "B";
  if (a >= 1e6) return trimZeros((n / 1e6).toFixed(d)) + "M";
  if (a >= 1e3) return trimZeros((n / 1e3).toFixed(d)) + "k";
  return trimZeros(n.toFixed(d));
}

function trimZeros(s) {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Build a dimension-label formatter. Only reformats values that parse as a ClickHouse
 * Date/DateTime; everything else (and mode "auto") passes through unchanged.
 * @returns {(s:string|null)=>string|null}
 */
export function makeCategoryFormatter(fmt = {}) {
  const mode = fmt.dateFormat ?? "auto";
  if (mode === "auto") return (s) => s;
  return (s) => {
    if (s == null) return s;
    const d = parseDate(String(s));
    if (!d) return s;
    switch (mode) {
      case "date": return d.toLocaleDateString();
      case "datetime": return d.toLocaleString();
      case "month": return d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
      case "year": return String(d.getFullYear());
      default: return s;
    }
  };
}

// ClickHouse Date "YYYY-MM-DD" / DateTime "YYYY-MM-DD hh:mm[:ss]". Guarded so arbitrary strings
// (and numbers that happen to look date-ish) aren't coerced.
function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return null;
  const d = new Date(s.includes(" ") ? s.replace(" ", "T") : s);
  return Number.isNaN(d.getTime()) ? null : d;
}
