// Pure rules for the column profile (no DOM): the POST body, number formatting and the shape the dialog shows.
// Unit-tested in tests/js/column-profile-model.test.mjs; the limits mirror ClickHouse/RequestValidation.cs (ApiLimits).

export const PROFILE_LIMITS = Object.freeze({
  top: 10,            // ApiLimits.DefaultProfileTop
  maxTop: 50,         // ApiLimits.MaxProfileTop
  maxColumn: 1000,    // ApiLimits.MaxColumnName
  sampleRows: 1_000_000, // ApiLimits.ProfileSampleRows: the profile reads the first N rows
  valueLength: 100,   // ApiLimits.ProfileValueLength: characters kept per top value
});

/** The request body for one column; out-of-range input throws (the server rejects it too, it never clamps). */
export function profileRequest(column, limit = PROFILE_LIMITS.top) {
  if (typeof column !== "string" || column.trim() === "") throw new Error("A column is required.");
  if (column.length > PROFILE_LIMITS.maxColumn) throw new Error(`The column name must be at most ${PROFILE_LIMITS.maxColumn} characters.`);
  if (!Number.isInteger(limit) || limit < 1 || limit > PROFILE_LIMITS.maxTop) throw new Error(`Top values must be between 1 and ${PROFILE_LIMITS.maxTop}.`);
  return { column, limit };
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

/** The worksheet's rule: a numeric field is a measure, everything else a dimension. */
export const roleOf = (category) => (category === "numeric" ? "measure" : "dimension");

/** Everything the dialog shows, from the server's profile. */
export function summarize(p) {
  const sampleNote = p.sampled ? `Only the first ${formatCount(p.sampleLimit)} rows were read, so these figures describe those rows, not the whole table.` : null;
  const tiles = [
    { label: "Rows", value: formatCount(p.rows), note: p.sampled ? `first ${formatCount(p.sampleLimit)} rows` : null },
    { label: "Distinct (approx.)", value: formatCount(p.distinct), note: "non-null values, estimated" },
    { label: "Null share", value: formatShare(p.nulls, p.rows), note: `${formatCount(p.nulls)} of ${formatCount(p.rows)} rows` },
  ];
  if (p.min != null) tiles.push({ label: "Min", value: p.min, note: null });
  if (p.max != null) tiles.push({ label: "Max", value: p.max, note: null });
  const role = roleOf(p.category);
  const top = p.top.map((t) => {
    const kind = t.value === null ? "null" : t.value === "" ? "empty" : "value";
    const label = kind === "null" ? "NULL" : kind === "empty" ? "(empty)" : t.cut ? `${t.value}…` : t.value;
    const share = p.rows > 0 ? (t.count / p.rows) * 100 : 0;
    return { label, kind, cut: Boolean(t.cut), count: t.count, countText: formatCount(t.count), shareText: formatShare(t.count, p.rows), bar: t.count > 0 ? Math.max(1, Math.round(share)) : 0 };
  });
  const copyValues = p.top.filter((t) => t.value !== null && t.value !== "" && !t.cut).map((t) => t.value).join("\n");
  return {
    tiles, role, top, sampleNote, empty: p.rows === 0, copyName: p.column, copyValues,
    details: [["Name", p.column], ["Type", p.type], ["Kind", p.category], ["Role", role]],
  };
}
