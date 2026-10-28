// P32 — Workbook menu → Parameters…: add, edit and delete the workbook's parameters (name, type, allowed
// values, current value). Each value is checked by Core/parameters-model.js before it is kept.
import { parameters, calculations, addParameter, updateParameter, removeParameter } from "../Core/store.js";
import { PARAM_TYPES, MAX_PARAMS, MAX_LIST, checkValue, checkStep } from "../Core/parameters-model.js";
import { text } from "../Core/validate.js";
import { calcsUsingParam } from "../Calc/calc-params.js";
import { makeButton, openDialog, closeDialog, toast, confirmDialog } from "../Core/ui.js";

export function openParametersDialog() {
  const dlg = el("dialog", "dialog params-dialog");
  const head = el("div", "dialog__head");
  const title = el("h2", null, "Parameters"); title.id = "params-title";
  dlg.setAttribute("aria-labelledby", title.id);
  head.append(title);
  const body = el("div", "dialog__body");
  const foot = el("div", "dialog__foot");
  const add = makeButton("+ New parameter", "btn");
  const done = makeButton("Done", "btn btn--primary");
  foot.append(add, done);
  dlg.append(head, body, foot);
  let editing = null; // the id being edited, or "new"

  const render = () => {
    body.replaceChildren();
    if (!parameters.length && editing !== "new")
      body.append(el("p", "bookmark-note", "No parameters yet. A parameter is a named value a filter, Top N, reference line or calculated field ([@Name]) can follow — change it once and every view that uses it re-runs."));
    const list = el("ul", "bookmark-list");
    for (const p of parameters) {
      if (editing === p.id) { list.append(editor(p)); continue; }
      const li = el("li", "bookmark");
      const info = el("div", "bookmark__info");
      info.append(el("span", "bookmark__name", p.name), el("span", "bookmark__meta", `${p.type} · ${describe(p)} · now ${p.value}`));
      const edit = makeButton("Edit", "btn"); edit.setAttribute("aria-label", `Edit parameter ${p.name}`);
      edit.addEventListener("click", () => { editing = p.id; render(); });
      const del = makeButton("Delete", "btn"); del.setAttribute("aria-label", `Delete parameter ${p.name}`);
      del.addEventListener("click", async () => {
        const users = calcsUsingParam(calculations, p.name); // a calculated field that reads it would stop computing
        if (users.length && !(await confirmDialog(`“${p.name}” is read by ${users.length === 1 ? "calculation" : "calculations"} ${users.map((u) => `'${u}'`).join(", ")}. Deleting it leaves ${users.length === 1 ? "it" : "them"} unable to compute until you edit the formula or add a parameter with that name.`, { danger: true, confirmText: "Delete" }))) return;
        removeParameter(p.id); render();
      });
      li.append(info, edit, del);
      list.append(li);
    }
    if (editing === "new") list.append(editor(null));
    if (list.children.length) body.append(list);
    add.disabled = editing !== null || parameters.length >= MAX_PARAMS;
  };

  // The edit form: name, type, allowed (any / list / range), value. Save checks everything.
  function editor(p) {
    const li = el("li", "bookmark params-edit");
    const form = el("div", "params-form");
    const name = input("Name", p?.name ?? "", 60);
    const type = el("select", "select"); type.setAttribute("aria-label", "Type");
    for (const t of PARAM_TYPES) type.add(new Option(t, t, false, (p?.type ?? "number") === t));
    const kind = el("select", "select"); kind.setAttribute("aria-label", "Allowed values");
    for (const [v, t] of [["any", "Any value"], ["list", "A list"], ["range", "A range (numbers)"]]) kind.add(new Option(t, v, false, (p?.allowed?.kind ?? "any") === v));
    const listIn = input("List (comma-separated)", (p?.allowed?.list ?? []).join(", "), 2000);
    const min = input("Min", p?.allowed?.min ?? "", 30), max = input("Max", p?.allowed?.max ?? "", 30);
    const step = input("Step size (optional)", p?.allowed?.step ?? "", 30);
    const value = input("Current value", p?.value ?? "", 1000);
    const err = el("p", "field-error"); err.hidden = true; err.setAttribute("role", "alert");
    const sync = () => {
      listIn.parentNode.hidden = kind.value !== "list";
      min.parentNode.hidden = max.parentNode.hidden = step.parentNode.hidden = kind.value !== "range" || type.value !== "number";
    };
    kind.addEventListener("change", sync); type.addEventListener("change", sync);
    const save = makeButton("Save", "btn btn--primary"), cancel = makeButton("Cancel", "btn");
    cancel.addEventListener("click", () => { editing = null; render(); });
    save.addEventListener("click", () => {
      const fail = (m) => { err.textContent = m; err.hidden = false; };
      const n = text(name.value, { label: "Name", max: 60, required: true });
      if (!n.ok) return fail(n.error);
      if (parameters.some((x) => x.name === n.value && x.id !== p?.id)) return fail("Another parameter has that name.");
      let allowed = { kind: "any" };
      if (kind.value === "list") {
        const items = listIn.value.split(",").map((x) => x.trim()).filter(Boolean);
        if (!items.length) return fail("List at least one value.");
        if (items.length > MAX_LIST) return fail(`A list can hold at most ${MAX_LIST} values.`);
        const bad = items.find((x) => !checkValue({ name: n.value, type: type.value }, x).ok);
        if (bad) return fail(`"${bad}" isn't a ${type.value}.`);
        allowed = { kind: "list", list: items };
      } else if (kind.value === "range" && type.value === "number") {
        const lo = min.value.trim() === "" ? null : Number(min.value), hi = max.value.trim() === "" ? null : Number(max.value);
        if ((lo != null && !Number.isFinite(lo)) || (hi != null && !Number.isFinite(hi)) || (lo != null && hi != null && lo > hi)) return fail("Min and max must be numbers, min ≤ max.");
        const st = checkStep(step.value);
        if (!st.ok) return fail(st.error);
        allowed = { kind: "range", min: lo, max: hi, step: st.value };
      }
      const draft = { name: n.value, type: type.value, allowed };
      const v = checkValue(draft, value.value || (allowed.kind === "list" ? allowed.list[0] : ""));
      if (!v.ok) return fail(v.error);
      if (p) updateParameter(p.id, { ...draft, value: v.value }); else addParameter({ ...draft, value: v.value });
      editing = null; render();
      toast(`Saved parameter “${n.value}”.`, "ok");
    });
    form.append(name.parentNode, labelled("Type", type), labelled("Allowed", kind), listIn.parentNode, min.parentNode, max.parentNode, step.parentNode, value.parentNode);
    const actions = el("div", "params-actions"); actions.append(save, cancel);
    li.append(form, err, actions);
    queueMicrotask(sync);
    return li;
  }

  add.addEventListener("click", () => { editing = "new"; render(); });
  const finish = () => closeDialog(dlg);
  done.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  render();
  document.body.append(dlg);
  openDialog(dlg);
}

const describe = (p) => (p.allowed?.kind === "list" ? `one of ${p.allowed.list.join(", ")}`
  : p.allowed?.kind === "range" ? `${p.allowed.min ?? "−∞"} to ${p.allowed.max ?? "∞"}${p.allowed.step ? `, step ${p.allowed.step}` : ""}` : "any value");
function input(label, value, max) {
  const i = el("input", "input"); i.value = String(value ?? ""); i.maxLength = max;
  labelled(label, i);
  return i;
}
function labelled(label, control) {
  const wrap = el("label", "form-field params-field");
  wrap.append(el("span", "params-field__label", label), control);
  return wrap;
}
function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; }
