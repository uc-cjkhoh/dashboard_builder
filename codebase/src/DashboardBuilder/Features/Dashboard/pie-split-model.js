// A pie / donut split by Colour — pure, DOM-free (tests/js/colour-split.test.mjs). The result has the slice keys first and the Colour key(s) last, one row per
// (slice, member): each becomes a sub-slice. They are grouped under their slice (slices in first-seen order — the server's sort — and a slice's members as the
// server returned them), each Colour member keeps one index and so one colour across every slice, and a sub-slice is named "slice · member".
import { tupleKey } from "./grid-model.js";
import { memberText, memberRaw } from "./colour-fields-model.js";

/**
 * `rows` = the result rows (an `isOther` row, if any, stays last and has no member); `k` = how many trailing keys are Colour.
 * -> { rows, categories, slices, members: [{ name, raw, index }], memberIndex } — aligned arrays, one entry per sub-slice.
 */
export function pieSplit(rows, k, fmtCat) {
  const label = (v, i) => (v == null ? "—" : fmtCat(v, i));
  const real = rows.filter((r) => !r.isOther), other = rows.filter((r) => r.isOther);
  const members = new Map(), slices = new Map();
  for (const r of real) {
    const at = r.keys.length - k;
    const mk = tupleKey(r.keys.slice(at)), sk = tupleKey(r.keys.slice(0, at));
    if (!members.has(mk)) {
      const tuple = r.keys.slice(at);
      members.set(mk, { name: memberText(tuple.map((v, j) => (v == null ? null : label(v, at + j)))), raw: k === 1 ? tuple[0] : memberRaw(tuple), index: members.size });
    }
    if (!slices.has(sk)) slices.set(sk, []);
    slices.get(sk).push({ r, m: members.get(mk), at });
  }
  const ordered = [...slices.values()].flat();
  const sliceText = ({ r, at }) => r.keys.slice(0, at).map((v, i) => label(v, i)).join(" / ");
  return {
    rows: [...ordered.map((o) => o.r), ...other],
    slices: [...ordered.map(sliceText), ...other.map((r) => String(r.keys[0] ?? "—"))],
    categories: [...ordered.map((o) => `${sliceText(o)} · ${o.m.name}`), ...other.map((r) => String(r.keys[0] ?? "—"))],
    members: [...members.values()],
    memberIndex: [...ordered.map((o) => o.m.index), ...other.map(() => -1)],
  };
}
