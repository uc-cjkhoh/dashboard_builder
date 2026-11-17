// The "Edit tooltip…" modal: left = the tooltip's lines (text with <Field> tokens, reorder, size / bold / italic / colour per line),
// right = a live preview built by the same tooltipHtml() the chart hover uses. DOM only — the rules are in tooltip-style.js and
// tooltip-model.js. Edits are a draft until Apply (one commit); Esc / Cancel discard.
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { LIMITS } from "../Core/validate.js";
import { tooltipHtml, parseTooltip } from "./tooltip-model.js";
import { TIP_NUMBER_FORMATS, TIP_DATE_FORMATS, checkTooltipFormats, pruneFormats, looksDate, sampleLookup } from "./tooltip-formats.js";
import { MAX_DECIMALS } from "../Core/sheet-schema.js";
import { TIP_SIZES, TIP_COLOURS, TIP_COLOUR_LABELS, toLines, fromLines, moveLine, addLine, removeLine, insertField } from "./tooltip-style.js";

let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

/** `text` / `style` / `formats`: the sheet's current tooltipText / tooltipStyle / tooltipFormats; `format`: the sheet's Format config (a field format starts from it); `fields`: [{ name, sample }] the drawn chart offers;
 *  `onClose()` runs after the dialog closes (focus return); `onApply({ text, style, formats })` receives the validated result ({ text: "", style: null, formats: null } = the automatic tooltip). */
