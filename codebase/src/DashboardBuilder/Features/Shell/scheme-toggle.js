// Top-bar light / dark toggle: an icon button (its glyph shows the current choice) opening a
// System / Light / Dark radio menu (Core/menu.js). State lives in Core/scheme.js.
import { wireMenu } from "../Core/menu.js";
import { icon } from "../Core/icons.js";
import { bus } from "../Core/store.js";
import { SCHEME_PREFS } from "../Core/scheme-model.js";
import { schemePref, setSchemePref } from "../Core/scheme.js";

export function initSchemeToggle() {
  const btn = document.getElementById("scheme-btn"), list = document.getElementById("scheme-list");
  if (!btn || !list) return;
  const render = () => {
    const cur = SCHEME_PREFS.find((p) => p.id === schemePref());
    const label = `Appearance: ${cur.label}`;
    btn.replaceChildren(icon(cur.icon));
    btn.setAttribute("aria-label", label); btn.title = label;
    for (const item of list.querySelectorAll("[data-scheme-pref]"))
      item.setAttribute("aria-checked", String(item.dataset.schemePref === cur.id));
  };
  list.replaceChildren(...SCHEME_PREFS.map((p) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "menu__item"; b.dataset.schemePref = p.id;
    b.setAttribute("role", "menuitemradio");
    const label = document.createElement("span"); label.className = "menu__label"; label.textContent = p.label;
    const tick = icon("check", { size: 14 }); tick.classList.add("menu__check");
    b.append(icon(p.icon), label, tick);
    b.addEventListener("click", () => setSchemePref(p.id));
    return b;
  }));
  wireMenu(btn, list);
  bus.addEventListener("scheme:pref", render);
  render();
}
