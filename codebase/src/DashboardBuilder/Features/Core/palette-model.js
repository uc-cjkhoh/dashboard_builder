// Colour palettes the user creates — pure, DOM-free (tests/js/palette-model.test.mjs). A palette is { name, colours: ["#rrggbb", …] }: 1 to 24
// colours, in the order they are applied. The workbook holds up to 12 of them beside the generated Default (Core/theme-model.js
// categoryColour, which is not a stored list). A palette is a source of colours for the Edit member colours dialog: clicking its
// title stages its n-th colour for the n-th member, and what a member is given is stored as the member's own #rrggbb, not as a
// reference to the palette, so removing or changing a palette never recolours a chart. Client-side only: the server never sees one.
import { LIMITS } from "./validate.js";

export const DEFAULT_PALETTE_NAME = "Default";
const HEX6 = /^#?[0-9a-f]{6}$/i; // the custom colour field's rule: six digits, # optional
export const isHex6 = (v) => typeof v === "string" && HEX6.test(v.trim());
export const normHex = (v) => { const t = String(v).trim().toLowerCase(); return t.startsWith("#") ? t : `#${t}`; };
const isPlain = (x) => x !== null && typeof x === "object" && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const CONTROL = /[\u0000-\u001f\u007f]/;
const shown = (v) => { const t = String(v); return `“${t.length > 16 ? `${t.slice(0, 15)}…` : t}”`; };

/** The reasons a name can't be used (an empty list when it can). `others` are the names already taken (the Default's is always taken). */
function nameErrors(rawName, others) {
  const name = String(rawName ?? "").trim();
  if (!name) return ["Name the palette."];
  if (name.length > LIMITS.paletteName) return [`A name is at most ${LIMITS.paletteName} characters.`];
  if (CONTROL.test(name)) return ["A name can't contain control characters."];
  const low = name.toLowerCase();
  if (low === DEFAULT_PALETTE_NAME.toLowerCase() || others.some((n) => String(n).toLowerCase() === low)) return [`A palette called ${shown(name)} already exists.`];
  return [];
}

/**
 * A palette to add, checked: { ok: true, palette } or { ok: false, errors: [...] } with every reason. `existing` are the palettes the
 * workbook already holds (plus any made earlier in the same dialog session).
 */
export function checkNewPalette({ name, colours }, existing = []) {
  const errors = [];
  if (existing.length >= LIMITS.palettes) errors.push(`A workbook can hold at most ${LIMITS.palettes} palettes.`);
  errors.push(...nameErrors(name, existing.map((p) => p.name)));
  if (!colours.length) errors.push("A palette needs at least one colour.");
  else if (colours.length > LIMITS.paletteColours) errors.push(`A palette holds at most ${LIMITS.paletteColours} colours (this one has ${colours.length}).`);
  else if (colours.some((c) => !isHex6(c))) errors.push("Every colour needs to be #rrggbb.");
  return errors.length ? { ok: false, errors } : { ok: true, palette: { name: String(name).trim(), colours: colours.map(normHex) } };
}

// The palette being made in the Create palette dialog: { colours: ["#rrggbb", …] in creation order, selected: index | -1 }. Each edit
// returns a new state; one past the colour limit is refused (the state comes back as it was), never cut.
export const newPaletteDraft = (first) => ({ colours: [normHex(first)], selected: 0 });
export function addColour(d, colour) {
  if (d.colours.length >= LIMITS.paletteColours) return d;
  return { colours: [...d.colours, normHex(colour)], selected: d.colours.length };
}
export function setColour(d, colour) { // the selected colour becomes `colour`
  if (d.selected < 0 || !isHex6(colour)) return d;
  return { ...d, colours: d.colours.map((c, i) => (i === d.selected ? normHex(colour) : c)) };
}
export function removeColour(d, at = d.selected) { // the selection moves to the colour now at that place, else the last one
  if (at < 0 || at >= d.colours.length) return d;
  const colours = d.colours.filter((_, i) => i !== at);
  return { colours, selected: Math.min(at, colours.length - 1) };
}
export const selectColour = (d, i) => (i >= 0 && i < d.colours.length ? { ...d, selected: i } : d);

/**
 * A workbook's saved palettes, checked on open. A palette that is not usable is dropped and reported; the rest are kept in order,
 * up to the limit. Absent (older files) is no palettes.
 */
export function cleanPalettes(raw, issues = []) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { issues.push("The saved colour palettes couldn't be read and were dropped."); return []; }
  const kept = [];
  for (const [i, p] of raw.entries()) {
    const label = isPlain(p) && typeof p.name === "string" && p.name.trim() ? shown(p.name.trim()) : `#${i + 1}`;
    if (!isPlain(p) || !Array.isArray(p.colours) || p.colours.some((c) => !isHex6(c))) { issues.push(`Palette ${label} had colours that are not #rrggbb and was dropped.`); continue; }
    const r = checkNewPalette({ name: p.name, colours: p.colours }, kept);
    if (r.ok) kept.push(r.palette);
    else issues.push(`Palette ${label} was dropped: ${r.errors[0]}`);
  }
  return kept;
}

/** The colour each key takes from `colours` in order, repeating from the first when keys outnumber colours: { key: "#rrggbb" }. */
export function assignPalette(colours, keys) {
  const out = Object.create(null);
  if (!colours.length) return out;
  keys.forEach((k, i) => { out[k] = colours[i % colours.length]; });
  return out;
}
