// Date hierarchy — pure, DOM-free (unit-tested in tests/js/date-parts.test.mjs). A date pill on
// Columns / Rows may carry `datePart`: auto (the chart-wide Group dates), exact, a truncation
// (year → quarter → month → day → hour, plus week) or a discrete part (quarter / month of year, day of
// week, hour of day). The server maps each to one whitelisted ClickHouse function.
import { DATE_PARTS } from "../Core/sheet-schema.js";

export const DATE_PART_CHOICES = [
  ["auto", "Auto"], ["exact", "Exact"], ["year", "Year"], ["quarter", "Quarter"], ["month", "Month"],
  ["week", "Week"], ["day", "Day"], ["hour", "Hour"],
  ["quarterOfYear", "Quarter of year"], ["monthOfYear", "Month of year"], ["dayOfWeek", "Day of week"], ["hourOfDay", "Hour of day"],
];
/** The drill hierarchy the pill's + / − step through. */
export const HIERARCHY = ["year", "quarter", "month", "day", "hour"];

/** Whether a part changes the grouping (anything but auto / exact / unset). */
export const isGroupingPart = (part) => Boolean(part) && part !== "auto" && part !== "exact" && DATE_PARTS.has(part);

/**
 * The next part one step finer (+1) or coarser (−1) in the hierarchy; from auto / exact / a discrete part
 * "+" starts at year and "−" at the finest. A Date column stops at day. null when there is no step.
 */
export function stepPart(part, dir, dateOnly = false) {
  const levels = dateOnly ? HIERARCHY.slice(0, 4) : HIERARCHY;
  const i = levels.indexOf(part === "week" ? "month" : part);
  if (i < 0) return dir > 0 ? levels[0] : levels[levels.length - 1];
  const j = i + (dir > 0 ? 1 : -1);
  return j >= 0 && j < levels.length ? levels[j] : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // ClickHouse toDayOfWeek: Monday = 1

/** The display label for a key grouped by `part` (the raw key is ISO for truncations, a number otherwise). */
export function partLabel(part, raw) {
  if (raw == null) return raw;
  const s = String(raw);
  const n = Number(s);
  const d = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}))?/.exec(s);
  switch (part) {
    case "year": return d ? d[1] : s;
    case "quarter": return d ? `${d[1]} Q${Math.floor((+d[2] - 1) / 3) + 1}` : s;
    case "month": return d ? `${MONTHS[+d[2] - 1]} ${d[1]}` : s;
    case "week": return d ? `Week of ${d[1]}-${d[2]}-${d[3]}` : s;
    case "day": return d ? `${d[1]}-${d[2]}-${d[3]}` : s;
    case "hour": return d ? `${d[1]}-${d[2]}-${d[3]} ${d[4] ?? "00"}:00` : s;
    case "quarterOfYear": return Number.isInteger(n) ? `Q${n}` : s;
    case "monthOfYear": return Number.isInteger(n) && n >= 1 && n <= 12 ? MONTHS[n - 1] : s;
    case "dayOfWeek": return Number.isInteger(n) && n >= 1 && n <= 7 ? DAYS[n - 1] : s;
    case "hourOfDay": return Number.isInteger(n) ? `${String(n).padStart(2, "0")}:00` : s;
    default: return raw;
  }
}

/** A result with the keys of date-part dimensions turned into labels. `parts[i]` is key i's part (or null). */
export function labelParts(result, parts) {
  if (!parts.some(isGroupingPart)) return result;
  const relabel = (keys) => keys.map((k, i) => (isGroupingPart(parts[i]) ? partLabel(parts[i], k) : k));
  return { ...result, rows: result.rows.map((r) => (r.isOther ? r : { ...r, keys: relabel(r.keys) })) };
}
