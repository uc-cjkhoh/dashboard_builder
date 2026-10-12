// Small shared UI helpers. Visibility is always toggled via the `hidden` attribute — never
// inline style.display — so the one `[hidden]{display:none!important}` rule stays in charge
// (CLAUDE.md golden rule 5 / DESIGN.md).

export const show = (el) => { if (el) el.hidden = false; };
export const hide = (el) => { if (el) el.hidden = true; };
export const toggle = (el, visible) => { if (el) el.hidden = !visible; };

let toastTimer;

/** Transient message. `kind` is one of "ok" | "danger" | "info". Danger toasts stay until dismissed. */
export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  const text = document.createElement("span");
  text.className = "toast__text"; text.textContent = message;
  const close = makeButton("×", "toast__close");
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => hide(el));
  el.replaceChildren(text, close);
  el.className = `toast toast--${kind}`;
  show(el);
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
  glyph.className = "field-error__icon"; glyph.setAttribute("aria-hidden", "true"); glyph.textContent = "⚠";
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

// Status is icon + text + color, never color alone (accessibility — DESIGN.md).
const PILL = {
  idle:       { cls: "pill--muted",  glyph: "○", label: "Idle" },
  connecting: { cls: "pill--warn",   glyph: "◐", label: "Connecting…" },
  connected:  { cls: "pill--ok",     glyph: "●", label: "Connected" },
  failed:     { cls: "pill--danger", glyph: "✕", label: "Failed" },
};

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

/** Set a status pill's state + text. Text is set as a text node (never HTML). */
export function setPill(el, state, text) {
  if (!el) return;
  const p = PILL[state] ?? PILL.idle;
  el.className = `pill ${p.cls}`;
  el.replaceChildren();

  const glyph = document.createElement("span");
  glyph.className = "pill__glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = p.glyph;

  el.append(glyph, document.createTextNode(" " + (text ?? p.label)));
}
