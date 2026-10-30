import { tupleKey } from "./grid-model.js";
import { combine } from "./analytics-model.js";

// Expand / collapse crosstab headers (T03-29). Pure: no DOM, no state. A collapsed header hides the levels below it and
// stands for all of them as one row (or column). State is a list of keys per axis on `sheet.collapsed`
// ({ rows: [key…], cols: [key…] }), saved with the workbook. A key names the dimensions down to the header's level plus
// the member path, so a re-ordered shelf never applies a key to other members.

export const MAX_COLLAPSED = 200; // collapsed headers kept per axis (client-side only; the server never sees it)
const MAX_KEY = 600;

/** The key of the header at `level` (0-based) on the path `tuple` of the dimensions `names`. */
export function collapseKey(names, tuple, level) {
  return `${names.slice(0, level + 1).join("\u0001")}\u0002${tupleKey(tuple.slice(0, level + 1))}`;
}

/** A header can collapse only when a next level sits below it. */
export const canToggle = (level, depth) => level >= 0 && level < depth - 1;

/**
 * Roll the distinct `tuples` up under the collapsed headers: one node per visible row / column, in first-seen order —
 * { tuple, members, level }. An expanded tuple is its own node (level null); a collapsed header's node holds the header's
 * path (length level + 1) and every tuple it stands for. The outermost collapsed ancestor wins.
 */
export function rollUp(tuples, names, collapsed) {
  const nodes = []; const byKey = new Map();
  for (const t of tuples) {
    let level = null;
    for (let l = 0; l < t.length - 1; l++) if (collapsed.has(collapseKey(names, t, l))) { level = l; break; }
    const tuple = level === null ? t : t.slice(0, level + 1);
    const k = `${level ?? ""}:${tupleKey(tuple)}`;
    let node = byKey.get(k);
    if (!node) { node = { tuple, members: [], level }; byKey.set(k, node); nodes.push(node); }
    node.members.push(t);
  }
  return nodes;
}

/** Header / stub leaves of the nodes: one per node (measureCount 0) or one per node × measure. No nodes → one empty leaf. */
export function expandNodes(nodes, measureCount) {
  const src = nodes.length ? nodes : [{ tuple: [], members: [[]], level: null }];
  const out = [];
  for (const n of src) {
    if (measureCount === 0) out.push({ ...n, mi: null });
    else for (let mi = 0; mi < measureCount; mi++) out.push({ ...n, mi });
  }
  return out;
}

/** The collapsed keys of one axis ("rows" | "cols") as a Set. */
export const collapsedOf = (sheet, axis) => new Set(sheet?.collapsed?.[axis] ?? []);

/** A saved `collapsed` value, checked: string keys only, de-duplicated, capped; null when nothing is collapsed. */
export function cleanCollapsed(c, where, issues) {
  if (c == null) return null;
  if (typeof c !== "object" || Array.isArray(c)) { issues.push(`${where}: collapsed headers cleared.`); return null; }
  const out = { rows: [], cols: [] };
  let dropped = false;
  for (const axis of ["rows", "cols"]) {
    const list = Array.isArray(c[axis]) ? c[axis] : [];
    if (c[axis] != null && !Array.isArray(c[axis])) dropped = true;
    for (const k of list) {
      if (typeof k !== "string" || k.length > MAX_KEY || out[axis].includes(k)) { if (typeof k !== "string" || k.length > MAX_KEY) dropped = true; continue; }
      if (out[axis].length < MAX_COLLAPSED) out[axis].push(k); else dropped = true;
    }
  }
  if (dropped) issues.push(`${where}: some collapsed headers were invalid — dropped.`);
  return out.rows.length || out.cols.length ? out : null;
}

/**
 * The value at a (left, top) leaf pair. Two expanded leaves read their own cell. When either stands for a collapsed header
 * the value is the header's cells combined by the measure's own aggregation (`combine`: sums and counts add, min / max
 * take min / max); an average, distinct count, median, percentile or table calculation can't be rebuilt from its parts,
 * so `agg` null / non-additive gives null ("—") — never a client-side re-aggregation.
 * `cell(rowTuple, colTuple, mi)` reads one grouped result cell. `complete` false (rows still paging, or the result was cut
 * at its group limit) means a combined value would be a partial sum shown as whole: it is null too.
 */
export function leafValue(agg, cell, left, top, mi, complete = true) {
  if (left.level === null && top.level === null) return cell(left.tuple, top.tuple, mi);
  if (!agg || !complete) return null;
  const vals = [];
  for (const rt of left.members) for (const ct of top.members) vals.push(cell(rt, ct, mi));
  return combine(agg, vals);
}

/** Every header key that exists in `tuples` (distinct paths of `names`): one per path prefix with a level below it. */
export function headerKeys(tuples, names) {
  const out = new Set();
  for (const t of tuples) for (let l = 0; l < t.length - 1; l++) out.add(collapseKey(names, t, l));
  return out;
}

/**
 * Flip `key` on one axis of `collapsed`. Keys that match no current header (`valid`) are pruned first, so a stale key never
 * uses up the cap. At the cap, an expanded header can't be collapsed: { blocked: true } and nothing changes.
 * Returns { collapsed, blocked } — `collapsed` null when nothing is collapsed on either axis.
 */
export function applyToggle(collapsed, axis, key, valid) {
  const next = { rows: [...(collapsed?.rows ?? [])], cols: [...(collapsed?.cols ?? [])] };
  next[axis] = next[axis].filter((k) => valid.has(k));
  if (next[axis].includes(key)) next[axis] = next[axis].filter((k) => k !== key);
  else if (next[axis].length >= MAX_COLLAPSED) return { collapsed, blocked: true };
  else next[axis].push(key);
  return { collapsed: next.rows.length || next.cols.length ? next : null, blocked: false };
}

/** The values each measure shows, per measure index: what a conditional-format scale or bar must be measured on. */
export function shownValues(leftLeaves, topLeaves, measureOnLeft, measureCount, leafAt) {
  const out = Array.from({ length: measureCount }, () => []);
  for (const l of leftLeaves) for (const t of topLeaves) {
    const mi = measureOnLeft ? l.mi : t.mi ?? 0;
    if (mi < measureCount) out[mi].push(leafAt(l, t, mi));
  }
  return out;
}
