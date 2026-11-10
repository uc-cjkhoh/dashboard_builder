// Small pure wording / label rules for charts (no DOM): kept apart so they are unit-tested.

/** A trend's R² in plain words, the number kept: "poor fit (R² -0.12)". A negative R² means worse than a flat line. */
export function fitWords(r2) {
  if (!Number.isFinite(r2)) return "R² n/a";
  const word = r2 < 0.1 ? "poor" : r2 < 0.4 ? "weak" : r2 < 0.7 ? "moderate" : "good";
  return `${word} fit (R² ${r2.toFixed(2)})`;
}

/** The note under a KPI that has a dimension: the big number is the LAST member's, not a total. */
export function kpiLastNote(member, count) {
  if (count <= 1) return member == null ? "" : String(member);
  return `${member == null ? "" : `${member} · `}last of ${count}`;
}

/** A histogram bin's axis label: a whole-number bin is "3" or "3–4" (its x1 is exclusive), else "x0–x1". */
export function histogramLabel(bin, whole, fmt) {
  if (!whole) return `${fmt(bin.x0)}–${fmt(bin.x1)}`;
  const last = bin.x1 - 1;
  return last <= bin.x0 ? fmt(bin.x0) : `${fmt(bin.x0)}–${fmt(last)}`;
}
