// Calculated fields — the New / Edit dialog (built to docs/proposals/calculation-dialog-mockup.html).
// All validation, the role chip and the autocomplete items come from calc-dialog-model.js; this file is DOM only.
import { calculations, entities, parameters, addCalculation, updateCalculation } from "../Core/store.js";
import { icon } from "../Core/icons.js";
import { LIMITS } from "../Core/validate.js";
import { makeButton, openDialog, closeDialog, toast, confirmDialog } from "../Core/ui.js";
import { catalogFromEntities } from "./calc-resolve.js";
import { evaluateDraft, chipFor, suggest, isDirty, columnClash } from "./calc-dialog-model.js";
import { searchHelp, groupHelp } from "./function-help.js";
import { normaliseFormula, showUseAs, useAsRole, roleChoice, setRoleChoice, paneState } from "./calc-pane-model.js";

const TYPE_WORD = { numeric: "number", text: "text", temporal: "date", boolean: "boolean" };
let seq = 0;

/** Opens the dialog for calculation `calcId`, or a new one when `calcId` is null. Resolves nothing; saving writes the store. */
export function openCalcDialog(calcId = null) {
  const existing = calcId ? calculations.find((c) => c.id === calcId) : null;
  if (calcId && !existing) return;
  const n = ++seq;
  const catalog = catalogFromEntities([...entities.values()]);
  const ctx = { calcs: calculations, catalog, params: parameters, selfId: existing?.id };

  // Kind text for the autocomplete rows ("field · number", "calculation · aggregate").
  const kinds = new Map();
  for (const f of catalog.fields) {
    const ambiguous = (catalog.tablesByName.get(f.table) ?? []).length > 1;
    kinds.set(ambiguous ? `${f.db}.${f.table}.${f.column}` : `${f.table}.${f.column}`, `field · ${TYPE_WORD[f.category] ?? f.category}`);
  }
  for (const it of paneState(calculations, catalog, parameters).items)
    if (it.info) kinds.set(it.calc.name, `calculation · ${it.info.isAggregate ? "aggregate" : "row-level"}`);

  const dlg = el("dialog", "dialog calc-dialog");
  const title = el("h3", "dialog__title", existing ? "Edit calculated field" : "New calculated field");
  title.id = `calc-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body calc-dialog__body");

  const nameField = el("div", "field");
  const nameLabel = el("label", null, "Name"); nameLabel.htmlFor = `calc-name-${n}`;
  const name = el("input", "input"); name.id = nameLabel.htmlFor; name.type = "text"; name.autocomplete = "off";
  name.placeholder = "Unit price"; name.maxLength = LIMITS.calcName; name.value = existing?.name ?? "";
  const nameMsg = el("div"); nameMsg.id = `calc-nmsg-${n}`; nameMsg.setAttribute("role", "alert");
  name.setAttribute("aria-describedby", nameMsg.id);
  nameField.append(nameLabel, name, nameMsg);

  // Formula + autocomplete
  const formulaField = el("div", "field");
  const fLabel = el("label", null, "Formula"); fLabel.htmlFor = `calc-formula-${n}`;
  const wrap = el("div", "formula-wrap");
  const ta = el("textarea", "formula"); ta.id = fLabel.htmlFor; ta.spellcheck = false;
  ta.placeholder = "SUM([orders.amount]) / SUM([orders.qty])"; ta.value = existing?.formula ?? "";
  ta.setAttribute("role", "combobox");
  ta.setAttribute("aria-autocomplete", "list"); ta.setAttribute("aria-expanded", "false");
  const list = el("ul", "suggest"); list.id = `calc-sug-${n}`; list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Fields, calculations and functions"); list.hidden = true;
  ta.setAttribute("aria-controls", list.id);
  const hint = el("div", "hint"); hint.id = `calc-hint-${n}`;
  hint.append("Type ", el("code", null, "["), " to pick a field or another calculation, ", el("code", null, "[@"), " for a parameter, or the start of a function name (", el("code", null, "LO"), ").");
  // The right panel: every function, always on screen beside the editor (no toggle).
  const panel = el("div", "calc-fn"); panel.id = `calc-fn-${n}`;
  panel.setAttribute("role", "group"); panel.setAttribute("aria-label", "Functions");
  const fMsg = el("div"); fMsg.id = `calc-fmsg-${n}`; fMsg.setAttribute("role", "alert");
  ta.setAttribute("aria-describedby", `${hint.id} ${fMsg.id}`);
  wrap.append(ta, list);
  formulaField.append(fLabel, wrap, hint, fMsg);

  // Role chip + "Use as"
  const row = el("div", "row calc-dialog__row");
  const chipHost = el("span"); chipHost.setAttribute("aria-live", "polite");
  const useAs = el("div", "field calc-useas"); useAs.hidden = true;
  const useLabel = el("div", "label", "Use as"); useLabel.id = `calc-use-${n}`;
  const seg = el("div", "seg"); seg.setAttribute("role", "radiogroup"); seg.setAttribute("aria-labelledby", useLabel.id);
  const radios = {};
  for (const [value, text, ic] of [["measure", "Measure", "analytics"], ["dimension", "Dimension", "detail"]]) {
    const lab = el("label", value === "dimension" ? "is-dim" : null);
    const r = el("input"); r.type = "radio"; r.name = `calc-use-${n}`; r.value = value;
    radios[value] = r;
    lab.append(r, icon(ic, { size: 14 }), text);
    seg.append(lab);
  }
  useAs.append(useLabel, seg);
  row.append(chipHost, useAs);
  const useHint = el("div", "hint", "Shown only for a row-level number. As a measure it is summed when dropped on a value shelf.");
  useHint.hidden = true;

  // Two panels: the editor on the left, the available functions on the right.
  const editPane = el("div", "calc-dialog__edit");
  editPane.append(nameField, formulaField, row, useHint);
  body.append(editPane, panel);
  const foot = el("div", "dialog__foot");
  const cancel = makeButton("Cancel", "btn"), save = makeButton("Save", "btn btn--primary");
  save.disabled = true;
  foot.append(cancel, save);
  dlg.append(title, body, foot);

  // --- live state -------------------------------------------------------------
  let nameTouched = Boolean(existing);
  let current = null;       // the last evaluateDraft result for the real name
  let items = [], active = -1, range = null, arrowed = false;

  const message = (host, text, pos, formula) => {
    host.replaceChildren();
    if (!text) return;
    const line = el("div", "field-error");
    line.append(icon("warning", { size: 14 }));
    const span = el("span", null, text);
    if (pos !== undefined) span.append(" ", el("span", "hint calc-pos", `(at character ${pos + 1})`));
    line.append(span);
    host.append(line);
    if (pos !== undefined) {
      const col = formula.slice(0, pos).split("\n").pop().length;
      const mark = el("span", "caretmark", `${" ".repeat(col)}^`);
      mark.setAttribute("aria-hidden", "true");
      host.append(mark);
    }
  };
  const chip = (cls, ic, text) => {
    const p = el("span", `calc-chip ${cls}`);
    p.append(icon(ic, { size: 13 }), text);
    chipHost.replaceChildren(p);
  };

  const refresh = () => {
    const formula = normaliseFormula(ta.value);
    const draft = { name: name.value, formula, selfId: existing?.id };
    let r = evaluateDraft(draft, ctx);
    current = r;
    // A bad name must not hide what is wrong (or right) with the formula: judge the formula under a stand-in name.
    let f = r;
    if (!r.ok && r.field === "name") f = evaluateDraft({ ...draft, name: "New calculation" }, ctx);
    const nameBad = !r.ok && r.field === "name";
    if (nameBad && nameTouched) name.setAttribute("aria-invalid", "true"); else name.removeAttribute("aria-invalid");
    message(nameMsg, nameBad && nameTouched ? r.message : "");
    const clash = !nameBad ? columnClash(name.value, catalog) : null;
    if (clash) { nameMsg.replaceChildren(el("div", "hint", clash)); }
    const untouched = formula.trim() === "";
    const formulaBad = !untouched && !f.ok && f.field === "formula";
    if (formulaBad) ta.setAttribute("aria-invalid", "true"); else ta.removeAttribute("aria-invalid");
    message(fMsg, formulaBad ? f.message : "", formulaBad ? f.pos : undefined, formula);
    if (untouched) chip("calc-chip--muted", "detail", "No formula yet");
    else if (formulaBad) chip("calc-chip--danger", "warning", "Can't be saved");
    else if (f.ok) { const c = chipFor(f.info, f.role); chip(f.info.isAggregate ? "calc-chip--meas" : "calc-chip--dim", c.icon, c.text); }
    const showUse = Boolean(f.ok) && showUseAs(f.info);
    useAs.hidden = useHint.hidden = !showUse;
    if (showUse) {
      const picked = useAsRole(Object.values(radios).find((x) => x.checked)?.value) ?? roleChoice(existing?.id) ?? f.role;
      radios[picked === "measure" ? "measure" : "dimension"].checked = true;
    }
    save.disabled = !r.ok;
  };

  // --- autocomplete ---------------------------------------------------------
  const closeList = () => { arrowed = false; list.hidden = true; items = []; active = -1; ta.setAttribute("aria-expanded", "false"); ta.removeAttribute("aria-activedescendant"); };
  const setActive = (i) => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute("aria-selected", String(k === i)));
    if (i >= 0) { ta.setAttribute("aria-activedescendant", list.children[i].id); list.children[i].scrollIntoView?.({ block: "nearest" }); }
  };
  const openList = () => {
    const s = suggest(normaliseFormula(ta.value), ta.selectionStart, ctx);
    if (!s.items.length) { closeList(); return; }
    range = s; items = s.items; arrowed = false;
    list.replaceChildren(...items.map((it, k) => {
      const li = el("li"); li.id = `${list.id}-${k}`; li.setAttribute("role", "option");
      li.append(icon(it.kind === "field" ? "table" : it.kind === "param" ? "param" : "calc", { size: 14 }), el("span", "name", it.label), el("span", "kind", it.hint ?? (it.kind === "param" ? `parameter · ${it.type}` : kinds.get(it.label) ?? it.kind)));
      li.addEventListener("mousedown", (e) => { e.preventDefault(); accept(k); }); // keep focus in the textarea
      return li;
    }));
    list.hidden = false; ta.setAttribute("aria-expanded", "true");
    setActive(0);
  };
  const accept = (k) => {
    const it = items[k]; if (!it) return;
    const text = normaliseFormula(ta.value);
    const tail = text.slice(range.to);
    const fn = it.kind === "function";
    const close = fn || tail.startsWith("]") ? "" : "]";
    ta.value = `${text.slice(0, range.from)}${it.insert}${close}${tail}`;
    const caret = range.from + it.insert.length + (fn ? 0 : 1);
    ta.setSelectionRange(caret, caret);
    closeList(); refresh();
  };

  ta.addEventListener("input", () => { refresh(); openList(); });
  ta.addEventListener("click", openList);
  ta.addEventListener("blur", closeList);
  ta.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); arrowed = true; setActive((active + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); arrowed = true; setActive((active - 1 + items.length) % items.length); }
    else if (e.key === "Enter") { e.preventDefault(); accept(active); }
    else if (e.key === "Tab") { if (arrowed) { e.preventDefault(); accept(active); } else closeList(); } // Tab accepts only after arrowing; otherwise focus moves on
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeList(); } // close the list, not the dialog
  });
  name.addEventListener("input", () => { nameTouched = true; refresh(); });
  name.addEventListener("blur", () => { nameTouched = true; refresh(); });
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ta.focus(); } });

  // --- function help ----------------------------------------------------------
  const search = el("input", "input calc-fn__search"); search.type = "search"; search.autocomplete = "off";
  search.placeholder = "Search functions, e.g. date"; search.setAttribute("aria-label", "Search functions");
  const fnList = el("div", "calc-fn__list");
  const detail = el("div", "calc-fn__detail"); detail.id = `${panel.id}-detail`;
  const insertBtn = makeButton("Insert example", "btn"); insertBtn.type = "button"; insertBtn.hidden = true;
  panel.append(el("h4", "calc-fn__title", "Functions"), search, fnList, detail, insertBtn);
  let shown = null;
  const insertText = (text) => {
    const v = ta.value, a = ta.selectionStart ?? v.length, z = ta.selectionEnd ?? a;
    ta.value = `${v.slice(0, a)}${text}${v.slice(z)}`;
    ta.focus(); ta.setSelectionRange(a + text.length, a + text.length);
    closeList(); refresh();
  };
  const show = (h, pick = true) => {
    if (pick) { shown = h; insertBtn.hidden = !h; if (h) insertBtn.setAttribute("aria-label", `Insert example for ${h.name}`); }
    detail.replaceChildren();
    if (!h) { detail.append(el("p", "hint", "Hover or focus a function for details.")); return; }
    const row = (label, value, code) => { const p = el("p", "calc-fn__line"); p.append(el("strong", null, `${label} `), code ? el("code", null, value) : value); detail.append(p); };
    detail.append(el("code", "calc-fn__sig", h.signature), el("p", "calc-fn__sum", h.summary));
    row("Takes", h.arguments); row("Gives", h.result); row("Example", h.example, true); row("Empty values", h.note);
  };
  fnList.addEventListener("mouseleave", () => show(shown, false)); // back to the function the Insert example button targets
  const renderList = () => {
    const found = searchHelp(search.value);
    fnList.replaceChildren();
    if (!found.length) fnList.append(el("p", "hint", "No function matches."));
    for (const g of groupHelp(found)) {
      const head = el("h4", "calc-fn__group", g.group), ul = el("ul", "calc-fn__items");
      ul.setAttribute("aria-label", g.group);
      for (const h of g.items) {
        const li = el("li"), b = el("button", "calc-fn__item"); b.type = "button";
        b.append(el("span", "name", h.name), el("span", "sig", h.signature.startsWith(h.name) ? h.signature.slice(h.name.length) : h.signature));
        b.setAttribute("aria-describedby", detail.id);
        b.addEventListener("mouseenter", () => show(h, false)); // hover previews; only keyboard focus picks the Insert example target
        b.addEventListener("focus", () => show(h));
        b.addEventListener("click", () => { show(h); insertText(h.signature); });
        li.append(b); ul.append(li);
      }
      fnList.append(head, ul);
    }
    if (shown && !found.includes(shown)) show(null);
  };
  search.addEventListener("input", renderList);
  insertBtn.addEventListener("click", () => { if (shown) insertText(shown.example); });
  renderList(); show(null);

  const finish = () => closeDialog(dlg);
  // Cancel / Esc: an untouched dialog closes at once; an edited one asks before throwing the draft away.
  const initial = { name: existing?.name ?? "", formula: existing?.formula ?? "" };
  let asking = false;
  const requestClose = async () => {
    if (asking) return;
    if (!isDirty(initial, { name: name.value, formula: ta.value })) { finish(); return; }
    asking = true;
    const discard = await confirmDialog("Discard your changes to this calculated field?", { danger: true, confirmText: "Discard" });
    asking = false;
    if (discard) finish(); else ta.focus();
  };
  cancel.addEventListener("click", requestClose);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); requestClose(); });
  save.addEventListener("click", () => {
    nameTouched = true; refresh();
    const r = current;
    if (!r?.ok) return;
    const nm = name.value.trim(), formula = normaliseFormula(ta.value);
    let id = existing?.id;
    if (existing) updateCalculation(existing.id, { name: nm, formula });
    else if (calculations.length >= LIMITS.calculations) { toast(`A workbook can have at most ${LIMITS.calculations} calculated fields.`, "info"); return; }
    else id = addCalculation({ name: nm, formula }).id;
    setRoleChoice(id, showUseAs(r.info) ? useAsRole(Object.values(radios).find((x) => x.checked)?.value) : null);
    finish();
    toast(`Saved calculated field “${nm}”.`, "ok");
  });

  refresh();
  document.body.append(dlg);
  openDialog(dlg);
  (existing ? ta : name).focus();
}

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; }
