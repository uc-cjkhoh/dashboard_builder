// Tooltip line styles + editor line model (tooltip modal) — pure, DOM-free (unit-tested under tests/js/).
// A sheet's `tooltipStyle` is null or an array aligned to the lines of `tooltipText` (split on "\n"):
// [{ font?: <TIP_FONTS key>, size?: 14|16|24, bold?: true, italic?: true, underline?: true, align?: "left"|"center"|"right", color?: <TIP_COLOURS key> }].
// Sizes come from the type scale, colours and fonts are design-token keys, so no user value is ever written into a style attribute.
import { LIMITS } from "../Core/validate.js";
import { FONT_CHOICES, MS_FONT_CHOICES } from "./font-model.js";

export const TIP_SIZES = [14, 16, 24];
/** Palette key → the CSS token it resolves to (the tooltip is DOM, so var() follows the theme). */
export const TIP_COLOURS = { ink: "--ink", muted: "--ink-3", accent: "--accent-ink", ok: "--ok-ink", warn: "--warn-ink", dim: "--dim-ink", meas: "--meas-ink", enc: "--enc-ink" };
/** [key, label] — the families a line can wear: the worksheet's own three and the Microsoft Typography fonts (the Label flyout's list); the default (the app's font) is "no key". */
export const TIP_FONTS = Object.freeze([...FONT_CHOICES, ...MS_FONT_CHOICES].filter((c) => c[0] !== "default"));
const FONT_KEYS = new Set(TIP_FONTS.map((c) => c[0]));
export const TIP_ALIGNS = ["left", "center", "right"];
export const TIP_COLOUR_LABELS = { ink: "Text", muted: "Muted", accent: "Accent", ok: "Green", warn: "Amber", dim: "Blue", meas: "Teal", enc: "Violet" };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Validate a stored style → { ok, value } (value null when nothing is styled; defaults and trailing blanks are trimmed). */
export function checkTooltipStyle(raw) {
  if (raw == null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, error: "Tooltip style must be a list." };
  if (raw.length > LIMITS.tooltipLines) return { ok: false, error: `Tooltip style covers at most ${LIMITS.tooltipLines} lines.` };
  const out = [];
  for (const e of raw) {
    if (e == null) { out.push({}); continue; }
    if (typeof e !== "object" || Array.isArray(e)) return { ok: false, error: "Each tooltip line style must be an object." };
    const s = {};
    if (e.size != null) { if (!TIP_SIZES.includes(e.size)) return { ok: false, error: `Tooltip font size must be one of ${TIP_SIZES.join(", ")}.` }; s.size = e.size; }
    if (e.font != null) { if (typeof e.font !== "string" || !FONT_KEYS.has(e.font)) return { ok: false, error: "Tooltip font must be one of the listed fonts." }; s.font = e.font; }
    if (e.align != null) { if (!TIP_ALIGNS.includes(e.align)) return { ok: false, error: `Tooltip alignment must be one of ${TIP_ALIGNS.join(", ")}.` }; if (e.align !== "left") s.align = e.align; } // left is the default: never stored
    for (const k of ["bold", "italic", "underline"]) if (e[k] != null) { if (typeof e[k] !== "boolean") return { ok: false, error: `Tooltip ${k} must be on or off.` }; if (e[k]) s[k] = true; }
    if (e.color != null) { if (typeof e.color !== "string" || !has(TIP_COLOURS, e.color)) return { ok: false, error: "Tooltip colour must be one of the palette colours." }; s.color = e.color; }
    out.push(s);
  }
  while (out.length && !Object.keys(out[out.length - 1]).length) out.pop();
  return { ok: true, value: out.length ? out : null };
}

/** Whether a line is drawn as its own block (an aligned line needs a box to align in: `text-align` does nothing on an inline span). */
export const lineIsBlock = (s) => Boolean(s) && typeof s === "object" && (s.align === "center" || s.align === "right");

/** The inline style for one line ("" when unstyled). Only whitelisted values reach the string. */
export function lineStyleCss(s) {
  if (!s || typeof s !== "object") return "";
  const css = [];
  if (typeof s.font === "string" && FONT_KEYS.has(s.font)) css.push(`font-family:var(--font-${s.font})`); // design-lint-ignore: one --font-<key> token per whitelisted TIP_FONTS key, all defined in core.css (tests/js/label-appearance.test.mjs checks each)
  if (s.align === "center" || s.align === "right") css.push(`text-align:${s.align}`);
  if (TIP_SIZES.includes(s.size)) css.push(`font-size:${s.size}px`);
  if (s.bold === true) css.push("font-weight:700");
  if (s.italic === true) css.push("font-style:italic");
  if (s.underline === true) css.push("text-decoration:underline");
  if (typeof s.color === "string" && has(TIP_COLOURS, s.color)) css.push(`color:var(${TIP_COLOURS[s.color]})`);
  return css.join(";");
}

