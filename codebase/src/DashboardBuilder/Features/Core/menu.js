// Core/menu.js — a button toggling a [role=menu] list. Esc, outside click and item click close it;
// ArrowUp/ArrowDown move focus. Visibility via `hidden` only. Pass an AbortSignal for menus that are re-rendered.
export function wireMenu(button, list, { signal } = {}) {
  const items = () => [...list.querySelectorAll('[role="menuitem"]')];
  const setOpen = (open) => {
    list.hidden = !open; button.setAttribute("aria-expanded", String(open));
    if (open) items()[0]?.focus();
  };
  button.setAttribute("aria-haspopup", "menu"); button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", (e) => { setOpen(list.hidden); }, { signal });
  list.addEventListener("click", (e) => { if (e.target.closest('[role="menuitem"]')) setOpen(false); }, { signal });
  list.addEventListener("keydown", (e) => {
    const all = items(), i = all.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === "Escape") { setOpen(false); button.focus(); }
  }, { signal });
  document.addEventListener("click", (e) => { if (!list.hidden && !list.contains(e.target) && !button.contains(e.target)) setOpen(false); }, { signal });
  return { close: () => setOpen(false) };
}
