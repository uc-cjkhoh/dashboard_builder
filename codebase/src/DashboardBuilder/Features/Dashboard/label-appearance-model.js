// Label appearance (Label flyout → Text, Font, Alignment) — pure, DOM-free (tests/js/label-appearance.test.mjs). Three stored keys on `sheet.format`, each absent
// at its default so older files draw exactly as before: `labelText` (a template with <Field> placeholders, absent = the automatic text), `labelFont`
// ({ family?, size?, bold? }: the family from FONTS, a size from the 14 / 16 px scale, bold), `labelAlign` (left | center | right, absent = Automatic).
// A chart label is canvas text, so the template renders to plain text here (no HTML, no escaping) and the style is a fragment of ECharts label options.
import { LIMITS } from "../Core/validate.js";
import { FONTS } from "../Core/sheet-schema.js";
import { FONT_CHOICES } from "./font-model.js";
import { parseTooltip } from "./tooltip-model.js";
import { tipLookup } from "./tooltip-formats.js";

/** The placeholder for a mark's own automatic text (its value, or its Label field's text). */
export const LABEL_VALUE_FIELD = "Value";

// ---- Text -------------------------------------------------------------------------------------------------------------------------------------------
/** Why a stored template is refused, or null. */
export const labelTextError = (v) => (typeof v !== "string" ? "Label text must be text." : v.length > LIMITS.labelText ? `Label text must be at most ${LIMITS.labelText} characters.` : null);
/** `format.labelText` as a sheet stores it -> { ok, value } (blank = null: the automatic text). */
export function cleanLabelText(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: labelTextError(raw) };
  const v = raw.trim();
  if (!v || v === `<${LABEL_VALUE_FIELD}>`) return { ok: true, value: null }; // <Value> alone is the automatic text
  const error = labelTextError(v);
  return error ? { ok: false, error } : { ok: true, value: v };
}
/** The template a format asks for, or null. */
export const labelTextOf = (format) => (typeof format?.labelText === "string" && labelTextError(format.labelText) === null && format.labelText.trim() ? format.labelText : null);

/**
 * The per-mark label text for a template: `(si, di, { measures, valueText }) -> string`, or null when there is no template (the chart keeps its own text).
 * `fields` = [{ name, values, grid? }] the view's group-by / Tooltip fields: `values[di]` per mark, or `values[si][di]` when `grid` (a colour split's cells).
 * `measures` = { name: raw value } of the mark; `valueText` = the mark's automatic text, which <Value> stands for. An unknown placeholder stays as typed.
 */
export function labelTextResolver(template, fields, fmtVal, format) {
  if (!template) return null;
  const parts = parseTooltip(template).parts;
  const byName = new Map((fields ?? []).map((f) => [f.name, f]));
  return (si, di, { measures = {}, valueText = "" } = {}) => {
    const dims = new Map();
    for (const p of parts) {
      if (!("field" in p) || dims.has(p.field)) continue;
      const f = byName.get(p.field);
      if (f) dims.set(p.field, f.grid ? f.values?.[si]?.[di] : f.values?.[di]);
    }
    const look = tipLookup({ measures, dims, formats: null, fmtVal, format });
    return parts.map((p) => {
      if ("text" in p) return p.text;
      if (p.field === LABEL_VALUE_FIELD) return String(valueText ?? "");
      const v = look(p.field);
      return v === undefined || v === null ? `<${p.field}>` : String(v);
    }).join("");
  };
}

/** The fields the Text editor offers: <Value> first, then the view's fields ([{ name, sample, kind }] from tooltipCatalog). */
export const labelFieldCatalog = (catalog) => [{ name: LABEL_VALUE_FIELD, sample: "123", kind: "value" }, ...(catalog ?? []).filter((f) => f.name !== LABEL_VALUE_FIELD)];
/** The editor's preview: a template with each placeholder replaced by its sample (an unknown one stays as typed). */
export function labelTextPreview(template, catalog) {
  const sample = new Map((catalog ?? []).map((f) => [f.name, f.sample]));
  return parseTooltip(template).parts.map((p) => ("text" in p ? p.text : sample.has(p.field) ? String(sample.get(p.field)) : `<${p.field}>`)).join("");
}

// ---- Font -------------------------------------------------------------------------------------------------------------------------------------------
export const LABEL_FONT_FAMILIES = FONT_CHOICES;
/** [value, label] — Automatic keeps the chart's own size; the others come from the 14 / 16 px type scale (design rule 5). */
export const LABEL_SIZE_CHOICES = Object.freeze([["auto", "Automatic"], [14, "14 px"], [16, "16 px"]]);
export const LABEL_FONT_SIZES = Object.freeze([14, 16]);
/** Why a stored font is refused, or null. */
export function labelFontError(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "Label font must be an object.";
  if (v.family != null && !FONTS.has(v.family)) return "Label font family must be Default, Serif or Monospace.";
  if (v.size != null && !LABEL_FONT_SIZES.includes(v.size)) return `Label font size must be ${LABEL_FONT_SIZES.join(" or ")} px.`;
  if (v.bold != null && typeof v.bold !== "boolean") return "Label font bold must be on or off.";
  return null;
}
/** `format.labelFont` as a sheet stores it -> { ok, value } (value null when everything is at its default: nothing to store). */
export function cleanLabelFont(v) {
  if (v == null) return { ok: true, value: null };
  const error = labelFontError(v);
  if (error) return { ok: false, error };
  const out = {};
  if (v.family && v.family !== "default") out.family = v.family;
  if (v.size) out.size = v.size;
  if (v.bold) out.bold = true;
  return { ok: true, value: Object.keys(out).length ? out : null };
}
/** The font a format asks for, every part present: { family: "default" | …, size: 14 | 16 | null (automatic), bold }. */
export function labelFontOf(format) {
  const v = format?.labelFont;
  const ok = v != null && labelFontError(v) === null;
  return { family: ok && v.family ? v.family : "default", size: ok && v.size ? v.size : null, bold: ok && v.bold === true };
}

// ---- Alignment ----------------------------------------------------------------------------------------------------------------------------------
/** [value, label] — Format → Label alignment (the text's anchor inside its label; Automatic = the chart's own). */
export const LABEL_ALIGN_CHOICES = Object.freeze([["auto", "Automatic"], ["left", "Left"], ["center", "Center"], ["right", "Right"]]);
const ALIGNS = new Set(["left", "center", "right"]);
export const labelAlignError = (v) => (v === "auto" || (typeof v === "string" && ALIGNS.has(v)) ? null : "Label alignment must be Automatic, Left, Center or Right.");
export const labelAlignOf = (format) => (labelAlignError(format?.labelAlign) === null ? format.labelAlign : "auto");
export function cleanLabelAlign(v) {
  if (v == null || v === "auto") return { ok: true, value: null };
  const error = labelAlignError(v);
  return error ? { ok: false, error } : { ok: true, value: v };
}

/**
 * The ECharts label options a format adds: only the parts that are set (so an untouched format adds nothing), `resolveFamily(family)` giving the CSS stack of a
 * non-default family (the chart reads it from the theme's font tokens; canvas text cannot use var()).
 */
export function labelStyleOf(format, resolveFamily) {
  const font = labelFontOf(format), align = labelAlignOf(format), out = {};
  if (font.family !== "default") { const stack = resolveFamily?.(font.family); if (stack) out.fontFamily = stack; }
  if (font.size) out.fontSize = font.size;
  if (font.bold) out.fontWeight = 600; // the weight the axis names already use
  if (align !== "auto") out.align = align;
  return out;
}
