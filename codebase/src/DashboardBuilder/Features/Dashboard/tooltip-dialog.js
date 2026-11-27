// The "Edit tooltip" modal, laid out like Tableau's Edit Tooltip: a formatting toolbar (font, size, Bold / Italic / Underline, colour, alignment, Insert ▾, clear),
// the tooltip's lines in one editor surface, the behaviour checkboxes (Show tooltips with its mode, command buttons) and Reset / Preview / OK / Cancel.
// The stored model stays text with <Field> tokens plus one style per line (tooltip-style.js), so the toolbar formats the line the caret is in — not a run of characters.
// DOM only — the rules are in tooltip-style.js, tooltip-model.js and tooltip-behaviour-model.js. Everything is a draft until OK (one commit); Esc / Cancel discard.
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { LIMITS } from "../Core/validate.js";
import { tooltipHtml, parseTooltip } from "./tooltip-model.js";
import { TIP_NUMBER_FORMATS, TIP_DATE_FORMATS, checkTooltipFormats, pruneFormats, looksDate, sampleLookup } from "./tooltip-formats.js";
import { MAX_DECIMALS } from "../Core/sheet-schema.js";
import { TIP_SIZES, TIP_COLOURS, TIP_COLOUR_LABELS, TIP_FONTS, lineStyleCss, toLines, fromLines, moveLine, addLine, removeLine, insertField } from "./tooltip-style.js";
import { tooltipControlSpecs, withTooltipSetting } from "./tooltip-behaviour-model.js";

let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };
const STYLE_KEYS = ["font", "size", "bold", "italic", "underline", "align", "color"];
const SHOWN_LABEL = { showTooltips: "Show tooltips", tooltipButtons: "Include command buttons" }; // the spec's own labels are the Format panel's; here the checkboxes read like Tableau's

/** `text` / `style` / `formats`: the sheet's tooltipText / tooltipStyle / tooltipFormats; `format`: the sheet's Format config (the behaviour settings and a field format start from it);
 *  `getFields()`: [{ name, sample, kind }] the drawn chart offers — read each time the Insert menu opens, because the chart can finish drawing after this opens;
 *  `behaviour`: { type, gate, note } for tooltipControlSpecs (the chart type, and why command buttons would do nothing); `markFields`: the names of the fields held on the Tooltip card (each can be removed);
 *  `onClose()` runs after the dialog closes (focus return); `onApply({ text, style, formats, format, dropMarkFields })` receives the validated result
 *  ({ text: "", style: null, formats: null } = the automatic tooltip; `format`: the whole next Format; `dropMarkFields`: indexes into `markFields`). */
