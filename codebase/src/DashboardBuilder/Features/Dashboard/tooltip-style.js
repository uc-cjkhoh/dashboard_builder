// Tooltip line styles + editor line model (tooltip modal) — pure, DOM-free (unit-tested under tests/js/).
// A sheet's `tooltipStyle` is null or an array aligned to the lines of `tooltipText` (split on "\n"):
// [{ size?: 14|16|24, bold?: true, italic?: true, color?: <TIP_COLOURS key> }]. Sizes come from the type scale and
// colours are design-token keys, so no user value is ever written into a style attribute.
import { LIMITS } from "../Core/validate.js";

export const TIP_SIZES = [14, 16, 24];
/** Palette key → the CSS token it resolves to (the tooltip is DOM, so var() follows the theme). */
export const TIP_COLOURS = { ink: "--ink", muted: "--ink-3", accent: "--accent-ink", ok: "--ok-ink", warn: "--warn-ink", dim: "--dim-ink", meas: "--meas-ink", enc: "--enc-ink" };
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
    for (const k of ["bold", "italic"]) if (e[k] != null) { if (typeof e[k] !== "boolean") return { ok: false, error: `Tooltip ${k} must be on or off.` }; if (e[k]) s[k] = true; }
    if (e.color != null) { if (typeof e.color !== "string" || !has(TIP_COLOURS, e.color)) return { ok: false, error: "Tooltip colour must be one of the palette colours." }; s.color = e.color; }
    out.push(s);
  }
  while (out.length && !Object.keys(out[out.length - 1]).length) out.pop();
  return { ok: true, value: out.length ? out : null };
}

/** The inline style for one line ("" when unstyled). Only whitelisted values reach the string. */
export function lineStyleCss(s) {
  if (!s || typeof s !== "object") return "";
  const css = [];
  if (TIP_SIZES.includes(s.size)) css.push(`font-size:${s.size}px`);
  if (s.bold === true) css.push("font-weight:700");
  if (s.italic === true) css.push("font-style:italic");
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
