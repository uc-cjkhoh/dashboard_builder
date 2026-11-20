// Pure rules for the column profile (no DOM): the POST body, number formatting and the shape the dialog shows.
// Unit-tested in tests/js/column-profile-model.test.mjs; the limits mirror ClickHouse/RequestValidation.cs (ApiLimits).


export const PROFILE_LIMITS = Object.freeze({
  top: 10,            // ApiLimits.DefaultProfileTop
  maxTop: 50,         // ApiLimits.MaxProfileTop
  maxColumn: 1000,    // ApiLimits.MaxColumnName
  valueLength: 100,   // ApiLimits.ProfileValueLength: characters kept per top value
  bins: 20,           // the distribution's equal-width bins (ClampBuckets' default; the server's cap is ApiLimits.MaxBuckets, 100)
});

/** The request body for one column; out-of-range input throws (the server rejects it too, it never clamps). */
export function profileRequest(column, limit = PROFILE_LIMITS.top, source = null) {
  if (typeof column !== "string" || column.trim() === "") throw new Error("A column is required.");
  if (column.length > PROFILE_LIMITS.maxColumn) throw new Error(`The column name must be at most ${PROFILE_LIMITS.maxColumn} characters.`);
  if (!Number.isInteger(limit) || limit < 1 || limit > PROFILE_LIMITS.maxTop) throw new Error(`Top values must be between 1 and ${PROFILE_LIMITS.maxTop}.`);
  return source ? { column, limit, source } : { column, limit }; // `source`: a custom SQL card's query (sqlWire), read instead of the catalog table
}

export const formatCount = (n) => Number(n).toLocaleString("en-US");

/** part/whole as a percentage: exact 0% and 100% only when true; a floor for tiny shares; never rounds a partial share up to 100. */
export function formatShare(part, whole) {
  if (!whole || !part) return "0%";
  if (part >= whole) return "100%";
  const pct = (part / whole) * 100;
  if (pct < 0.05) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  const whole_ = Math.round(pct);
  return whole_ >= 100 ? "99.9%" : `${whole_}%`;
}

/** A computed figure (mean, deviation, quartile) as short text: never a long float, never a rounded-away integer part.
 *  10,000+ → whole numbers; 100+ → 1 decimal; 1+ → 2; below 1 → 3 significant digits; extreme sizes in exponent form. null / NaN / ∞ → null (the tile is left out). */
export function formatNumber(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null;
  const x = Number(n), a = Math.abs(x);
  if (a === 0) return "0";
  if (a >= 1e15 || a < 1e-4) return x.toExponential(3).replace(/\.?0+e/, "e");
  const opts = a >= 10000 ? { maximumFractionDigits: 0 } : a >= 100 ? { maximumFractionDigits: 1 } : a >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 };
  const text = x.toLocaleString("en-US", opts);
  return text === "-0" ? "0" : text;
}

/** The worksheet's rule: a numeric field is a measure, everything else a dimension. */
export const roleOf = (category) => (category === "numeric" ? "measure" : "dimension");

/** The message for a failed profile. The server's timeout advice (a filter, a lower Top-N, fewer fields) is for worksheets and means nothing here:
 *  the profile has no filter and reads every row, so say why it ran long and, for a custom SQL card, the one thing that helps. */
export function profileFailure(err, custom = false) {
  const message = err?.message || "The profile could not be read.";
  if (err?.status !== 504) return message;
  const stopped = message.split(". ")[0].replace(/\.$/, "");
  return `${stopped}. The profile reads every row, so a very large table can run past the limit.${custom ? " Narrow the query with Edit SQL, then profile again." : ""}`;
}

/** The request body of the distribution: equal-width bins over every non-NULL value (POST .../histogram, the worksheet's endpoint).
 *  `source`: a custom SQL card's query, read instead of the catalog table. */
export function histogramRequest(column, source = null, buckets = PROFILE_LIMITS.bins) {
  profileRequest(column); // the same column rules
  return source ? { column, buckets, source } : { column, buckets };
}

/** The message for a distribution that could not be read; the profile figures above it stay. */
export function distributionFailure(err, custom = false) {
  const message = err?.message || "The distribution could not be read.";
  if (err?.status !== 504) return message;
  return `The distribution ran past the time limit. It reads every row, so a very large table can run past it.${custom ? " Narrow the query with Edit SQL, then profile again." : ""}`;
}

/** The distribution as bars: one per bin, each as tall as its count against the fullest bin. `whole`: a whole-number column, so a bin is a range of integers
 *  and reads "10–19", not "10 – 20". The fullest bin is the peak (the one accent bar); every bar's range and count are also text. */