export function openTooltipDialog({ text, style, formats: formats0, format: format0, getFields, behaviour, markFields = [], onApply, onClose }) {
  const n = ++seq;
  let lines = toLines(text, style);
  let formats = formats0 ? structuredClone(formats0) : {}; // draft per-field formats { name: { number?, decimals?, date? } }
  let format = { ...(format0 ?? {}) };                     // draft Format (only the tooltip behaviour keys change here)
  let active = 0;                                           // the line the toolbar formats and Insert writes into
  const dropped = new Set();                                // indexes of Tooltip-card fields removed in this draft
  const fields = () => (typeof getFields === "function" ? getFields() : []) ?? [];

  const dlg = el("dialog", "dialog tipdlg tipdlg--rich");
  const title = el("h3", "dialog__title", "Edit tooltip"); title.id = `tipdlg-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body tipdlg__body");

  // --- toolbar ---------------------------------------------------------------------------------------------------------------
  const bar = el("div", "tipdlg__bar"); bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Format the selected line");
  const select = (label, options, onChange) => {
    const s = el("select", "input tipdlg__sel"); s.setAttribute("aria-label", label);
    for (const [v, t] of options) s.append(new Option(t, v));
    s.addEventListener("change", () => onChange(s.value)); return s;
  };
  const toggle = (label, glyph, onClick) => {
    const b = el("button", "btn btn--ghost tipdlg__tog"); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.setAttribute("aria-pressed", "false");
    if (typeof glyph === "string") b.textContent = glyph; else b.append(glyph);
    b.addEventListener("click", onClick); return b;
  };
  const font = select("Font", [["", "Default font"], ...TIP_FONTS], (v) => patch({ font: v || undefined }));
  const size = select("Font size", [["", "Auto"], ...TIP_SIZES.map((s) => [String(s), `${s}px`])], (v) => patch({ size: v ? Number(v) : undefined }));
  const flag = (key, label, glyph, cls) => { const b = toggle(label, glyph, () => patch({ [key]: lines[active][key] ? undefined : true })); b.classList.add(cls); return b; };
  const bold = flag("bold", "Bold", "B", "tipdlg__tog--b"), italic = flag("italic", "Italic", "I", "tipdlg__tog--i"), underline = flag("underline", "Underline", "U", "tipdlg__tog--u");
  const colour = select("Colour", [["", "Auto colour"], ...Object.keys(TIP_COLOURS).map((k) => [k, TIP_COLOUR_LABELS[k]])], (v) => patch({ color: v || undefined }));
  const aligns = ["left", "center", "right"].map((a) => { const b = toggle(`Align ${a}`, icon(`align-${a}`, { size: 16 }), () => patch({ align: a === "left" ? undefined : a })); b.dataset.align = a; return b; });
  const alignGroup = el("div", "tipdlg__group"); alignGroup.setAttribute("role", "group"); alignGroup.setAttribute("aria-label", "Alignment"); alignGroup.append(...aligns);
  // Insert ▾: the drawn chart's fields, read when the menu opens
  const insertWrap = el("div", "tipdlg__insert");
  const insertBtn = el("button", "btn tipdlg__insertbtn"); insertBtn.type = "button";
  insertBtn.append(el("span", null, "Insert"), icon("chevron", { size: 16 })); insertBtn.setAttribute("aria-haspopup", "menu"); insertBtn.setAttribute("aria-expanded", "false");
  const menu = el("div", "tipdlg__menu"); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Insert a field"); menu.hidden = true;
  insertWrap.append(insertBtn, menu);
  const clear = el("button", "btn btn--ghost tipdlg__tog"); clear.type = "button"; clear.title = "Clear formatting"; clear.setAttribute("aria-label", "Clear formatting of the selected line"); clear.append(icon("close", { size: 16 }));
  clear.addEventListener("click", () => patch(Object.fromEntries(STYLE_KEYS.map((k) => [k, undefined]))));
  bar.append(font, size, bold, italic, underline, colour, alignGroup, insertWrap, clear);

  // --- editor surface ------------------------------------------------------------------------------------------------------------
  const doc = el("div", "tipdlg__doc"); doc.setAttribute("role", "list"); doc.setAttribute("aria-label", "Tooltip lines");
  const tools = el("div", "tipdlg__tools");
  const add = makeButton("Add line", "btn btn--ghost tipdlg__add");
  const count = el("span", "tipdlg__count");
  tools.append(add, count);
  const err = el("div", "tipdlg__error"); err.setAttribute("role", "alert");

  // --- behaviour ---------------------------------------------------------------------------------------------------------------
  const behav = el("div", "tipdlg__behaviour"); behav.setAttribute("role", "group"); behav.setAttribute("aria-label", "Tooltip behaviour");

  // --- more: field formats, tooltip-card fields ------------------------------------------------------------------------------
  const fmtBox = el("details", "tipdlg__more tipdlg__formats");
  const fmtSum = el("summary"); fmtSum.append(icon("chevron", { size: 14 }), el("span", null, "Field formats"));
  const fmtBody = el("div", "tipdlg__morebody"); fmtBody.setAttribute("role", "group"); fmtBody.setAttribute("aria-label", "Field formats");
  fmtBox.append(fmtSum, fmtBody);
  const cardBox = el("details", "tipdlg__more tipdlg__cardfields");
  const cardSum = el("summary"); cardSum.append(icon("chevron", { size: 14 }), el("span", null, "Fields on the Tooltip card"));
  const cardBody = el("div", "tipdlg__morebody");
  cardBox.append(cardSum, cardBody);

  const preview = el("div", "tipdlg__preview"); preview.setAttribute("aria-label", "Tooltip preview"); preview.hidden = true;
  body.append(bar, doc, tools, err, behav, fmtBox, cardBox, preview);

  const foot = el("div", "dialog__foot");
  const reset = makeButton("Reset", "btn tipdlg__reset"), previewBtn = makeButton("Preview", "btn"), cancel = makeButton("Cancel", "btn"), ok = makeButton("OK", "btn btn--primary");
  reset.title = "Back to the automatic tooltip and the default behaviour";
  previewBtn.setAttribute("aria-pressed", "false"); previewBtn.setAttribute("aria-controls", `tipdlg-preview-${n}`); preview.id = `tipdlg-preview-${n}`;
  foot.append(reset, previewBtn, cancel, ok);
  dlg.append(title, body, foot);

  // --- state ------------------------------------------------------------------------------------------------------------------------
  const known = () => new Map(fields().map((f) => [f.name, f]));
  const sample = () => sampleLookup(fields(), checkTooltipFormats(formats).value, format);
  const totalLen = () => lines.map((l) => l.text).join("\n").length;
  const patch = (p) => { lines = lines.map((l, k) => (k === active ? { ...l, ...p } : l)); syncBar(); styleRow(active); refresh(); };

  const syncBar = () => {
    const l = lines[active] ?? { text: "" };
    font.value = l.font ?? ""; size.value = l.size ? String(l.size) : ""; colour.value = l.color ?? "";
    for (const [b, k] of [[bold, "bold"], [italic, "italic"], [underline, "underline"]]) b.setAttribute("aria-pressed", String(!!l[k]));
    for (const b of aligns) b.setAttribute("aria-pressed", String(b.dataset.align === (l.align ?? "left")));
    clear.disabled = !STYLE_KEYS.some((k) => l[k] != null);
  };
  const styleRow = (i) => { const input = doc.querySelector(`[data-line="${i}"]`); if (input) input.style.cssText = lineStyleCss(lines[i]); }; // the line shows its own format (whitelisted values only)
  const draw = (focusSel) => {
    doc.replaceChildren();
    lines.forEach((l, i) => doc.append(lineRow(l, i)));
    add.disabled = lines.length >= LIMITS.tooltipLines;
    syncBar(); refresh();
    if (focusSel) doc.querySelector(focusSel)?.focus();
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
    ok.disabled = !!bad;
  };

  // One line: its text, and the ↑ ↓ ✕ that reorder or remove it.
  const lineRow = (l, i) => {
    const row = el("div", "tipdlg__line"); row.setAttribute("role", "listitem");
    const input = el("input", "input tipdlg__text");
    input.type = "text"; input.autocomplete = "off"; input.value = l.text; input.dataset.line = String(i);
    input.setAttribute("aria-label", `Line ${i + 1} text`);
    input.placeholder = i === 0 ? "Text and <field> tokens — empty keeps the automatic tooltip" : "Text and <field> tokens";
    input.style.cssText = lineStyleCss(l);
    input.addEventListener("focus", () => { active = i; syncBar(); for (const r of doc.children) r.classList.toggle("tipdlg__line--on", r === row); });
    input.addEventListener("input", () => { lines = lines.map((x, k) => (k === i ? { ...x, text: input.value } : x)); refresh(); });
    input.addEventListener("keydown", (e) => {
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { // keyboard reorder
        e.preventDefault();
        const d = e.key === "ArrowUp" ? -1 : 1, next = moveLine(lines, i, d);
        if (next !== lines) { lines = next; active = i + d; draw(`[data-line="${i + d}"]`); }
      } else if (e.key === "Enter" && lines.length < LIMITS.tooltipLines) { // a new line below, as in any editor
        e.preventDefault();
        lines = addLine(lines, i + 1); active = i + 1; draw(`[data-line="${i + 1}"]`);
      } else if (e.key === "Backspace" && !input.value && lines.length > 1) { // an empty line goes, the caret to the one above
        e.preventDefault();
        lines = removeLine(lines, i); active = Math.max(0, i - 1); draw(`[data-line="${active}"]`);
      }
    });
    const mv = (label, glyph, d) => {
      const b = el("button", "btn btn--ghost tipdlg__mv"); b.type = "button"; b.title = label; b.setAttribute("aria-label", `${label} (line ${i + 1})`);
      b.append(icon(glyph, { size: 14 }));
      b.disabled = i + d < 0 || i + d >= lines.length; b.dataset.move = String(d);
      b.addEventListener("click", () => { lines = moveLine(lines, i, d); active = i + d; draw(`.tipdlg__line:nth-child(${i + d + 1}) [data-move="${d}"]`); });
      return b;
    };
    const del = el("button", "btn btn--ghost tipdlg__mv"); del.type = "button"; del.title = "Remove line"; del.setAttribute("aria-label", `Remove line ${i + 1}`);
    del.append(icon("close", { size: 14 })); del.disabled = lines.length <= 1;
    del.addEventListener("click", () => { lines = removeLine(lines, i); active = Math.min(active, lines.length - 1); draw(`[data-line="${Math.min(i, lines.length - 1)}"]`); });
    row.append(input, mv("Move up", "chevron-up", -1), mv("Move down", "chevron", 1), del);
    row.classList.toggle("tipdlg__line--on", i === active);
    return row;
  };

  // --- Insert menu --------------------------------------------------------------------------------------------------------------
  const closeMenu = () => { menu.hidden = true; insertBtn.setAttribute("aria-expanded", "false"); };
  const openMenu = () => {
    menu.replaceChildren();
    const list = fields();
    for (const f of list) {
      const b = el("button", "tipdlg__item", f.name); b.type = "button"; b.setAttribute("role", "menuitem"); b.title = `Insert <${f.name}>`;
      b.addEventListener("click", () => {
        closeMenu();
        const inp = doc.querySelector(`[data-line="${active}"]`);
        const a = inp?.selectionStart ?? lines[active].text.length, z = inp?.selectionEnd ?? a;
        const next = insertField(lines, active, f.name, a, z);
        if (next === lines) return;
        lines = next; draw(`[data-line="${active}"]`);
        const pos = a + f.name.length + 2; doc.querySelector(`[data-line="${active}"]`)?.setSelectionRange(pos, pos);
      });
      menu.append(b);
    }
    if (!list.length) menu.append(el("span", "tipdlg__note", "Add fields to the view to insert them."));
    menu.hidden = false; insertBtn.setAttribute("aria-expanded", "true");
    menu.querySelector("button")?.focus();
  };
  insertBtn.addEventListener("click", () => { if (menu.hidden) openMenu(); else closeMenu(); });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button")], at = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
  });
  dlg.addEventListener("pointerdown", (e) => { if (!menu.hidden && !insertWrap.contains(e.target)) closeMenu(); });

  // --- behaviour (Show tooltips + mode, command buttons): the Format panel's rules (tooltip-behaviour-model.js), read off the draft ------------------------
  const drawBehaviour = () => {
    behav.replaceChildren();
    const specs = behaviour ? tooltipControlSpecs({ type: behaviour.type, format, gate: behaviour.gate ?? null, note: behaviour.note ?? null }) : [];
    behav.hidden = !specs.length;
    const set = (key, v) => { format = withTooltipSetting(format, key, v); drawBehaviour(); };
    const note = (c, ...nodes) => { const why = c.disabled ?? c.note; if (why) for (const x of nodes) { x.title = why; x.setAttribute("aria-description", why); } };
    const check = (c) => {
      const lab = el("label", "tipdlg__check"), box = el("input"); box.type = "checkbox"; box.checked = !!c.value; box.disabled = !!c.disabled;
      box.addEventListener("change", () => set(c.key, box.checked));
      lab.append(box, el("span", null, SHOWN_LABEL[c.key] ?? c.label)); note(c, box, lab);
      return lab;
    };
    for (const c of specs) {
      if (c.kind === "check") {
        const row = el("div", "tipdlg__brow"); row.append(check(c));
        if (c.key === "showTooltips") { // the mode sits beside Show tooltips, as in Tableau's dialog
          const m = specs.find((x) => x.key === "tooltipMode");
          if (m) { const s = select(m.label, m.choices, (v) => set("tooltipMode", v)); s.value = m.value; s.disabled = !!m.disabled; s.classList.add("tipdlg__mode"); note(m, s); row.append(s); }
        }
        behav.append(row);
      }
    }
  };

  // --- field formats ---------------------------------------------------------------------------------------------------------------
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
    const byName = known();
    const rows = [...new Set(used)].filter((nm) => { const f = byName.get(nm); return f && (f.kind === "measure" || looksDate(f.sample)); });
    const key = rows.join("\u0000");
    if (key === fmtKey) return; // only rebuilt when the set of formattable fields changes (keeps focus in the controls)
    fmtKey = key;
    fmtBody.replaceChildren();
    fmtBox.hidden = !rows.length;
    for (const nm of rows) {
      const f = byName.get(nm), cur = formats[nm] ?? {};
      const row = el("div", "tipdlg__fmt"); row.append(el("span", "tipdlg__fname", `<${nm}>`));
      if (f.kind === "measure") {
        row.append(
          fmtSelect(`Number format for ${nm}`, [["", "View format"], ...TIP_NUMBER_FORMATS.map((v) => [v, v[0].toUpperCase() + v.slice(1)])], cur.number ?? "", (v) => setFmt(nm, { number: v || null })),
          fmtSelect(`Decimals for ${nm}`, [["", "Decimals: auto"], ...Array.from({ length: MAX_DECIMALS + 1 }, (_, d) => [String(d), `Decimals: ${d}`])], cur.decimals == null ? "" : String(cur.decimals), (v) => setFmt(nm, { decimals: v === "" ? null : Number(v) })));
      } else {
        const labels = { date: "Date", datetime: "Date and time", month: "Month", year: "Year" };
        row.append(fmtSelect(`Date format for ${nm}`, [["", "View format"], ...TIP_DATE_FORMATS.map((v) => [v, labels[v]])], cur.date ?? "", (v) => setFmt(nm, { date: v || null })));
      }
      fmtBody.append(row);
    }
  };

  // --- the fields held on the Tooltip card: each can be removed (the card's drop target no longer lists them) ---------------------------------------
  const drawCard = () => {
    cardBody.replaceChildren();
    const left = markFields.map((name, i) => [name, i]).filter(([, i]) => !dropped.has(i));
    cardBox.hidden = !left.length;
    for (const [name, i] of left) {
      const row = el("div", "tipdlg__cardrow"); row.append(el("span", "tipdlg__fname", name));
      const rm = el("button", "btn btn--ghost tipdlg__mv"); rm.type = "button"; rm.title = `Remove ${name}`; rm.setAttribute("aria-label", `Remove ${name} from the Tooltip card`); rm.append(icon("close", { size: 14 }));
      rm.addEventListener("click", () => { dropped.add(i); drawCard(); cardBox.querySelector("button")?.focus(); });
      row.append(rm); cardBody.append(row);
    }
  };

  add.addEventListener("click", () => { lines = addLine(lines); active = lines.length - 1; draw(`[data-line="${active}"]`); });
  previewBtn.addEventListener("click", () => { preview.hidden = !preview.hidden; previewBtn.setAttribute("aria-pressed", String(!preview.hidden)); });
  const finish = () => { closeDialog(dlg); setTimeout(() => onClose?.(), 0); };
  cancel.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (!menu.hidden) { closeMenu(); insertBtn.focus(); return; } finish(); }); // Esc closes the open menu first, then discards
  reset.addEventListener("click", () => {
    lines = [{ text: "" }]; formats = {}; fmtKey = null; active = 0;
    for (const [k, v] of [["showTooltips", true], ["tooltipButtons", false], ["tooltipMode", "responsive"]]) format = withTooltipSetting(format, k, v);
    drawBehaviour(); draw(`[data-line="0"]`);
  });
  ok.addEventListener("click", () => {
    if (ok.disabled) return;
    const r = fromLines(lines);
    onApply({ ...r, formats: r.text ? checkTooltipFormats(pruneFormats(formats, parseTooltip(r.text).fields)).value : null, format, dropMarkFields: [...dropped].sort((a, b) => a - b) });
    finish();
  });
  document.body.append(dlg);
  openDialog(dlg);
  drawBehaviour(); drawCard(); draw(`[data-line="0"]`);
}
