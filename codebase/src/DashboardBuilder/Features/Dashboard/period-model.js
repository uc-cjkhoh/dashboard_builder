// Period comparison — pure, DOM-free (unit-tested in tests/js/period-model.test.mjs).
// A worksheet's `period` limits the view to a date range on one date/time field and, optionally, runs the
// same query over a comparison range (previous period, same period last year, or custom). Ranges are
// whole days, inclusive, in the browser's calendar; they reach the server as one bound `between` filter.
import { PERIOD_PRESETS, PERIOD_COMPARES } from "../Core/sheet-schema.js";

/** Range presets, in menu order. */
export const PRESET_CHOICES = [
  ["last7", "Last 7 days"], ["last28", "Last 28 days"], ["last30", "Last 30 days"], ["last90", "Last 90 days"],
  ["thisMonth", "This month"], ["lastMonth", "Last month"], ["thisQuarter", "This quarter"],
  ["lastQuarter", "Last quarter"], ["thisYear", "This year"], ["lastYear", "Last year"], ["custom", "Custom"],
];
/** Comparison choices, in menu order. */
export const COMPARE_CHOICES = [
  ["none", "No comparison"], ["previous", "Previous period"], ["lastYear", "Same period last year"], ["custom", "Custom"],
];
/** Chart types that draw the comparison (others still apply the range). */
export const COMPARE_TYPES = new Set(["bar", "line", "area", "kpi"]);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;
// Calendar dates as UTC midnights, so day arithmetic never trips over DST.
const d = (y, m, day) => new Date(Date.UTC(y, m, day));
const iso = (t) => t.toISOString().slice(0, 10);
const parse = (s) => (ISO.test(s ?? "") ? new Date(`${s}T00:00:00Z`) : null);
const addDays = (t, n) => new Date(t.getTime() + n * DAY);
// Shift by whole years, clamping 29 Feb to 28 Feb.
function addYears(t, n) {
  const y = t.getUTCFullYear() + n, m = t.getUTCMonth(), day = t.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return d(y, m, Math.min(day, last));
}

/** A new period on a date field: the last 30 days against the previous 30. */
export function newPeriod(field) {
  return { db: field.db, table: field.table, column: field.column, category: field.category,
    preset: "last30", from: null, to: null, compare: "previous", compareFrom: null, compareTo: null };
}

/**
 * The period's range as inclusive ISO days { from, to }, or null when a custom range is incomplete or
 * inverted. `today` is the browser's local date.
 */
export function resolveRange(period, today = new Date()) {
  if (!period || !PERIOD_PRESETS.has(period.preset)) return null;
  const t = d(today.getFullYear(), today.getMonth(), today.getDate());
  const y = t.getUTCFullYear(), m = t.getUTCMonth(), q = Math.floor(m / 3) * 3;
  const span = (from, to) => ({ from: iso(from), to: iso(to) });
  switch (period.preset) {
    case "last7": return span(addDays(t, -6), t);
    case "last28": return span(addDays(t, -27), t);
    case "last30": return span(addDays(t, -29), t);
    case "last90": return span(addDays(t, -89), t);
    case "thisMonth": return span(d(y, m, 1), t);
    case "lastMonth": return span(d(y, m - 1, 1), d(y, m, 0));
    case "thisQuarter": return span(d(y, q, 1), t);
    case "lastQuarter": return span(d(y, q - 3, 1), d(y, q, 0));
    case "thisYear": return span(d(y, 0, 1), t);
    case "lastYear": return span(d(y - 1, 0, 1), d(y - 1, 11, 31));
    default: return customRange(period.from, period.to);
  }
}

function customRange(from, to) {
  const a = parse(from), b = parse(to);
  return a && b && a <= b ? { from, to } : null;
}

/**
 * The comparison range for `range`, or null (none / incomplete custom). "previous" is the same number of
 * days immediately before; "lastYear" is the same days a year earlier.
 */
export function compareRange(period, range) {
  if (!period || !range || !PERIOD_COMPARES.has(period.compare) || period.compare === "none") return null;
  const a = parse(range.from), b = parse(range.to);
  if (period.compare === "previous") {
    const days = Math.round((b - a) / DAY) + 1;
    return { from: iso(addDays(a, -days)), to: iso(addDays(a, -1)) };
  }
  if (period.compare === "lastYear") return { from: iso(addYears(a, -1)), to: iso(addYears(b, -1)) };
  return customRange(period.compareFrom, period.compareTo);
}

/**
 * The bound `between` filter for a range on the period's field. A Date column takes days; a DateTime
 * column takes the first and last second of those days.
 */
export function rangeFilter(period, range, dateOnly) {
  return {
    db: period.db, table: period.table, column: period.column, category: "temporal", op: "between",
    values: dateOnly ? [range.from, range.to] : [`${range.from} 00:00:00`, `${range.to} 23:59:59`],
  };
}

/** "1 Sep – 30 Sep 2026" (the year once when both ends share it). */
export function rangeLabel(range) {
  if (!range) return "";
  const f = parse(range.from), t = parse(range.to);
  const opts = { day: "numeric", month: "short", timeZone: "UTC" };
  const sameYear = f.getUTCFullYear() === t.getUTCFullYear();
  const a = f.toLocaleDateString("en-GB", sameYear ? opts : { ...opts, year: "numeric" });
  const b = t.toLocaleDateString("en-GB", { ...opts, year: "numeric" });
  return `${a} – ${b}`;
}

/** Name of the comparison, for legends and tiles. */
export const compareName = (compare) =>
  compare === "previous" ? "previous period" : compare === "lastYear" ? "same period last year" : "comparison";

/**
 * Change from `prev` to `cur`: { delta, pct (null when prev is 0 / missing), dir: up | down | flat }.
 */
export function changeOf(cur, prev) {
  const num = (v) => (v == null || v === "" ? NaN : Number(v)); // a missing value is not zero
  const c = num(cur), p = num(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return { delta: null, pct: null, dir: "flat" };
  const delta = c - p;
  return { delta, pct: p === 0 ? null : (delta / Math.abs(p)) * 100, dir: delta > 0 ? "up" : delta < 0 ? "down" : "flat" };
}

/** Whether a change is good, bad or neutral, given whether a fall is the good direction. */
export const toneOf = (dir, downIsGood = false) =>
  dir === "flat" ? "neutral" : (dir === "up") !== Boolean(downIsGood) ? "good" : "bad";

/** "+12.4%" / "−3.0%" / "n/a" (U+2212 minus, so the sign reads as a sign). */
export function pctText(pct) {
  if (pct == null || !Number.isFinite(pct)) return "n/a";
  const s = Math.abs(pct).toFixed(1);
  return pct > 0 ? `+${s}%` : pct < 0 ? `−${s}%` : "0.0%";
}

/**
 * Comparison values lined up with the current rows. When the first group key is the period's own date
 * field the two ranges can't share keys, so they line up by position (day 1 with day 1); otherwise by
 * the full key tuple (e.g. the same country). Missing → null.
 */
export function alignCompare(curRows, prevRows, byPosition) {
  if (byPosition) return curRows.map((_, i) => prevRows[i] ?? null);
  const map = new Map(prevRows.map((r) => [JSON.stringify(r.keys), r]));
  return curRows.map((r) => map.get(JSON.stringify(r.keys)) ?? null);
}

/** Progress toward a target: { pct, met } or null without a usable target. */
export function targetProgress(value, target) {
  const v = Number(value), t = Number(target);
  if (target == null || !Number.isFinite(t) || t === 0 || !Number.isFinite(v)) return null;
  const pct = (v / t) * 100;
  return { pct, met: pct >= 100 };
}
