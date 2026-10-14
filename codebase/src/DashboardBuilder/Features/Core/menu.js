// Core/menu.js — a button toggling a [role=menu] list. Esc, outside click and item click close it;
// ArrowUp/ArrowDown move focus. Items are [role=menuitem] or [role=menuitemradio]. Visibility via
// `hidden` only; opening scales/fades in from the button and closing fades out quicker (Core/motion.js).
// Pass an AbortSignal for menus that are re-rendered.
import { enter, exit } from "./motion.js";

export function wireMenu(button, list, { signal } = {}) {
  const items = () => [...list.querySelectorAll('[role^="menuitem"]')];
  let seq = 0; // a newer open/close supersedes a close still fading out
  const setOpen = (open) => {
    const was = !list.hidden;
    const run = ++seq;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      list.hidden = false;
      if (!was) enter(list, { y: -4, scale: .97 });
      (items().find((i) => i.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
    } else if (was) {
      exit(list, { y: -2, scale: .98 }).then(() => { if (run === seq) list.hidden = true; });
    }
  };
  button.setAttribute("aria-haspopup", "menu"); button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => { setOpen(button.getAttribute("aria-expanded") !== "true"); }, { signal });
  list.addEventListener("click", (e) => { if (e.target.closest('[role^="menuitem"]')) setOpen(false); }, { signal });
  list.addEventListener("keydown", (e) => {
    const all = items(), i = all.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === "Escape") { setOpen(false); button.focus(); }
  }, { signal });
  const isOpen = () => button.getAttribute("aria-expanded") === "true";
  // Tabbing out of the open menu closes it (focus moved to something outside the button and list).
  const onFocusOut = (e) => {
    if (!isOpen()) return;
    const to = e.relatedTarget;
    if (to && (list.contains(to) || button.contains(to))) return;
    if (!to) return; // window blur / click on non-focusable — the outside-click handler decides
    setOpen(false);
  };
  list.addEventListener("focusout", onFocusOut, { signal });
  button.addEventListener("focusout", onFocusOut, { signal });
  document.addEventListener("click", (e) => { if (isOpen() && !list.contains(e.target) && !button.contains(e.target)) setOpen(false); }, { signal });
  return { close: () => setOpen(false) };
}
