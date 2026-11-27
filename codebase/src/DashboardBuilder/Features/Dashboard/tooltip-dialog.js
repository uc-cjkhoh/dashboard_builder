// The "Edit tooltip" modal, laid out like Tableau's Edit Tooltip: a formatting toolbar (font, size, Bold / Italic / Underline, colour, alignment, Insert ▾, clear),
// one text editor, the behaviour checkboxes (Show tooltips with its mode, command buttons) and Reset / Preview / OK / Cancel.
// The editor is one contenteditable surface with a block per line, and the browser never edits it: every change (typing, Enter, paste, delete, cut, undo) arrives as a
// `beforeinput`, is applied to the model (tooltip-style.js `replaceRange`: text plus one style per line) and the surface is drawn again from the model, so there is no HTML
// to read back or to sanitise. The toolbar formats the lines the selection touches, not a run of characters.
// DOM only — the rules are in tooltip-style.js, tooltip-model.js and tooltip-behaviour-model.js. Everything is a draft until OK (one commit); Esc / Cancel discard.
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { LIMITS } from "../Core/validate.js";
import { tooltipHtml, parseTooltip } from "./tooltip-model.js";
import { TIP_NUMBER_FORMATS, TIP_DATE_FORMATS, checkTooltipFormats, pruneFormats, looksDate, sampleLookup } from "./tooltip-formats.js";
import { MAX_DECIMALS } from "../Core/sheet-schema.js";
import { TIP_SIZES, TIP_COLOURS, TIP_COLOUR_LABELS, TIP_FONTS, lineStyleCss, toLines, fromLines, moveLine, replaceRange, patchLines, orderRange, wordStart, wordEnd } from "./tooltip-style.js";
import { tooltipControlSpecs, withTooltipSetting } from "./tooltip-behaviour-model.js";