// ---- the editor's line list: [{ text, size?, bold?, italic?, color? }] ------------------------------------------
export function toLines(text, style) {
  return String(text ?? "").split("\n").map((t, i) => ({ text: t, ...(style?.[i] ?? {}) }));
}
/** → { text, style } for the sheet: leading / trailing blank lines are dropped together with their styles, so the style
 *  stays aligned with the (already trimmed) text; nothing but blanks → { text: "", style: null }. */
export function fromLines(lines) {
  const blank = (l) => !l.text.trim();
  let a = 0, z = lines.length;
  while (a < z && blank(lines[a])) a++;
  while (z > a && blank(lines[z - 1])) z--;
  const kept = lines.slice(a, z);
  if (!kept.length) return { text: "", style: null };
  const style = checkTooltipStyle(kept.map(({ text: _t, ...s }) => s));
  return { text: kept.map((l) => l.text).join("\n"), style: style.ok ? style.value : null };
}
/** A style after the template text was edited outside the modal: kept only when the line count is unchanged (it re-aligns
 *  by index), otherwise cleared (null). */
export function styleAfterTextEdit(oldText, newText, style) {
  if (!style) return null;
  const n = (t) => String(t ?? "").split("\n").length;
  return n(oldText) === n(newText) ? style : null;
}
export function moveLine(lines, i, d) {
  const j = i + d;
  if (i < 0 || i >= lines.length || j < 0 || j >= lines.length) return lines;
  const out = lines.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
export const addLine = (lines, at = lines.length) => (lines.length >= LIMITS.tooltipLines ? lines : [...lines.slice(0, at), { text: "" }, ...lines.slice(at)]);
export const removeLine = (lines, i) => (lines.length <= 1 ? lines : lines.filter((_, k) => k !== i));
const total = (lines) => lines.map((l) => l.text).join("\n").length;
/** Put `<name>` into line i between caret positions a..z (unchanged when it would pass the length limit). */
export function insertField(lines, i, name, a, z) {
  const t = lines[i].text, ins = `<${name}>`;
  const next = `${t.slice(0, a)}${ins}${t.slice(z)}`;
  if (total(lines) - t.length + next.length > LIMITS.tooltipText) return lines;
  return lines.map((l, k) => (k === i ? { ...l, text: next } : l));
}

// ---- the editor surface: one text, a style per line ---------------------------------------------------------------
// A position is { line, off } (a character offset inside the line); a range runs from `a` to `z`, in either order.
const STYLE_FIELDS = ["font", "size", "bold", "italic", "underline", "align", "color"];
const styleOf = (l) => Object.fromEntries(STYLE_FIELDS.filter((k) => l[k] != null).map((k) => [k, l[k]]));
const before = (a, z) => a.line < z.line || (a.line === z.line && a.off <= z.off);
/** The range with its start first. */
export const orderRange = (a, z) => (before(a, z) ? { a, z } : { a: z, z: a });
/**
 * Type `text` (it may hold line breaks) over the range a..z -> { lines, caret }. The first line of the range keeps its style and every line the text adds wears it too
 * (typing goes on in the format you were in); the lines the range ran over are gone, and what followed the range joins the last inserted line. The input is not changed.
 */
export function replaceRange(lines, from, to, text) {
  const { a, z } = orderRange(from, to);
  const head = lines[a.line].text.slice(0, a.off), tail = lines[z.line].text.slice(z.off);
  const parts = String(text ?? "").split(/\r\n|\r|\n/), style = styleOf(lines[a.line]);
  const last = parts.length - 1;
  const made = parts.map((p, i) => ({ ...style, text: (i === 0 ? head : "") + p + (i === last ? tail : "") }));
  return { lines: [...lines.slice(0, a.line), ...made, ...lines.slice(z.line + 1)], caret: { line: a.line + last, off: (last === 0 ? head.length : 0) + parts[last].length } };
}
/** `patch` ({ key: value | undefined }) applied to lines `from`..`to` (inclusive, any order); undefined removes the key. The input is not changed. */
export function patchLines(lines, from, to, patch) {
  const lo = Math.min(from, to), hi = Math.max(from, to);
  return lines.map((l, i) => {
    if (i < lo || i > hi) return l;
    const next = { ...l };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
    return next;
  });
}
/** Where Ctrl+Backspace stops: the start of the word before `off` (spaces first, then the word). */
export function wordStart(text, off) {
  let i = off;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}
/** Where Ctrl+Delete stops: the end of the word after `off` (the word first, then the spaces). */
export function wordEnd(text, off) {
  let i = off;
  while (i < text.length && !/\s/.test(text[i])) i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}
