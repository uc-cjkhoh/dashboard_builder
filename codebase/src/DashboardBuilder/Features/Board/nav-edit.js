import { validateNavEdit, navTargets } from "./nav-model.js";
import { LIMITS } from "../Core/validate.js";

// A navigation button's inline edit form: label, tooltip, and the tab it goes to. Save / Enter commits, Cancel / Esc discards.
// `tabs` = the store's tabs, `ownId` = the dashboard the button sits on. onSave(value) gets { label, tip, target }; onCancel().
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
let seq = 0;

export function buildNavForm(widget, tabs, ownId, { onSave, onCancel }) {
  const id = `nv${++seq}`;
  const targets = navTargets(tabs, ownId);
  const form = h("form", "board-text-edit");
  form.noValidate = true;
  const field = (name, label, control, max) => {
    const wrap = h("div", "board-text-edit__field");
    const lab = h("label", "board-text-edit__label", label);
    control.id = `${id}-${name}`;
    lab.htmlFor = control.id;
    control.className = "board-text-edit__input";
    const meta = h("p", "board-text-edit__meta");
    meta.id = `${id}-${name}-meta`;
    control.setAttribute("aria-describedby", meta.id);
    const count = h("span", "board-text-edit__count");
    const err = h("span", "board-text-edit__error");
    err.setAttribute("role", "alert");
    if (max) {
      control.maxLength = max;
      const sync = () => { count.textContent = `${control.value.length} / ${max}`; };
      control.addEventListener("input", sync);
      queueMicrotask(sync);
    }
    control.addEventListener("input", () => { err.textContent = ""; control.removeAttribute("aria-invalid"); });
    control.addEventListener("change", () => { err.textContent = ""; control.removeAttribute("aria-invalid"); });
    meta.append(count, err);
    wrap.append(lab, control, meta);
    return { wrap, control, err };
  };
  const label = field("label", "Label", h("input"), LIMITS.navLabel);
  label.control.type = "text";
  label.control.value = widget.label ?? "";
  const tip = field("tip", "Tooltip", h("input"), LIMITS.navTip);
  tip.control.type = "text";
  tip.control.value = widget.tip ?? "";
  const go = field("target", "Goes to", h("select"));
  go.control.append(new Option("Nowhere yet", ""));
  for (const t of targets) go.control.append(new Option(`${t.kind === "dashboard" ? "Dashboard" : "Worksheet"}: ${t.name}`, t.id));
  go.control.value = targets.some((t) => t.id === widget.target) ? widget.target : "";
  const actions = h("div", "board-text-edit__actions");
  const save = h("button", "btn btn--primary board-text-edit__save", "Save");
  save.type = "submit";
  save.setAttribute("aria-label", "Save the button");
  const cancel = h("button", "btn board-text-edit__cancel", "Cancel");
  cancel.type = "button";
  cancel.setAttribute("aria-label", "Cancel editing the button");
  actions.append(save, cancel);
  form.append(label.wrap, tip.wrap, go.wrap, actions);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const r = validateNavEdit({ label: label.control.value, tip: tip.control.value, target: go.control.value }, targets.map((t) => t.id));
    const parts = [["label", label], ["tip", tip], ["target", go]];
    for (const [k, f] of parts) {
      f.err.textContent = r.ok ? "" : r.errors[k] ?? "";
      if (!r.ok && r.errors[k]) f.control.setAttribute("aria-invalid", "true"); else f.control.removeAttribute("aria-invalid");
    }
    if (!r.ok) { parts.find(([k]) => r.errors[k])[1].control.focus(); return; }
    onSave(r.value);
  });
  cancel.addEventListener("click", onCancel);
  form.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); onCancel(); } });
  return { form, focus: () => { label.control.focus(); label.control.select(); } };
}
