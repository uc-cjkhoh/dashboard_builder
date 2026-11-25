// The app's one tooltip. A button's `title` is the text; the browser's own tooltip is slow (about a second), never shows on keyboard focus
// and can't be styled, so this module takes over for buttons: it shows the same text after a short rest of the pointer, at once on keyboard
// focus (:focus-visible), and hides on leave, press, scroll, Esc and blur. Nothing is rewritten in the markup: while a button is armed
// its `title` is held back (so the native tooltip never appears too) and put back when the tooltip hides. A disabled button keeps its
// native title (it gets no pointer events, and its title says why it is unavailable). Touch never shows one.
import { delayFor, placeTip } from "./hover-tip-model.js";

const SEL = 'button[title], [role="button"][title]';

let hideTip = () => {};
/** Hides the tooltip now (and gives its button its `title` back). A no-op until initHoverTips has run. */
export const hideHoverTip = () => hideTip();

export function initHoverTips() {
  const tip = document.createElement("div");
  tip.className = "hover-tip";
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("popover", "manual"); // top layer: draws over an open modal <dialog> too
  tip.hidden = true;
  document.body.append(tip);

  let owner = null, held = "", timer = 0, hiddenAt = -Infinity;
  const usable = (el) => el && !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.title;

  function hide() {
    clearTimeout(timer);
    if (owner) { if (!owner.hasAttribute("title")) owner.setAttribute("title", held); owner = null; held = ""; } // a title set meanwhile wins
    if (!tip.hidden) {
      tip.hidden = true;
      try { tip.hidePopover(); } catch { /* no Popover API */ }
      hiddenAt = performance.now();
    }
  }
  hideTip = hide;
  function show() {
    if (!owner?.isConnected) { hide(); return; }
    tip.textContent = held;
    tip.hidden = false;
    try { tip.showPopover(); } catch { /* no Popover API: it stays a fixed child of <body> */ }
    const a = owner.getBoundingClientRect(), r = tip.getBoundingClientRect();
    const at = placeTip({ anchor: a, width: r.width, height: r.height, viewW: window.innerWidth, viewH: window.innerHeight });
    tip.style.left = `${at.left}px`; tip.style.top = `${at.top}px`;
  }
  function arm(el, delay) {
    owner = el; held = el.title; el.removeAttribute("title");
    if (delay === 0) show(); else timer = setTimeout(show, delay);
  }
  function target(e) {
    const el = e.target instanceof Element ? e.target.closest(SEL) : null;
    return el && usable(el) ? el : null;
  }

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target instanceof Element ? e.target.closest(SEL) : null;
    if (el && el === owner) return; // moving inside the same button
    const delay = delayFor({ visible: !tip.hidden, sinceHiddenMs: performance.now() - hiddenAt });
    hide();
    const next = el && usable(el) ? el : null;
    if (next) arm(next, delay);
  });
  document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) hide(); }); // the pointer left the window
  document.addEventListener("focusin", (e) => {
    const el = target(e);
    if (!el || el === owner || !el.matches(":focus-visible")) return;
    hide();
    arm(el, 0);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}
