// Core/menu.js — a button toggling a [role=menu] list. Esc, outside click and item click close it;
// ArrowUp/ArrowDown move focus. Items are [role=menuitem] or [role=menuitemradio]. Visibility via
// `hidden` only; opening scales/fades in from the button and closing fades out quicker (Core/motion.js).
// Pass an AbortSignal for menus that are re-rendered.
import { enter, exit } from "./motion.js";
import { icon } from "./icons.js";
import { placeMenu, opensContext, nextFocus } from "./context-menu-model.js";

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

// --- Context popup ---------------------------------------------------------------------------------------------
// A menu with no button: it opens at the pointer on right-click (contextmenu) or under the element on the ContextMenu key /
// Shift+F10 / Enter (Core/context-menu-model.js). It is a plain `.menu__list` (role=menu) on <body>, so panels never clip it.
// Entries ({ type: item | radio | check | heading | sep | custom, label, checked, disabled, title, onSelect, keepOpen, el }) are
// given as an array or a function re-read on every refresh. A radio / check / item closes the popup and then acts, unless
// `keepOpen` (act, then rebuild the entries). Esc, Tab, outside click, scroll and resize close it.
let current = null;

export function closeContextMenu() { current?.close(); }

export function openContextMenu({ x, y, entries, label = "Options", returnFocus }) {
  closeContextMenu();
  const list = document.createElement("div");
  list.className = "menu__list ctx-menu";
  list.setAttribute("role", "menu"); list.setAttribute("aria-label", label);
  const itemEls = () => [...list.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])')];
  const build = () => {
    const keep = itemEls().indexOf(document.activeElement);
    list.replaceChildren();
    for (const e of typeof entries === "function" ? entries() : entries) list.append(row(e));
    if (keep >= 0) itemEls()[Math.min(keep, itemEls().length - 1)]?.focus();
  };
  const row = (e) => {
    if (e.type === "sep") { const d = document.createElement("div"); d.className = "menu__sep"; d.setAttribute("role", "separator"); return d; }
    if (e.type === "heading") { const d = document.createElement("div"); d.className = "menu__heading"; d.textContent = e.label; return d; }
    if (e.type === "custom") { const d = document.createElement("div"); d.className = "ctx-menu__custom"; d.append(e.el); return d; }
    const b = document.createElement("button");
    b.type = "button"; b.className = "menu__item";
    b.setAttribute("role", e.type === "radio" ? "menuitemradio" : e.type === "check" ? "menuitemcheckbox" : "menuitem");
    if (e.type !== "item") b.setAttribute("aria-checked", String(Boolean(e.checked)));
    if (e.disabled) b.setAttribute("aria-disabled", "true");
    if (e.title) b.title = e.title;
    if (e.icon) b.append(icon(e.icon));
    const t = document.createElement("span"); t.className = "menu__label"; t.textContent = e.label; b.append(t);
    if (e.type !== "item") { const tick = icon("check", { size: 14 }); tick.classList.add("menu__check"); b.append(tick); }
    b.addEventListener("click", () => {
      if (e.disabled) return;
      if (e.keepOpen) { e.onSelect?.(); build(); return; }
      close(); e.onSelect?.();
    });
    return b;
  };
  let closed = false;
  const ac = new AbortController();
  function close() {
    if (closed) return; closed = true;
    ac.abort(); list.remove();
    if (current?.list === list) current = null;
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body) return; // focus went somewhere on purpose
      returnFocus?.()?.focus();
    }, 0);
  }
  build();
  document.body.append(list);
  const r = list.getBoundingClientRect();
  const at = placeMenu({ x, y, width: r.width, height: r.height, viewW: window.innerWidth, viewH: window.innerHeight });
  list.style.left = `${at.left}px`; list.style.top = `${at.top}px`;
  enter(list, { y: -4, scale: .97 });
  itemEls()[0]?.focus();
  const sig = { signal: ac.signal };
  list.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); returnFocus?.()?.focus(); return; }
    if (e.key === "Tab") { close(); return; }
    const onItem = e.target.closest?.('[role^="menuitem"]');
    if (!onItem || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const all = itemEls();
    all[nextFocus(all.indexOf(onItem), all.length, e.key)]?.focus();
  }, sig);
  document.addEventListener("pointerdown", (e) => { if (!list.contains(e.target)) close(); }, { capture: true, ...sig });
  document.addEventListener("contextmenu", (e) => { if (!list.contains(e.target)) close(); }, { capture: true, ...sig });
  window.addEventListener("resize", close, sig); window.addEventListener("blur", close, sig);
  document.addEventListener("scroll", (e) => { if (!list.contains(e.target)) close(); }, { capture: true, ...sig });
  current = { list, close };
  return { close, refresh: build };
}

/** Wire right-click and the keyboard equivalents on `target`. `entries` is read at open time; `returnFocus` finds the element to refocus (the target may be re-rendered meanwhile). */
export function wireContextMenu(target, entries, { label, returnFocus } = {}) {
  target.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY, entries, label, returnFocus: returnFocus ?? (() => target) });
  });
  target.addEventListener("keydown", (e) => {
    if (!opensContext(e)) return;
    e.preventDefault(); e.stopPropagation();
    const r = target.getBoundingClientRect();
    openContextMenu({ x: r.left, y: r.bottom + 4, entries, label, returnFocus: returnFocus ?? (() => target) });
  });
  target.setAttribute("aria-haspopup", "menu");
}