export function openTooltipDialog({ text, style, formats: formats0, format, fields, onApply, onClose }) {
  const n = ++seq;
  let lines = toLines(text, style);
  let formats = formats0 ? structuredClone(formats0) : {}; // draft per-field formats { name: { number?, decimals?, date? } }
  let active = 0; // the line a field chip inserts into
  const dlg = el("dialog", "dialog tipdlg");
  const title = el("h3", "dialog__title", "Tooltip");
  title.id = `tipdlg-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body tipdlg__body");
  const left = el("div", "tipdlg__edit");
  const right = el("div", "tipdlg__side");
  const chips = el("div", "tipdlg__chips");
  chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Insert a field into the selected line");
  const list = el("div", "tipdlg__lines");
  list.setAttribute("role", "list");
  const add = makeButton("Add line", "btn btn--ghost tipdlg__add");
  const count = el("span", "tipdlg__count");
  const err = el("div", "tipdlg__error"); err.setAttribute("role", "alert");
  const tools = el("div", "tipdlg__tools"); tools.append(add, count);
  const fmtBox = el("div", "tipdlg__formats");
  fmtBox.setAttribute("role", "group"); fmtBox.setAttribute("aria-label", "Field formats");
  left.append(chips, list, tools, fmtBox, err);
  const previewHead = el("div", "tipdlg__head", "Preview");
  const preview = el("div", "tipdlg__preview"); preview.setAttribute("aria-label", "Tooltip preview");
  right.append(previewHead, preview);
  body.append(left, right);
  const foot = el("div", "dialog__foot");
  const reset = makeButton("Automatic", "btn tipdlg__reset"), cancel = makeButton("Cancel", "btn"), apply = makeButton("Apply", "btn btn--primary");
  reset.title = "Use the automatic tooltip";
  foot.append(reset, cancel, apply);
  dlg.append(title, body, foot);

  const known = new Map((fields ?? []).map((f) => [f.name, f]));
  const sample = () => sampleLookup(fields, checkTooltipFormats(formats).value, format);
  const totalLen = () => lines.map((l) => l.text).join("\n").length;
  const draw = (focusSel) => {
    list.replaceChildren();
    lines.forEach((l, i) => list.append(lineRow(l, i)));
    add.disabled = lines.length >= LIMITS.tooltipLines;
    refresh();
    if (focusSel) list.querySelector(focusSel)?.focus();
  };
  const refresh = () => {
    const { text: t, style: st } = fromLines(lines);
    const look = sample();
    if (!t) preview.textContent = "Automatic tooltip";
    else preview.innerHTML = tooltipHtml(t, look, st); // escaped parts + whitelisted style only (tooltip-model.js)
    const used = t ? parseTooltip(t).fields : [];
    drawFormats(used);
    const unknown = used.filter((f) => look(f) === undefined);
    count.textContent = `${totalLen()}/${LIMITS.tooltipText}${unknown.length ? ` · not in this view: ${unknown.map((f) => `<${f}>`).join(" ")}` : ""}`;
    const fmtCheck = checkTooltipFormats(pruneFormats(formats, used));
    const bad = !fmtCheck.ok ? fmtCheck.error : totalLen() > LIMITS.tooltipText ? `Tooltip text must be at most ${LIMITS.tooltipText} characters.`
      : lines.length > LIMITS.tooltipLines ? `A styled tooltip has at most ${LIMITS.tooltipLines} lines — remove ${lines.length - LIMITS.tooltipLines} to apply.` : "";
    err.textContent = bad;
    apply.disabled = !!bad;
  };
  // One row per template field that can be formatted: a measure (number format + decimals) or a date group-by (date format).
  let fmtKey = null;
  const fmtSelect = (label, options, value, onChange) => {
    const s = el("select", "input tipdlg__fsel"); s.setAttribute("aria-label", label);
    for (const [v, t] of options) s.append(new Option(t, v));
    s.value = value; s.addEventListener("change", () => onChange(s.value)); return s;
  };
  const setFmt = (name, p) => {
    const next = { ...(formats[name] ?? {}), ...p };
    for (const k of Object.keys(next)) if (next[k] === "" || next[k] == null) delete next[k];
    if (Object.keys(next).length) formats = { ...formats, [name]: next }; else { formats = { ...formats }; delete formats[name]; }
    refresh();
  };
  const drawFormats = (used) => {
    const rows = [...new Set(used)].filter((n) => { const f = known.get(n); return f && (f.kind === "measure" || looksDate(f.sample)); });
    const key = rows.join("\u0000");
    if (key === fmtKey) return; // only rebuilt when the set of formattable fields changes (keeps focus in the controls)
    fmtKey = key;
    fmtBox.replaceChildren();
    fmtBox.hidden = !rows.length;
    if (rows.length) fmtBox.append(el("div", "tipdlg__head", "Field formats"));
    for (const n of rows) {
      const f = known.get(n), cur = formats[n] ?? {};
      const row = el("div", "tipdlg__fmt"); row.append(el("span", "tipdlg__fname", `<${n}>`));
      if (f.kind === "measure") {
        row.append(
          fmtSelect(`Number format for ${n}`, [["", "View format"], ...TIP_NUMBER_FORMATS.map((v) => [v, v[0].toUpperCase() + v.slice(1)])], cur.number ?? "", (v) => setFmt(n, { number: v || null })),
          fmtSelect(`Decimals for ${n}`, [["", "Decimals: auto"], ...Array.from({ length: MAX_DECIMALS + 1 }, (_, d) => [String(d), `Decimals: ${d}`])], cur.decimals == null ? "" : String(cur.decimals), (v) => setFmt(n, { decimals: v === "" ? null : Number(v) })));
      } else {
        const labels = { date: "Date", datetime: "Date and time", month: "Month", year: "Year" };
        row.append(fmtSelect(`Date format for ${n}`, [["", "View format"], ...TIP_DATE_FORMATS.map((v) => [v, labels[v]])], cur.date ?? "", (v) => setFmt(n, { date: v || null })));
      }
      fmtBox.append(row);
    }
  };
  const patch = (i, p) => { lines = lines.map((l, k) => (k === i ? { ...l, ...p } : l)); };

  const toggle = (label, ic, i, key) => {
    const b = el("button", "btn btn--ghost tipdlg__tog"); b.type = "button";
    b.textContent = ic; b.setAttribute("aria-label", `${label} (line ${i + 1})`); b.title = label;
    b.setAttribute("aria-pressed", String(!!lines[i][key]));
    b.addEventListener("click", () => { patch(i, { [key]: lines[i][key] ? undefined : true }); b.setAttribute("aria-pressed", String(!!lines[i][key])); refresh(); });
    return b;
  };
  const lineRow = (l, i) => {
    const row = el("div", "tipdlg__line"); row.setAttribute("role", "listitem");
    const input = el("input", "input tipdlg__text");
    input.type = "text"; input.autocomplete = "off"; input.value = l.text; input.dataset.line = String(i);
    input.setAttribute("aria-label", `Line ${i + 1} text`);
    input.placeholder = "Text and <field> tokens";
    input.addEventListener("focus", () => { active = i; });
    input.addEventListener("input", () => { patch(i, { text: input.value }); refresh(); });
    input.addEventListener("keydown", (e) => {
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { // keyboard reorder
        e.preventDefault();
        const d = e.key === "ArrowUp" ? -1 : 1, next = moveLine(lines, i, d);
        if (next !== lines) { lines = next; active = i + d; draw(`[data-line="${i + d}"]`); }
      }
    });
    const size = el("select", "input tipdlg__size"); size.setAttribute("aria-label", `Font size (line ${i + 1})`);
    size.append(new Option("Auto", ""), ...TIP_SIZES.map((s) => new Option(`${s}px`, String(s))));
    size.value = l.size ? String(l.size) : "";
    size.addEventListener("change", () => { patch(i, { size: size.value ? Number(size.value) : undefined }); refresh(); });
    const colour = el("select", "input tipdlg__colour"); colour.setAttribute("aria-label", `Colour (line ${i + 1})`);
    colour.append(new Option("Auto", ""), ...Object.keys(TIP_COLOURS).map((k) => new Option(TIP_COLOUR_LABELS[k], k)));
    colour.value = l.color ?? "";
    colour.addEventListener("change", () => { patch(i, { color: colour.value || undefined }); refresh(); });
    const mv = (label, glyph, d) => {
      const b = el("button", "btn btn--ghost tipdlg__mv", glyph); b.type = "button"; b.title = label; b.setAttribute("aria-label", `${label} (line ${i + 1})`);
      b.disabled = i + d < 0 || i + d >= lines.length; b.dataset.move = String(d);
      b.addEventListener("click", () => { lines = moveLine(lines, i, d); active = i + d; draw(`.tipdlg__line:nth-child(${i + d + 1}) [data-move="${d}"]`); });
      return b;
    };
    const del = el("button", "btn btn--ghost tipdlg__mv"); del.type = "button"; del.title = "Remove line"; del.setAttribute("aria-label", `Remove line ${i + 1}`);
    del.append(icon("close", { size: 14 })); del.disabled = lines.length <= 1;
    del.addEventListener("click", () => { lines = removeLine(lines, i); active = Math.min(active, lines.length - 1); draw(`[data-line="${Math.min(i, lines.length - 1)}"]`); });
    row.append(input, size, toggle("Bold", "B", i, "bold"), toggle("Italic", "I", i, "italic"), colour, mv("Move up", "↑", -1), mv("Move down", "↓", 1), del);
    row.classList.toggle("tipdlg__line--on", i === active);
    return row;
  };
  for (const f of fields ?? []) {
    const b = makeButton(f.name, "btn btn--ghost tipdlg__chip"); b.title = `Insert <${f.name}>`;
    b.addEventListener("click", () => {
      const inp = list.querySelector(`[data-line="${active}"]`);
      const a = inp?.selectionStart ?? lines[active].text.length, z = inp?.selectionEnd ?? a;
      const next = insertField(lines, active, f.name, a, z);
      if (next === lines) return;
      lines = next; draw(`[data-line="${active}"]`);
      const ni = list.querySelector(`[data-line="${active}"]`); const pos = a + f.name.length + 2; ni?.setSelectionRange(pos, pos);
    });
    chips.append(b);
  }
  if (!(fields ?? []).length) chips.append(el("span", "tipdlg__note", "Add fields to the view to insert them."));

  add.addEventListener("click", () => { lines = addLine(lines); active = lines.length - 1; draw(`[data-line="${active}"]`); });
  const finish = () => { closeDialog(dlg); setTimeout(() => onClose?.(), 0); };
  cancel.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); }); // Esc discards
  reset.addEventListener("click", () => { lines = [{ text: "" }]; formats = {}; fmtKey = null; active = 0; draw(`[data-line="0"]`); });
  apply.addEventListener("click", () => { if (apply.disabled) return; const r = fromLines(lines); onApply({ ...r, formats: r.text ? checkTooltipFormats(pruneFormats(formats, parseTooltip(r.text).fields)).value : null }); finish(); });
  document.body.append(dlg);
  openDialog(dlg);
  draw(`[data-line="0"]`);
}
