import { icon } from "./icons.js";

// Small shared UI helpers. Visibility is always toggled via the `hidden` attribute — never
// inline style.display — so the one `[hidden]{display:none!important}` rule stays in charge
// (CLAUDE.md golden rule 5 / DESIGN.md).

export const show = (el) => { if (el) el.hidden = false; };
export const hide = (el) => { if (el) el.hidden = true; };
export const toggle = (el, visible) => { if (el) el.hidden = !visible; };

/** Copy `text` to the clipboard and toast "Copied <what>." (or a danger toast when the browser blocks it). */
export async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}.`, "info"); }
  catch { toast("Couldn't copy — your browser blocked clipboard access.", "danger"); }
}

let toastTimer;
let toastText; // the visible message span (NOT a live region)

/** Transient message. `kind` is one of "ok" | "danger" | "info". Danger toasts stay until dismissed.
 *  Announcement goes through ONE persistent, always-rendered visually-hidden live region (#toast-live) that sits
 *  outside the `hidden` #toast container (a display:none live region is not announced). */
export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  if (!toastText || !el.contains(toastText)) {
    toastText = document.createElement("span");
    toastText.className = "toast__text";
    const close = makeButton("", "toast__close");
    close.append(icon("close", { size: 14 }));
    close.setAttribute("aria-label", "Dismiss");
    close.title = "Dismiss";
    close.addEventListener("click", () => hide(el));
    el.replaceChildren(toastText, close);
  }
  toastText.textContent = message;
  el.className = `toast toast--${kind}`;
  show(el);
  const live = document.getElementById("toast-live");
  if (live) { live.textContent = ""; setTimeout(() => { live.textContent = message; }, 50); } // clear then set so repeats re-announce
  clearTimeout(toastTimer);
  if (kind !== "danger") toastTimer = setTimeout(() => hide(el), 5000);
}
let fieldErrorSeq = 0;
/** Mark a field invalid with an inline message under it; cleared on the next edit. */
export function fieldError(input, message) {
  clearFieldError(input);
  const msg = document.createElement("p");
  msg.className = "field-error"; msg.id = `field-error-${++fieldErrorSeq}`;
  const glyph = document.createElement("span");
  glyph.className = "field-error__icon"; glyph.setAttribute("aria-hidden", "true"); glyph.append(icon("warning", { size: 14 }));
  msg.append(glyph, document.createTextNode(" " + message));
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", msg.id);
  input.insertAdjacentElement("afterend", msg);
  input.addEventListener("input", () => clearFieldError(input), { once: true });
}
export function clearFieldError(input) {
  const id = input.getAttribute("aria-describedby");
  if (id) document.getElementById(id)?.remove();
  input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby");
}
/** Apply a validate.js result to a field: the value when ok, else undefined (and the field is marked). */
export function checkField(input, result) {
  if (result.ok) { clearFieldError(input); return result.value; }
  fieldError(input, result.error);
  return undefined;
}
/** A titled list of issues with one OK button. */
export function listDialog(title, items) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dialog dialog--sm";
    const h = document.createElement("h2"); h.className = "dialog__title"; h.textContent = title;
    const ul = document.createElement("ul"); ul.className = "dialog__list";
    for (const it of items) { const li = document.createElement("li"); li.textContent = it; ul.append(li); }
    const foot = document.createElement("div"); foot.className = "dialog__foot";
    const okBtn = makeButton("OK", "btn btn--primary"); foot.append(okBtn);
    dlg.append(h, ul, foot); document.body.append(dlg);
    const finish = () => { closeDialog(dlg); resolve(); };
    okBtn.addEventListener("click", finish);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
    openDialog(dlg);
  });
}

// --- Dialogs (native <dialog>; falls back to the `open` attribute where showModal is
// unavailable, e.g. headless jsdom). Confirms replace window.confirm (DESIGN.md). ---
export function makeButton(text, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  return b;
}

export function openDialog(dlg) {
  try { dlg.showModal(); } catch { dlg.open = true; }
}

export function closeDialog(dlg) {
  try { dlg.close(); } catch { dlg.open = false; }
  dlg.remove();
}

/** A styled confirm dialog. Resolves true/false. */
export function confirmDialog(message, { danger = false, confirmText = "Confirm" } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dialog dialog--sm";

    const body = document.createElement("p");
    body.className = "dialog__body";
    body.textContent = message;

    const foot = document.createElement("div");
    foot.className = "dialog__foot";
    const cancel = makeButton("Cancel", "btn");
    const ok = makeButton(confirmText, danger ? "btn btn--danger" : "btn btn--primary");
    foot.append(cancel, ok);

    dlg.append(body, foot);
    document.body.append(dlg);

    const finish = (value) => { closeDialog(dlg); resolve(value); };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
    openDialog(dlg);
  });
}

/** Destructive confirmation, asked once (there is no Undo, so the dialog says so): `message` plus "This can't be undone.", a danger button labelled `confirmText`. Resolves true only when confirmed. */
export function confirmDestructive(message, { confirmText = "Delete" } = {}) {
  return confirmDialog(`${message} This can't be undone.`, { danger: true, confirmText });
}
