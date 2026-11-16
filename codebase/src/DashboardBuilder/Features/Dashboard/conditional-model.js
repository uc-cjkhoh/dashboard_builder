// Conditional formatting for the Table / Text crosstab — pure, DOM-free (unit-tested in
// tests/js/conditional-model.test.mjs). Per measure: a colour scale (sequential, or diverging around a
// midpoint) or data bars, plus up to five rules (value op threshold → a tone with an icon). Colours come
// from the design tokens at render time; the text ink is picked per cell for ≥ 4.5:1 contrast.
import { pickInk } from "./contrast.js";
import { CF_MAX_RULES } from "../Core/sheet-schema.js";

export const CF_MODE_CHOICES = [["none", "None"], ["scale", "Colour scale"], ["bars", "Data bars"]];
export const CF_SCALE_CHOICES = [["sequential", "Low → high"], ["diverging", "Diverging"]];
export const CF_OP_CHOICES = [[">", ">"], [">=", "≥"], ["<", "<"], ["<=", "≤"], ["=", "="], ["!=", "≠"]];
export const CF_TONE_CHOICES = [["good", "Good"], ["bad", "Bad"], ["warn", "Warning"], ["info", "Note"]];
/** The icon each rule tone carries, so a rule never relies on colour alone. */
export const TONE_ICON = { good: "check", bad: "error", warn: "warning", info: "info" };
export { CF_MAX_RULES };

/** A measure's settings key: its column and aggregation (stable across shelf reorders). */
export const measureKey = (entry) =>
  (entry?.field ? `${entry.field.db}.${entry.field.table}.${entry.field.column}:${entry.agg ?? "sum"}${entry.agg === "percentile" ? `@${entry.field.p}` : ""}` : "count");

/** A fresh setting for one measure. */
export const emptyRule = () => ({ mode: "none", scale: "sequential", mid: null, rules: [] });

/** A fresh rule: no threshold yet, so it applies to nothing until one is typed. */
export const newRule = () => ({ op: ">", value: null, tone: "good" });

/** Finite min / max of some values, or null. */
export function extentOf(values) {
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    const n = v == null || v === "" ? NaN : Number(v);
    if (Number.isFinite(n)) { if (n < min) min = n; if (n > max) max = n; }
  }
  return min <= max ? { min, max } : null;
}

/** The diverging midpoint: the one set, else 0 when the values straddle it, else the middle. */
export function midpointOf(ext, mid) {
  if (mid != null && Number.isFinite(Number(mid))) return Number(mid);
  return ext.min < 0 && ext.max > 0 ? 0 : (ext.min + ext.max) / 2;
}

/** Linear mix of two #rrggbb colours (t = 0 → a, 1 → b). */
export function mixHex(a, b, t) {
  const p = (h) => { let s = String(h).trim().replace(/^#/, ""); if (s.length === 3) s = [...s].map((c) => c + c).join(""); const n = parseInt(s.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const [x, y] = [p(a), p(b)];
  const k = Math.max(0, Math.min(1, t));
  return "#" + x.map((c, i) => Math.round(c + (y[i] - c) * k).toString(16).padStart(2, "0")).join("");
}

// Strongest tint a scale reaches — keeps the top of the scale a tint, not a solid block.
const MAX_TINT = 0.85;

/**
 * Background + ink for a value on a colour scale. `palette` = { surface, high, low, inks: [hex…] }:
 * sequential tints surface → high; diverging tints toward low below the midpoint and high above it.
 */
export function scaleColors(v, ext, cfg, palette) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || !ext) return null;
  let toward = palette.high, t;
  if (cfg.scale === "diverging") {
    const mid = midpointOf(ext, cfg.mid);
    const reach = n >= mid ? ext.max - mid : mid - ext.min;
    t = reach > 0 ? Math.abs(n - mid) / reach : 0;
    if (n < mid) toward = palette.low;
  } else {
    t = ext.max > ext.min ? (n - ext.min) / (ext.max - ext.min) : 1;
  }
  const bg = mixHex(palette.surface, toward, t * MAX_TINT);
  return { bg, ink: pickInk(bg, palette.inks) };
}

/**
 * A data bar's geometry in % of the cell: bars grow from zero, so negatives extend left of the zero line.
 * { left, width, neg } or null.
 */
export function barGeometry(v, ext) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || !ext) return null;
  const lo = Math.min(0, ext.min), hi = Math.max(0, ext.max), span = hi - lo;
  if (span === 0) return { left: 0, width: 0, neg: false };
  const zero = ((0 - lo) / span) * 100;
  const end = ((n - lo) / span) * 100;
  return { left: Math.min(zero, end), width: Math.abs(end - zero), neg: n < 0 };
}

/** The first rule a value meets, or null. */
export function matchRule(v, rules) {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return null;
  for (const r of rules ?? []) {
    if (r.value == null || r.value === "") continue; // no threshold typed yet: the rule applies to nothing
    const t = Number(r.value);
    if (!Number.isFinite(t)) continue;
    const hit = r.op === ">" ? n > t : r.op === ">=" ? n >= t : r.op === "<" ? n < t : r.op === "<=" ? n <= t
      : r.op === "=" ? n === t : r.op === "!=" ? n !== t : false;
    if (hit) return r;
  }
  return null;
}

/** Whether a measure's setting draws anything. */
export const isActive = (cfg) => Boolean(cfg && (cfg.mode === "scale" || cfg.mode === "bars" || (cfg.rules?.length ?? 0) > 0));

// --- Include totals ----------------------------------------------------------------------------------------------
// A measure's setting may colour its total cells (grand-total column, subtotal rows, grand-total row, and where they cross) as it colours the
// others, and count them when the scale's range is found. Stored as `totals: true` in the measure's entry, only while on.
export const TOTALS_NOTE = "Totals are larger than single cells, so cells may look pale";
export const TOTALS_OFF_REASON = "Turn on Grand totals or Subtotals";
export const TOTALS_NONE_REASON = "Pick a colour scale, data bars or a rule first";
export const TOTALS_IDLE_REASON = "Grand totals and Subtotals are off, so no total is coloured yet";

/** Whether the setting colours total cells: the flag is a real true and the measure draws something. */
export const totalsIncluded = (cfg) => Boolean(cfg && cfg.totals === true && isActive(cfg));

/** The Include totals control for one measure: { enabled, reason (why it is off), note (a hint while on) }; `totals` = { grand, sub }. */
export function totalsGate(cfg, totals) {
  const shown = Boolean(totals?.grand || totals?.sub);
  if (!shown && cfg?.totals !== true) return { enabled: false, reason: TOTALS_OFF_REASON, note: null };
  if (!isActive(cfg)) return { enabled: false, reason: TOTALS_NONE_REASON, note: null };
  return { enabled: true, reason: null, note: shown ? null : TOTALS_IDLE_REASON };
}

/** The extent a scale or bar is measured on: the cells' values, and the totals' when they are included. */
export const extentWithTotals = (cellValues, totalValues) => extentOf(totalValues?.length ? [...cellValues, ...totalValues] : cellValues);

/** All measures' conditional settings after `patch` is applied to `key`'s: an entry that draws nothing (and has no midpoint) is removed; `totals` is stored only while true and active. */
export function nextConditional(all, key, cfg, patch) {
  const next = { ...cfg, ...patch };
  if (next.totals !== true || !isActive(next)) delete next.totals;
  const out = { ...all };
  if (isActive(next) || next.mid != null) out[key] = next; else delete out[key];
  return out;
}
