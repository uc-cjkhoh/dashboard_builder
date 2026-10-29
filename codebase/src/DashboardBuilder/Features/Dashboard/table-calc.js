// P27 quick table calculations — pure, DOM-free (unit-tested in tests/js/table-calc.test.mjs). A measure
// pill may carry `tableCalc: { type, along, window? }`, computed in the browser over the rows the query
// returned (no new query shape). Rows are keyed [rowDim…, colDim…]; a calculation runs in result order
// (the user's sort) along one shelf's dimensions, restarting for each combination of the other shelf's.
import { TABLE_CALCS } from "../Core/sheet-schema.js";

export const CALC_CHOICES = [
  ["none", "None"], ["running", "Running total"], ["pctTotal", "% of total"], ["diff", "Difference"],
  ["pctDiff", "% difference"], ["rank", "Rank"], ["pctRank", "Percentile rank"], ["moving", "Moving average"],
];
export const ALONG_CHOICES = [["auto", "Auto"], ["columns", "Across (Columns)"], ["rows", "Down (Rows)"], ["custom", "Specific dimensions"]];
export const WINDOW_CHOICES = [2, 3, 5, 7, 12, 30];
/** Calculations whose results are percentages. */
export const PERCENT_CALCS = new Set(["pctTotal", "pctDiff", "pctRank"]);

/** A short name for a calculation, used in the measure's label. */
export const calcName = (c) => (c?.type === "moving" ? `moving avg (${c.window ?? 3})` : CALC_CHOICES.find(([v]) => v === c?.type)?.[1].toLowerCase() ?? "");

/** Whether a pill's calculation does anything. */
export const isCalc = (c) => Boolean(c && c.type !== "none" && TABLE_CALCS.has(c.type));

/**
 * Which shelf a calculation runs along: "columns" or "rows". Auto = Columns when Columns has dimensions,
 * else Rows.
 */
export function resolveAlong(along, rowDimCount, colDimCount) {
  if (along === "rows" || along === "columns" || along === "custom") return along;
  return colDimCount > 0 ? "columns" : "rows";
}

/**
 * The values of measure `mi` after `calc`, one per row (same order). `rowDims` / `colDims` = how many of
 * each row's keys belong to Rows / Columns. Rows with `isOther` take part in totals but get no rank.
 */
export function computeCalc(rows, mi, calc, rowDims, colDims) {
  let along = resolveAlong(calc.along, rowDims, colDims);
  // "custom": the chosen dimensions (indexes into rows' keys) run together, the rest restart. No valid choice = auto.
  const using = along === "custom" ? [...new Set(calc.using ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d < rowDims + colDims) : [];
  if (along === "custom" && !using.length) along = resolveAlong("auto", rowDims, colDims);
  // Partition by the OTHER dimensions: along Columns → restart per Rows tuple, and vice versa.
  const partKey = (r) => JSON.stringify(along === "custom" ? r.keys.filter((_, d) => d < rowDims + colDims && !using.includes(d))
    : along === "columns" ? r.keys.slice(0, rowDims) : r.keys.slice(rowDims, rowDims + colDims));
  const groups = new Map();
  rows.forEach((r, i) => { const k = partKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const out = new Array(rows.length).fill(null);
  for (const idx of groups.values()) {
    const vals = idx.map((i) => num(rows[i].values[mi]));
    switch (calc.type) {
      case "running": { let acc = 0; idx.forEach((i, j) => { if (vals[j] != null) acc += vals[j]; out[i] = vals[j] == null ? null : acc; }); break; }
      case "pctTotal": {
        const total = vals.reduce((a, v) => a + (v ?? 0), 0);
        idx.forEach((i, j) => { out[i] = vals[j] == null || total === 0 ? null : (vals[j] / total) * 100; });
        break;
      }
      case "diff": idx.forEach((i, j) => { out[i] = j === 0 || vals[j] == null || vals[j - 1] == null ? null : vals[j] - vals[j - 1]; }); break;
      case "pctDiff": idx.forEach((i, j) => {
        const p = vals[j - 1];
        out[i] = j === 0 || vals[j] == null || p == null || p === 0 ? null : ((vals[j] - p) / Math.abs(p)) * 100;
      }); break;
      case "rank": {
        // Competition ranking (1, 2, 2, 4), highest first; Other and blanks get none.
        const ranked = idx.map((i, j) => ({ i, v: rows[i].isOther ? null : vals[j] })).filter((x) => x.v != null).sort((a, b) => b.v - a.v);
        ranked.forEach((x, k) => { out[x.i] = k > 0 && x.v === ranked[k - 1].v ? out[ranked[k - 1].i] : k + 1; });
        break;
      }
      case "pctRank": {
        // From the competition rank: (n − rank) / (n − 1) × 100 — highest = 100, lowest = 0, ties share; a lone value = 100.
        const live = idx.map((i, j) => ({ i, v: rows[i].isOther ? null : vals[j] })).filter((x) => x.v != null);
        const n = live.length;
        const desc = live.map((x) => x.v).sort((p, q) => q - p);
        const first = new Map(); desc.forEach((v, k) => { if (!first.has(v)) first.set(v, k + 1); }); // competition rank of each value
        live.forEach((x) => { out[x.i] = n < 2 ? 100 : ((n - first.get(x.v)) / (n - 1)) * 100; });
        break;
      }
      case "moving": {
        const w = Math.max(2, Math.min(30, Number(calc.window) || 3));
        idx.forEach((i, j) => {
          const span = vals.slice(Math.max(0, j - w + 1), j + 1).filter((v) => v != null);
          out[i] = vals[j] == null || !span.length ? null : span.reduce((a, v) => a + v, 0) / span.length;
        });
        break;
      }
      default: idx.forEach((i, j) => { out[i] = vals[j]; });
    }
  }
  return out;
}

/**
 * A result with each calculated measure's values replaced and its name suffixed ("sum amount · running
 * total"). `calcs[mi]` is measure mi's calculation or null. Returns { result, percent: Set<mi> }.
 */
export function applyTableCalcs(result, calcs, rowDims, colDims) {
  const active = calcs.map((c, mi) => (isCalc(c) ? mi : -1)).filter((mi) => mi >= 0);
  if (!active.length) return { result, percent: new Set() };
  const cols = new Map(active.map((mi) => [mi, computeCalc(result.rows, mi, calcs[mi], rowDims, colDims)]));
  const rows = result.rows.map((r, ri) => ({ ...r, values: r.values.map((v, mi) => (cols.has(mi) ? cols.get(mi)[ri] : v)) }));
  const measures = result.measures.map((m, mi) => (cols.has(mi) ? `${m} · ${calcName(calcs[mi])}` : m));
  return { result: { ...result, rows, measures }, percent: new Set(active.filter((mi) => PERCENT_CALCS.has(calcs[mi].type))) };
}