export function histogramView(h, rows) {
  const bins = Array.isArray(h?.bins) ? h.bins : [];
  const whole = Boolean(h?.whole);
  if (bins.length === 0 || bins.every((b) => !b.count)) return { empty: true, reason: "There are no values to chart.", bars: [], min: null, max: null, peak: null };
  const peak = Math.max(...bins.map((b) => b.count)), floor = Math.min(...bins.map((b) => b.count));
  const range = (b) => {
    const lo = formatNumber(b.x0), hi = formatNumber(whole ? b.x1 - 1 : b.x1);
    return whole ? (b.x1 - b.x0 <= 1 || lo === hi ? lo : `${lo}–${hi}`) : `${lo} – ${hi}`;
  };
  const peakAt = bins.findIndex((b) => b.count === peak);
  const bars = bins.map((b, i) => ({ range: range(b), count: b.count, countText: formatCount(b.count), shareText: formatShare(b.count, rows), height: b.count > 0 ? Math.max(1, Math.round((b.count / peak) * 100)) : 0, peak: i === peakAt, tone: toneOf(b.count, floor, peak) }));
  const top = bars[peakAt];
  return { empty: false, reason: null, bars, min: formatNumber(bins[0].x0), max: formatNumber(whole ? bins[bins.length - 1].x1 - 1 : bins[bins.length - 1].x1), peak: `Fullest bin: ${top.range}, ${top.countText} ${peak === 1 ? "row" : "rows"} (${top.shareText})` };
}

/** Everything the dialog shows, from the server's profile. `custom`: the profile is of a custom SQL card's query, not a catalog table. */
/** Where a count sits between the smallest and the largest in its set, 0..1 — the brightness of the one accent colour (all equal: full). */
export function toneOf(count, lo, hi) { return hi > lo ? Math.round(((count - lo) / (hi - lo)) * 100) / 100 : 1; }

export function summarize(p, custom = false) {
  const tiles = [
    { label: "Rows", value: formatCount(p.rows), note: null },
    { label: "Distinct (approx.)", value: formatCount(p.distinct), note: null },
    { label: "Null value", value: formatCount(p.nulls), note: null },
  ];
  if (p.min != null) tiles.push({ label: "Min", value: p.min, note: null });
  if (p.max != null) tiles.push({ label: "Max", value: p.max, note: null });
  // The numeric summary: its own group of figures (never in `tiles`, which are the counts and the range). A figure the server could not give is left out.
  const sm = p.summary ?? null;
  const summary = sm ? [
    ["Mean", sm.mean], ["Median (approx.)", sm.median], ["Std. deviation", sm.stdDev], ["Q1 (approx.)", sm.q1], ["Q3 (approx.)", sm.q3],
  ].map(([label, v]) => ({ label, value: formatNumber(v), note: null })).filter((t) => t.value !== null) : [];
  const role = roleOf(p.category);
  const counts = p.top.map((t) => t.count), lo = Math.min(...counts), hi = Math.max(...counts);
  const top = p.top.map((t) => {
    const kind = t.value === null ? "null" : t.value === "" ? "empty" : "value";
    const label = kind === "null" ? "(NULL)" : kind === "empty" ? "(empty)" : t.cut ? `${t.value}…` : t.value;
    const share = p.rows > 0 ? (t.count / p.rows) * 100 : 0;
    return { label, kind, cut: Boolean(t.cut), count: t.count, countText: formatCount(t.count), shareText: formatShare(t.count, p.rows), bar: t.count > 0 ? Math.max(1, Math.round(share)) : 0, tone: toneOf(t.count, lo, hi) };
  });
  // The list is the Top N, so its shares only reach 100% when the column has N or fewer groups. The rest of the rows (every group outside the Top N) is one more
  // line, "Other values", so the list always adds up to every row. Null when the Top N already covers every row.
  const rest = p.rows - p.top.reduce((n, t) => n + t.count, 0);
  const other = rest > 0 ? { label: "Other values", kind: "other", cut: false, count: rest, countText: formatCount(rest), shareText: formatShare(rest, p.rows), bar: Math.max(1, Math.round((rest / p.rows) * 100)), tone: 0 } : null;
  const copyValues = p.top.filter((t) => t.value !== null && t.value !== "" && !t.cut).map((t) => t.value).join("\n");
  const cutNote = top.some((t) => t.cut) ? `Values are compared by their first ${PROFILE_LIMITS.valueLength} characters, so values that differ only after that count together.` : null;
  // Why there is nothing (or nothing plain) to show: no rows at all, or every row is NULL / empty. Null when there is data.
  const empty = p.rows === 0;
  const reason = empty
    ? (custom ? "The query returns no rows, so there is nothing to profile. Check its filters in Edit SQL." : "This table has no rows, so there is nothing to profile.")
    : top.length > 0 && top.every((t) => t.kind !== "value")
      ? `Every row is ${top.some((t) => t.kind === "null") && top.some((t) => t.kind === "empty") ? "NULL or empty" : top[0].kind === "null" ? "NULL" : "empty"}, so there are no values to list and no Min or Max.`
      : null;
  return {
    tiles, summary, role, top, other, cutNote, empty, reason, copyValues };
}
