// Calc/explain-popover.js — the "How this is computed" button and popover (view bar). Text only (textContent);
// the six stages come from describeEvaluation(evaluationInput(...)). Esc and outside click close it and focus
// returns to the button; visibility via `hidden`. Pass an AbortSignal for view bars that are re-rendered.
import { icon } from "../Core/icons.js";
import { enter } from "../Core/motion.js";
import { describeEvaluation } from "./eval-order.js";

let uid = 0;

/** `getInput()` returns the `s` summary at open time, so the text is always current. Returns the wrapper element. */
export function explainControl(getInput, { signal } = {}) {
  const id = `explain-${++uid}`;
  const wrap = document.createElement("span");
  wrap.className = "explain";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "iconbtn ws-viewbar__btn explain__btn";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", id);
  btn.title = "How this is computed — the order a view is evaluated";
  const label = document.createElement("span");
  label.textContent = "How this is computed";
  btn.append(icon("info"), label);

  const pop = document.createElement("div");
  pop.className = "explain__pop";
  pop.id = id;
  pop.hidden = true;
  pop.tabIndex = -1;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", `${id}-title`);
  const title = document.createElement("h3");
  title.id = `${id}-title`;
  title.className = "explain__title";
  title.textContent = "How this is computed";
  const list = document.createElement("ol");
  list.className = "explain__list";
  pop.append(title, list);

  const fill = () => {
    const items = describeEvaluation(getInput()).map((e) => {
      const li = document.createElement("li");
      const h = document.createElement("strong");
      h.textContent = e.title;
      const p = document.createElement("span");
      p.textContent = e.text;
      li.append(h, p);
      return li;
    });
    list.replaceChildren(...items);
  };
  const isOpen = () => !pop.hidden;
  const setOpen = (open, { restoreFocus = false } = {}) => {
    if (open === isOpen()) return;
    btn.setAttribute("aria-expanded", String(open));
    if (open) { fill(); pop.hidden = false; enter(pop, { y: -4, scale: .98 }); pop.focus(); }
    else { pop.hidden = true; if (restoreFocus) btn.focus(); }
  };

  btn.addEventListener("click", () => setOpen(!isOpen(), { restoreFocus: true }), { signal });
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) { e.stopPropagation(); setOpen(false, { restoreFocus: true }); } }, { signal });
  document.addEventListener("click", (e) => { if (isOpen() && !wrap.contains(e.target)) setOpen(false); }, { signal });
  wrap.append(btn, pop);
  return wrap;
}
