// Tooltip text template — pure, DOM-free (unit-tested under tests/js/).
// A sheet's `tooltipText` is user text with <Field> placeholders: "Sales for <customers.name>: <sum(amount)>".
// The chart tooltip is HTML, so every part (literal text AND substituted values) is escaped here; nothing
// the user typed ever reaches the tooltip as markup.
import { LIMITS } from "../Core/validate.js";
import { lineStyleCss, lineIsBlock } from "./tooltip-style.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/** Split a template into literal and field parts: { parts: [{ text } | { field }], fields: [name…] }.
 *  A `<` with no closing `>` (or a nested `<`) is plain text. */
export function parseTooltip(text) {
  const parts = [];
  const fields = [];
  const s = String(text ?? "");
  const lit = (t) => { if (!t) return; const last = parts[parts.length - 1]; if (last && "text" in last) last.text += t; else parts.push({ text: t }); };
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("<", i);
    if (open < 0) { lit(s.slice(i)); break; }
    const close = s.indexOf(">", open + 1);
    const inner = close < 0 ? null : s.slice(open + 1, close);
    if (inner == null || inner.includes("<") || !inner.trim()) { lit(s.slice(i, open + 1)); i = open + 1; continue; }
    lit(s.slice(i, open));
    const name = inner.trim();
    parts.push({ field: name });
    if (!fields.includes(name)) fields.push(name);
    i = close + 1;
  }
  return { parts, fields };
}

/** Validate user text: blank → null (the automatic tooltip); otherwise trimmed text ≤ LIMITS.tooltipText. */
export function checkTooltipText(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "Tooltip text must be text." };
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  if (v.length > LIMITS.tooltipText) return { ok: false, error: `Tooltip text must be at most ${LIMITS.tooltipText} characters.` };
  return { ok: true, value: v };
}

/** A name → value lookup over a plain object (own properties only). */
export const lookupFrom = (obj) => (name) => (Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : undefined);

/** Render a template to safe HTML. `lookup(name)` returns the formatted value or undefined; an unknown
 *  field shows as its literal (escaped) <name>. Newlines become <br>. `style` (optional, tooltip-style.js) styles
 *  each line; the chart tooltip and the editor's preview both render through here. */
export function tooltipHtml(text, lookup, style = null) {
  const lines = [""];
  for (const p of parseTooltip(text).parts) {
    if ("text" in p) {
      const chunks = p.text.split(/\r?\n/);
      chunks.forEach((c, i) => { if (i) lines.push(""); lines[lines.length - 1] += esc(c); });
    } else {
      const v = lookup(p.field);
      lines[lines.length - 1] += v === undefined || v === null ? esc(`<${p.field}>`) : `<b>${esc(v)}</b>`;
    }
  }
  // An aligned line is a block (text-align needs a box); a block already ends its line, so a <br> goes only between two inline lines.
  let out = "", prevBlock = true;
  lines.forEach((h, i) => {
    const css = lineStyleCss(style?.[i]), block = lineIsBlock(style?.[i]);
    if (i && !block && !prevBlock) out += "<br>";
    out += block ? `<div style="${css}">${h || "&#8203;"}</div>` : css ? `<span style="${css}">${h}</span>` : h;
    prevBlock = block;
  });
  return out;
}

/** The fields an editor can offer, with a sample (first mark) value (measures also their raw value, for per-field formats): group-by / mark fields
 *  ({ name, values }) first, then the measures (`measureNames` with the first row's `measureSamples`). */
export function tooltipCatalog(dimFields, measureNames, measureSamples, measureRaw = []) {
  const seen = new Set();
  const out = [];
  for (const f of dimFields ?? []) if (!seen.has(f.name)) { seen.add(f.name); out.push({ name: f.name, sample: String(f.values?.[0] ?? ""), kind: "dim" }); }
  (measureNames ?? []).forEach((n, i) => { if (!seen.has(n)) { seen.add(n); out.push({ name: n, sample: String(measureSamples?.[i] ?? ""), kind: "measure", ...(measureRaw[i] !== undefined ? { raw: measureRaw[i] } : {}) }); } });
  return out;
}
