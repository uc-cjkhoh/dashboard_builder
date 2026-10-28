// Member aliases (T02-29) — pure, DOM-free (tests/js/member-labels.test.mjs). A field setting `memberAliases`
// ({ [rawValue]: label }, in the workbook's field settings) gives each member of a field a display label. It is DISPLAY
// only: the query, grouping, sorting, filters and selections all keep the raw value; a label replaces the text drawn for a
// member on category axes, legends, tooltips, crosstab headers, filter lists and selection chips.
// Labels are UNIQUE within a field: no label equals another member's label or another member's raw value, so two members can never
// draw as one (charts key panels, Sankey nodes and legend items by the drawn text). setAlias, the dialog and the workbook open enforce it.
// Keys are member values, so a member may be called "constructor" or "__proto__": every map here has no prototype and is
// read with own-key checks only (the lesson of the per-member-colour review; the helpers are colour-model.js's).
import { LIMITS } from "../Core/validate.js";
import { memberKey, bare, has } from "./colour-model.js";

const isPlain = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

/** The label stored for `raw` in a field's map (own keys only; a null member is never labelled), or undefined. */
export function aliasOf(map, raw) {
  if (raw == null || !isPlain(map)) return undefined;
  const k = memberKey(raw);
  return has(map, k) && typeof map[k] === "string" ? map[k] : undefined;
}

const short = (s) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);
/** The other member (raw value) that already shows as `text` in this field, or undefined: its label, or its raw value (`members` = the field's known values). */
export function labelOwner(map, members, selfKey, text) {
  if (isPlain(map)) for (const k of Object.keys(map)) if (k !== selfKey && map[k] === text) return k;
  for (const m of members ?? []) { const k = memberKey(m); if (k !== selfKey && k === text) return k; }
  if (isPlain(map)) for (const k of Object.keys(map)) if (k !== selfKey && k === text) return k;
  return undefined;
}
const clash = (text, other) => ({ ok: false, error: `The label '${short(text)}' is already used by the member '${short(other)}'. Labels must be different within a field.` });

/** Set (or, with a blank label, clear) one member's label: { ok, value } — a NEW null-prototype map, undefined once empty. `members` = the field's other known values. */
export function setAlias(map, raw, label, members = []) {
  if (raw == null) return { ok: false, error: "The empty (NULL) value can't be given a label." };
  const k = memberKey(raw);
  if (k.length > LIMITS.memberKey) return { ok: false, error: `The member '${short(k)}' is longer than ${LIMITS.memberKey} characters, so it can't be given a label.` };
  const text = String(label ?? "").trim();
  if (text.length > LIMITS.memberLabel) return { ok: false, error: `A member label must be at most ${LIMITS.memberLabel} characters.` };
  const next = bare();
  if (isPlain(map)) for (const key of Object.keys(map)) next[key] = map[key];
  if (!text) delete next[k];
  else {
    const other = labelOwner(map, members, k, text);
    if (other !== undefined) return clash(text, other);
    if (!has(next, k) && Object.keys(next).length >= LIMITS.memberAliases) return { ok: false, error: `At most ${LIMITS.memberAliases} members per field can have a label.` };
    next[k] = text;
  }
  return { ok: true, value: Object.keys(next).length ? next : undefined };
}

/** Remove every label of a field (the field setting's new value). */
export const clearAliases = () => undefined;

/** A saved `memberAliases`, checked: bad entries dropped and reported, never coerced; undefined when nothing valid is left. */
export function cleanMemberAliases(raw, where, issues) {
  if (raw == null) return undefined;
  if (!isPlain(raw)) { issues.push(`${where}: member labels weren't an object — cleared.`); return undefined; }
  const out = bare();
  let dropped = 0, colliding = 0;
  const keys = Object.keys(raw);
  for (const k of keys) {
    const v = raw[k];
    if (typeof v !== "string" || !v.trim() || v.trim().length > LIMITS.memberLabel || k.length > LIMITS.memberKey || Object.keys(out).length >= LIMITS.memberAliases) { dropped++; continue; }
    const t = v.trim();
    // First wins, in the file's key order: a label already used by a kept member, or equal to another stored member's value, is dropped.
    if (Object.keys(out).some((o) => out[o] === t) || keys.some((o) => o !== k && o === t)) { colliding++; continue; }
    out[k] = t;
  }
  if (colliding) issues.push(`${where}: ${colliding} member label${colliding === 1 ? "" : "s"} dropped because another member already shows as that text.`);
  if (dropped) issues.push(`${where}: ${dropped} invalid member label${dropped === 1 ? "" : "s"} dropped.`);
  return Object.keys(out).length ? out : undefined;
}

/** The label maps of a query's group-by keys, in key order: `keyOrder` = planDims(sheet).keyOrder. A calculated or missing key has none. */
export const keyAliasMaps = (keyOrder, metaOf) => keyOrder.map((f) => (f && typeof f.calc !== "string" && f.table && f.column ? metaOf(f).memberAliases : undefined));

/**
 * The category formatter, label-aware: `(key, position) =>` the member's label when the key at that position has one, else
 * `fmtCat(key)`. Without a position (or beyond the keys) it is the plain formatter. With no labelled key it IS `fmtCat`.
 */
export function withMemberLabels(fmtCat, maps) {
  if (!maps?.some((m) => m !== undefined)) return fmtCat;
  return (k, i) => aliasOf(Number.isInteger(i) ? maps[i] : undefined, k) ?? fmtCat(k);
}

/** One member of one field as text: its label, else the plain format (selection chips, the drill path). `meta` = the field's settings. */
export const labelOf = (meta, raw, fmtCat) => aliasOf(meta?.memberAliases, raw) ?? fmtCat(raw);

/** The dialog's rows: each non-null member once (fetch order), then stored members the list no longer holds. */
export function memberRows(members, map) {
  const rows = [], seen = new Set();
  const add = (raw) => { const k = memberKey(raw); if (seen.has(k)) return; seen.add(k); rows.push({ raw: String(raw), label: aliasOf(map, raw) ?? "" }); };
  for (const m of members ?? []) if (m != null) add(m);
  if (isPlain(map)) for (const k of Object.keys(map)) add(k);
  return rows;
}

/** The map the dialog's typed rows make: blank and same-as-the-value labels are dropped, a member too long to key is skipped. */
export function aliasesFromInputs(rows) {
  let map;
  const all = rows.map((r) => String(r.raw));
  for (const { raw, label } of rows) {
    const text = String(label ?? "").trim();
    if (!text || text === String(raw)) continue;
    const r = setAlias(map, raw, text, all);
    if (!r.ok) return r;
    map = r.value;
  }
  return { ok: true, value: map };
}
