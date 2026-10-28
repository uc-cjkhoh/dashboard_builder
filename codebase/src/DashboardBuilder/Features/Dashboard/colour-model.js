// Per-member colours and palette order (T01-20, T03-24, T03-33) — pure, DOM-free (tests/js/colour-model.test.mjs).
// A sheet's `memberColors` is { [fieldKey]: { [memberKey]: "#rrggbb" } }: the colour a user gave one member of a
// discrete colour field (a Colour-shelf member, a pie slice, a bar coloured by category). It is workbook DATA
// (a validated #rrggbb), unlike the app's own CSS, which uses tokens only. `format.paletteReverse` reverses the
// categorical order and the continuous ramp.
import { LIMITS } from "../Core/validate.js";


const HEX = /^#[0-9a-f]{6}$/i;
const NULL_KEY = "\u0000null";
/** Fixed swatches the picker offers — the three workbook palettes' light colours, de-duplicated. */
export const SWATCHES = Object.freeze([
  "#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834", "#4a3aa7", "#e34948",
  "#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#f0e442", "#000000",
  "#4e79a7", "#f28e2b", "#59a14f", "#b07aa1", "#76b7b2", "#edc948", "#9c755f", "#bab0ac",
]);

/** The storage key of a member value (null/undefined is its own key). */
export const memberKey = (raw) => (raw == null ? NULL_KEY : String(raw));
/** The storage key of a colour field. */
export const fieldColorKey = (f) => `${f.table}.${f.column}`;

const isPlain = (o) => o && typeof o === "object" && !Array.isArray(o);
export const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** A map with no prototype, so member names like "constructor" or "__proto__" are ordinary keys. */
export const bare = (entries = {}) => Object.assign(Object.create(null), entries);
/** The stored colour of one member in a field's map (own keys only), or undefined. */
export const colourOf = (fieldMap, member) => (isPlain(fieldMap) && has(fieldMap, member) && HEX.test(fieldMap[member]) ? fieldMap[member] : undefined);

/** Set (hex) or clear (null) one member's colour: { ok, value } with a new map, or { ok:false, error }. */
export function setMemberColor(map, field, member, hex) {
  const next = bare();
  for (const [f, m] of Object.entries(map ?? {})) next[f] = bare(m);
  if (hex == null) {
    if (next[field]) { delete next[field][member]; if (!Object.keys(next[field]).length) delete next[field]; }
    return { ok: true, value: next };
  }
  if (!HEX.test(hex)) return { ok: false, error: "Enter a colour as #rrggbb." };
  if (member.length > LIMITS.memberKey) return { ok: false, error: `A member name must be at most ${LIMITS.memberKey} characters to be coloured.` };
  const cur = has(next, field) ? next[field] : bare();
  if (!has(cur, member) && Object.keys(cur).length >= LIMITS.memberColors) return { ok: false, error: `At most ${LIMITS.memberColors} members per field can have a colour.` };
  if (!has(next, field) && Object.keys(next).length >= LIMITS.memberColorFields) return { ok: false, error: `At most ${LIMITS.memberColorFields} fields can have member colours.` };
  next[field] = bare({ ...cur, [member]: hex.toLowerCase() });
  return { ok: true, value: next };
}

/** Remove every colour of one field: { ok, value } with a new map. */
export function clearFieldColors(map, field) {
  const next = bare();
  for (const [f, m] of Object.entries(map ?? {})) if (f !== field) next[f] = bare(m);
  return { ok: true, value: next };
}

/** A saved memberColors map, checked: bad entries dropped and reported, never coerced. */
export function cleanMemberColors(raw, where, issues) {
  if (raw == null) return {};
  if (!isPlain(raw)) { issues.push(`${where}: member colours weren't an object — cleared.`); return {}; }
  const out = bare();
  let dropped = 0;
  for (const field of Object.keys(raw)) {
    const members = has(raw, field) ? raw[field] : undefined;
    if (field === "__proto__" || !isPlain(members) || field.length > LIMITS.memberField) { dropped++; continue; }
    if (Object.keys(out).length >= LIMITS.memberColorFields) { dropped++; continue; }
    const kept = bare();
    for (const [m, hex] of Object.entries(members)) {
      if (m === "__proto__" || typeof hex !== "string" || !HEX.test(hex) || m.length > LIMITS.memberKey || Object.keys(kept).length >= LIMITS.memberColors) { dropped++; continue; }
      kept[m] = hex.toLowerCase();
    }
    if (Object.keys(kept).length) out[field] = kept;
  }
  if (dropped) issues.push(`${where}: ${dropped} invalid member colour${dropped === 1 ? "" : "s"} dropped.`);
  return out;
}

/** displayed name → colour, for the members ({ name, raw }) a view shows that have a saved colour. */
export function colorsByName(fieldMap, members) {
  const out = new Map();
  if (!isPlain(fieldMap)) return out;
  for (const { name, raw } of members ?? []) {
    const c = colourOf(fieldMap, memberKey(raw));
    if (c) out.set(name, c);
  }
  return out;
}

/** The categorical palette in drawing order (a reversed copy when `reverse`). */
export const orderedPalette = (cat, reverse) => (reverse ? [...cat].reverse() : [...cat]);
/** The continuous ramp's two stops, low → high (swapped when `reverse`). */
export const rampStops = (low, high, reverse) => (reverse ? [high, low] : [low, high]);

