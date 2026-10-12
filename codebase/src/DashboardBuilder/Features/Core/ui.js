// Small shared UI helpers. Visibility is always toggled via the `hidden` attribute — never
// inline style.display — so the one `[hidden]{display:none!important}` rule stays in charge
// (CLAUDE.md golden rule 5 / DESIGN.md).

export const show = (el) => { if (el) el.hidden = false; };
export const hide = (el) => { if (el) el.hidden = true; };
export const toggle = (el, visible) => { if (el) el.hidden = !visible; };

let toastTimer;

/** Transient message. `kind` is one of "ok" | "danger" | "info". */
export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast toast--${kind}`;
  show(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(el), 5000);
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