let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };
const STYLE_KEYS = ["font", "size", "bold", "italic", "underline", "align", "color"];
const SHOWN_LABEL = { showTooltips: "Show tooltips", tooltipButtons: "Include command buttons" }; // the spec's own labels are the Format panel's; here the checkboxes read like Tableau's
const HISTORY = 100; // undo steps kept

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
  const end = { line: lines.length - 1, off: lines.at(-1).text.length };
  let sel = { start: end, end };                            // the selection, as { line, off } positions in the model: what the toolbar formats and Insert writes over
  const past = [], future = [];                             // undo / redo: [{ lines, sel }]
  const dropped = new Set();                                // indexes of Tooltip-card fields removed in this draft
  const fields = () => (typeof getFields === "function" ? getFields() : []) ?? [];

  const dlg = el("dialog", "dialog tipdlg tipdlg--rich");
  const title = el("h3", "dialog__title", "Edit tooltip"); title.id = `tipdlg-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body tipdlg__body");

  // --- toolbar ---------------------------------------------------------------------------------------------------------------
  const bar = el("div", "tipdlg__bar"); bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Format the selected lines");
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
  const flag = (key, label, glyph, cls) => { const b = toggle(label, glyph, () => toggleFlag(key)); b.classList.add(cls); return b; };
  const bold = flag("bold", "Bold", "B", "tipdlg__tog--b"), italic = flag("italic", "Italic", "I", "tipdlg__tog--i"), underline = flag("underline", "Underline", "U", "tipdlg__tog--u");
  const styleGroup = el("div", "tipdlg__group"); styleGroup.setAttribute("role", "group"); styleGroup.setAttribute("aria-label", "Text style"); styleGroup.append(bold, italic, underline);
  const colour = select("Colour", [["", "Auto colour"], ...Object.keys(TIP_COLOURS).map((k) => [k, TIP_COLOUR_LABELS[k]])], (v) => patch({ color: v || undefined }));
  const aligns = ["left", "center", "right"].map((a) => { const b = toggle(`Align ${a}`, icon(`align-${a}`, { size: 16 }), () => patch({ align: a === "left" ? undefined : a })); b.dataset.align = a; return b; });
  const alignGroup = el("div", "tipdlg__group"); alignGroup.setAttribute("role", "group"); alignGroup.setAttribute("aria-label", "Alignment"); alignGroup.append(...aligns);
  // Insert ▾: the drawn chart's fields, read when the menu opens
  const insertWrap = el("div", "tipdlg__insert");
  const insertBtn = el("button", "btn tipdlg__insertbtn"); insertBtn.type = "button";
  insertBtn.append(el("span", null, "Insert"), icon("chevron", { size: 16 })); insertBtn.setAttribute("aria-haspopup", "menu"); insertBtn.setAttribute("aria-expanded", "false");
  const menu = el("div", "menu__list menu__list--start tipdlg__menu"); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Insert a field"); menu.hidden = true;
  insertWrap.append(insertBtn, menu);
  const clear = el("button", "btn btn--ghost tipdlg__tog"); clear.type = "button"; clear.title = "Clear formatting"; clear.setAttribute("aria-label", "Clear formatting of the selected lines"); clear.append(icon("clear-format", { size: 16 }));
  clear.addEventListener("click", () => patch(Object.fromEntries(STYLE_KEYS.map((k) => [k, undefined]))));
  bar.append(font, size, styleGroup, colour, alignGroup, insertWrap, clear);

  // --- the text editor -----------------------------------------------------------------------------------------------------------
  const doc = el("div", "tipdlg__doc");
  doc.contentEditable = "true"; doc.spellcheck = false;
  doc.setAttribute("role", "textbox"); doc.setAttribute("aria-multiline", "true"); doc.setAttribute("aria-label", "Tooltip text");
  doc.dataset.placeholder = "Text and <field> tokens — empty keeps the automatic tooltip";
  const tools = el("div", "tipdlg__tools");
  const count = el("span", "tipdlg__count");
  tools.append(count);
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

  // --- the model <-> the surface -------------------------------------------------------------------------------------------------------
  const known = () => new Map(fields().map((f) => [f.name, f]));
  const sample = () => sampleLookup(fields(), checkTooltipFormats(formats).value, format);
  const totalLen = () => lines.map((l) => l.text).join("\n").length;
  const lineEls = () => [...doc.children];
  const lineEl = (l, i) => { // a block per line, drawn in its own format (whitelisted values only); an empty one holds a <br> so it keeps its height
    const d = el("div"); d.dataset.line = String(i); d.style.cssText = lineStyleCss(l);
    if (l.text) d.textContent = l.text; else d.append(document.createElement("br"));
    return d;
  };
  const render = () => { doc.replaceChildren(...lines.map(lineEl)); afterChange(); };
  const styleAll = () => { lineEls().forEach((d, i) => { if (lines[i]) d.style.cssText = lineStyleCss(lines[i]); }); afterChange(); };
  const afterChange = () => { doc.toggleAttribute("data-empty", lines.length === 1 && !lines[0].text); syncBar(); refresh(); };

  // positions: a DOM point -> { line, off }, and back
  const lineOf = (node) => { let x = node; while (x && x.parentNode !== doc) x = x.parentNode; return x ? lineEls().indexOf(x) : -1; };
  const posOf = (node, offset) => {
    if (node === doc) return offset >= lines.length ? { line: lines.length - 1, off: lines.at(-1).text.length } : { line: Math.max(0, offset), off: 0 };
    const line = lineOf(node);
    if (line < 0) return null;
    const r = document.createRange(); r.setStart(lineEls()[line], 0); r.setEnd(node, offset);
    return { line, off: Math.min(r.toString().length, lines[line].text.length) };
  };
  const readSel = () => {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !doc.contains(s.anchorNode) || !doc.contains(s.focusNode)) return null;
    const a = posOf(s.anchorNode, s.anchorOffset), z = posOf(s.focusNode, s.focusOffset);
    return a && z ? (() => { const o = orderRange(a, z); return { start: o.a, end: o.z }; })() : null;
  };
  const domPoint = ({ line, off }) => { const d = lineEls()[Math.min(line, lines.length - 1)], t = d?.firstChild; return t && t.nodeType === 3 ? [t, Math.min(off, t.length)] : [d, 0]; };
  const setSel = (start, endPos = start, focus = true) => {
    sel = { start, end: endPos };
    if (!doc.isConnected) return;
    if (focus) doc.focus({ preventScroll: true });
    const [sn, so] = domPoint(start), [en, eo] = domPoint(endPos), r = document.createRange();
    r.setStart(sn, so); r.setEnd(en, eo);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    syncBar();
  };

  // history: every change to the model is one undo step
  const push = () => { past.push({ lines, sel }); if (past.length > HISTORY) past.shift(); future.length = 0; };
  const restore = (from, to) => { if (!from.length) return; to.push({ lines, sel }); ({ lines, sel } = from.pop()); render(); setSel(sel.start, sel.end); };
  const edit = (a, z, text) => { push(); const r = replaceRange(lines, a, z, text); lines = r.lines; render(); setSel(r.caret); };
  const current = () => { const s = readSel(); if (s) sel = s; return sel; } // the selection as it is now: `selectionchange` is queued, so the saved one can trail a click or key that came just before
  const patch = (p) => { current(); push(); lines = patchLines(lines, sel.start.line, sel.end.line, p); styleAll(); setSel(sel.start, sel.end); };
  const toggleFlag = (key) => patch({ [key]: lines[current().start.line][key] ? undefined : true });

  const syncBar = () => {
    const l = lines[Math.min(sel.start.line, lines.length - 1)] ?? { text: "" };
    font.value = l.font ?? ""; size.value = l.size ? String(l.size) : ""; colour.value = l.color ?? "";
    for (const [b, k] of [[bold, "bold"], [italic, "italic"], [underline, "underline"]]) b.setAttribute("aria-pressed", String(!!l[k]));
    for (const b of aligns) b.setAttribute("aria-pressed", String(b.dataset.align === (l.align ?? "left")));
    clear.disabled = !lines.slice(sel.start.line, sel.end.line + 1).some((x) => STYLE_KEYS.some((k) => x[k] != null));
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

  // The browser's own edits are cancelled and done on the model. Input methods (composition) are the one exception: the browser edits the line, `input` reads it back.
  const readDom = () => {
    const divs = lineEls();
    lines = divs.length === lines.length
      ? lines.map((l, i) => ({ ...l, text: divs[i].textContent }))
      : divs.map((d, i) => ({ ...(lines[Math.min(i, lines.length - 1)]), text: d.textContent })); // a structure the browser changed: its blocks are the lines, the styles follow by index
    if (!lines.length) lines = [{ text: "" }];
    const s = readSel(); if (s) sel = s;
    afterChange();
  };
  doc.addEventListener("beforeinput", (e) => {
    const t = e.inputType;
    if (e.isComposing || /Composition/.test(t)) return;
    e.preventDefault();
    current();
    let a = sel.start, z = sel.end, text = "";
    const collapsed = a.line === z.line && a.off === z.off;
    const dir = /Backward$/.test(t) ? -1 : /Forward$/.test(t) ? 1 : 0;
    if (t === "historyUndo") return restore(past, future);
    if (t === "historyRedo") return restore(future, past);
    if (t === "formatBold") return toggleFlag("bold");
    if (t === "formatItalic") return toggleFlag("italic");
    if (t === "formatUnderline") return toggleFlag("underline");
    if (t === "insertText" || t === "insertReplacementText") text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
    else if (t === "insertFromPaste" || t === "insertFromDrop" || t === "insertFromYank") text = e.dataTransfer?.getData("text/plain") ?? e.data ?? "";
    else if (t === "insertParagraph" || t === "insertLineBreak") text = "\n";
    else if (t.startsWith("delete")) {
      if (collapsed && dir) { // one character, a word, or to the end of the line; at a line's edge, the line break
        const { line, off } = a, txt = lines[line].text, word = /Word/.test(t), whole = /Line/.test(t);
        if (dir < 0) {
          if (off > 0) a = { line, off: whole ? 0 : word ? wordStart(txt, off) : off - 1 };
          else if (line > 0) a = { line: line - 1, off: lines[line - 1].text.length };
          else return;
        } else if (off < txt.length) z = { line, off: whole ? txt.length : word ? wordEnd(txt, off) : off + 1 };
        else if (line < lines.length - 1) z = { line: line + 1, off: 0 };
        else return;
      } else if (collapsed) return;
    } else return;
    edit(a, z, text);
  });
  doc.addEventListener("input", readDom); // only reached for what beforeinput let through (composition)
  doc.addEventListener("compositionend", readDom);
  doc.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === "z") { e.preventDefault(); restore(e.shiftKey ? future : past, e.shiftKey ? past : future); }
    else if (mod && k === "y") { e.preventDefault(); restore(future, past); }
    else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { // keyboard reorder of the caret's line (its style travels with it)
      e.preventDefault();
      const i = current().start.line, d = e.key === "ArrowUp" ? -1 : 1, next = moveLine(lines, i, d);
      if (next === lines) return;
      push(); lines = next; render();
      const c = { line: i + d, off: Math.min(sel.start.off, lines[i + d].text.length) };
      setSel(c);
    }
  });
  const onSel = () => { const s = readSel(); if (s) { sel = s; syncBar(); } }; // the toolbar and Insert keep the last selection made in the editor
  document.addEventListener("selectionchange", onSel);

  // --- Insert menu --------------------------------------------------------------------------------------------------------------
  const closeMenu = () => { menu.hidden = true; insertBtn.setAttribute("aria-expanded", "false"); };
  const openMenu = () => {
    menu.replaceChildren();
    const list = fields();
    for (const f of list) {
      const b = el("button", "menu__item tipdlg__item"); b.type = "button"; b.setAttribute("role", "menuitem"); b.title = `Insert <${f.name}>`; b.append(el("span", "menu__label", f.name));
      b.addEventListener("click", () => { closeMenu(); current(); edit(sel.start, sel.end, `<${f.name}>`); }); // over the selection, or at the caret
      menu.append(b);
    }
    if (!list.length) menu.append(el("span", "tipdlg__note", "Add fields to the view to insert them."));
    menu.hidden = false; insertBtn.setAttribute("aria-expanded", "true");
    const wrap = insertWrap.getBoundingClientRect(), room = bar.getBoundingClientRect(); // starts under the button, shifted left only as far as keeps the list within the toolbar's width, the body's content edges (the toolbar wraps, so the button can be anywhere in a row)
    menu.style.left = `${Math.max(room.left, Math.min(wrap.left, room.right - menu.offsetWidth)) - wrap.left}px`;
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

  previewBtn.addEventListener("click", () => { preview.hidden = !preview.hidden; previewBtn.setAttribute("aria-pressed", String(!preview.hidden)); });
  const finish = () => { document.removeEventListener("selectionchange", onSel); closeDialog(dlg); setTimeout(() => onClose?.(), 0); };
  cancel.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (!menu.hidden) { closeMenu(); insertBtn.focus(); return; } finish(); }); // Esc closes the open menu first, then discards
  reset.addEventListener("click", () => {
    push(); lines = [{ text: "" }]; formats = {}; fmtKey = null;
    for (const [k, v] of [["showTooltips", true], ["tooltipButtons", false], ["tooltipMode", "responsive"]]) format = withTooltipSetting(format, k, v);
    drawBehaviour(); render(); setSel({ line: 0, off: 0 });
  });
  ok.addEventListener("click", () => {
    if (ok.disabled) return;
    const r = fromLines(lines);
    onApply({ ...r, formats: r.text ? checkTooltipFormats(pruneFormats(formats, parseTooltip(r.text).fields)).value : null, format, dropMarkFields: [...dropped].sort((a, b) => a - b) });
    finish();
  });
  document.body.append(dlg);
  openDialog(dlg);
  drawBehaviour(); drawCard(); render(); setSel(end);
}
