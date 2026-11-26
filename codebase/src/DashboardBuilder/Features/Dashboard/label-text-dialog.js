// The "Edit label text…" modal (Label flyout → Text): one template with <Field> placeholders, a chip per field that inserts at the caret, and a live preview
// of the label from the fields' sample values. DOM only — the rules are in label-appearance-model.js. A draft until Apply (one commit); Esc / Cancel discard.
// Chart labels are one style for the whole label (Font and Alignment in the flyout), so unlike the tooltip editor there are no per-line styles or formats.
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { LIMITS } from "../Core/validate.js";
import { cleanLabelText, labelFieldCatalog, labelTextPreview } from "./label-appearance-model.js";
import { parseTooltip } from "./tooltip-model.js";

let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

/** `text`: the sheet's current template ("" = automatic); `fields`: [{ name, sample, kind }] the drawn chart offers (tooltipCatalog); `onClose()` runs after the dialog closes (focus return);
 *  `onApply(text)` receives the validated template ("" = the automatic text). */
export function openLabelTextDialog({ text, fields, onApply, onClose }) {
  const n = ++seq;
  const catalog = labelFieldCatalog(fields);
  const dlg = el("dialog", "dialog tipdlg tipdlg--label");
  const title = el("h3", "dialog__title", "Label text"); title.id = `lbldlg-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body tipdlg__body");
  const left = el("div", "tipdlg__edit"), right = el("div", "tipdlg__side");
  const chips = el("div", "tipdlg__chips"); chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Insert a field into the label text");
  const ta = el("textarea", "input tipdlg__label");
  ta.setAttribute("aria-label", "Label text"); ta.rows = 3; ta.maxLength = LIMITS.labelText; ta.value = text ?? "";
  ta.placeholder = "Text and <field> placeholders — empty keeps the automatic text";
  const count = el("span", "tipdlg__count"), err = el("div", "tipdlg__error"); err.setAttribute("role", "alert");
  left.append(chips, ta, count, err);
  const preview = el("div", "tipdlg__preview"); preview.setAttribute("aria-label", "Label preview");
  right.append(el("div", "tipdlg__head", "Preview"), preview);
  body.append(left, right);
  const foot = el("div", "dialog__foot");
  const reset = makeButton("Automatic", "btn tipdlg__reset"), cancel = makeButton("Cancel", "btn"), apply = makeButton("Apply", "btn btn--primary");
  reset.title = "Use the automatic label text";
  foot.append(reset, cancel, apply);
  dlg.append(title, body, foot);

  const known = new Set(catalog.map((f) => f.name));
  const refresh = () => {
    const r = cleanLabelText(ta.value);
    const used = r.ok && r.value ? parseTooltip(r.value).fields : [];
    const unknown = used.filter((f) => !known.has(f));
    preview.textContent = r.ok && r.value ? labelTextPreview(r.value, catalog) : "Automatic label text";
    count.textContent = `${ta.value.length}/${LIMITS.labelText}${unknown.length ? ` · not in this view: ${unknown.map((f) => `<${f}>`).join(" ")}` : ""}`;
    err.textContent = r.ok ? "" : r.error;
    apply.disabled = !r.ok;
  };
  for (const f of catalog) {
    const b = makeButton(f.name, "btn btn--ghost tipdlg__chip"); b.title = `Insert <${f.name}>`;
    b.addEventListener("click", () => {
      const a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a, ins = `<${f.name}>`;
      const next = `${ta.value.slice(0, a)}${ins}${ta.value.slice(z)}`;
      if (next.length > LIMITS.labelText) return;
      ta.value = next; ta.focus(); ta.setSelectionRange(a + ins.length, a + ins.length); refresh();
    });
    chips.append(b);
  }
  ta.addEventListener("input", refresh);
  const finish = () => { closeDialog(dlg); setTimeout(() => onClose?.(), 0); };
  cancel.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); }); // Esc discards
  reset.addEventListener("click", () => { ta.value = ""; refresh(); ta.focus(); });
  apply.addEventListener("click", () => { if (apply.disabled) return; const r = cleanLabelText(ta.value); if (!r.ok) return; onApply(r.value ?? ""); finish(); });
  document.body.append(dlg);
  openDialog(dlg);
  refresh();
  ta.focus();
}
