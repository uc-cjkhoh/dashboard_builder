// Top-bar Appearance: one icon button (its glyph shows the current mode) opening one card with every look-and-feel choice —
// mode (Light / Dark, remembered in this browser, Core/scheme.js), the dark look, the accent and the chart colours
// (saved with the workbook, Core/theme-model.js). Choices apply live and the card stays open; Esc, an outside click or Tab closes it.
// The card is built once; `sync` repaints the selection and the swatches whenever the mode or the theme changes.
import { wireMenu } from "../Core/menu.js";
import { icon } from "../Core/icons.js";
import { bus, currentTheme, setTheme } from "../Core/store.js";
import { SCHEME_PREFS } from "../Core/scheme-model.js";
import { schemePref, setSchemePref, isDark } from "../Core/scheme.js";
import { ACCENTS, PALETTES, SURFACES, DEFAULT_THEME, ONE_DARK_THEME, surfaceOf, deriveAccent, accentSet } from "../Core/theme-model.js";

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const radio = (cls, label, onPick) => {
  const b = el("button", cls);
  b.type = "button"; b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", "false");
  if (label) b.title = label;
  b.addEventListener("click", onPick);
  return b;
};
const tick = () => { const t = icon("check", { size: 14 }); t.classList.add("menu__check"); return t; };
// A strip of one option's colours, drawn as data from the theme's own token values (theme-model.js).
const strip = (colours) => {
  const s = el("span", "appearance__strip"); s.setAttribute("aria-hidden", "true");
  for (const c of colours) s.append(el("span"));
  return s;
};
const paint = (s, colours) => [...s.children].forEach((c, i) => { c.style.background = colours[i]; });

export function initAppearance() {
  const btn = document.getElementById("scheme-btn"), card = document.getElementById("scheme-list");
  if (!btn || !card) return;
  const rows = []; // everything that repaints: { node, checked(t), colours?(t, scheme) }

  // Mode: two segments, glyph + word.
  const modes = el("div", "appearance__modes");
  for (const p of SCHEME_PREFS) {
    const b = radio("appearance__mode", null, () => setSchemePref(p.id));
    b.dataset.schemePref = p.id;
    b.append(icon(p.icon), el("span", null, p.label));
    modes.append(b);
  }

  // Dark look: a row per look, with its three surface colours.
  const looks = Object.entries(SURFACES).map(([id, s]) => {
    const b = radio("menu__item", null, () => setTheme(id === "onedark" ? { ...ONE_DARK_THEME } : { ...currentTheme(), surface: id }));
    const st = strip(s.swatch); paint(st, s.swatch);
    b.append(st, el("span", "menu__label", s.label), tick());
    rows.push({ node: b, checked: (t) => surfaceOf(t) === id });
    return b;
  });

  // Accent: a swatch per preset (the chosen one carries a tick), then a custom colour. Its name is the heading's value.
  const accentName = el("span", "appearance__value");
  const accents = el("div", "appearance__accents");
  for (const [id, a] of Object.entries(ACCENTS)) {
    const b = radio("appearance__accent", a.label, () => setTheme({ ...currentTheme(), accent: id }));
    b.setAttribute("aria-label", a.label);
    const t = icon("check", { size: 16 }); t.classList.add("appearance__accent-tick");
    b.append(t);
    accents.append(b);
    rows.push({ node: b, checked: (t2) => t2.accent === id, colours: (_, dark) => { const c = a[dark ? "dark" : "light"]; b.style.background = c.accent; b.style.color = c.on; } });
  }
  // A custom colour, one field: a swatch that opens the colour picker (ticked when the custom colour is the chosen accent), its name and the #rrggbb.
  // A valid hex applies as it is typed; a colour that can't carry white button text is refused with the reason.
  const custom = el("div", "appearance__custom");
  const swatch = el("label", "appearance__swatch");
  const picker = el("input", "appearance__picker"); picker.type = "color";
  const swatchTick = icon("check", { size: 16 }); swatchTick.classList.add("appearance__swatch-tick");
  swatch.append(swatchTick, picker);
  const hex = el("input", "appearance__hex"); hex.type = "text"; hex.placeholder = "#rrggbb"; hex.maxLength = 7; hex.spellcheck = false; hex.autocomplete = "off";
  hex.id = "appearance-hex"; hex.setAttribute("aria-label", "Custom accent as #rrggbb");
  const title = el("label", "appearance__custom-title", "Custom"); title.htmlFor = hex.id; // the row's name; chosen = bold, like the menu's rows
  const err = el("span", "field-error appearance__error"); err.hidden = true; err.setAttribute("role", "alert");
  custom.append(swatch, title, hex);
  const HEX6 = /^#?[0-9a-f]{6}$/i;
  const tryCustom = (value) => {
    let v = value.trim().toLowerCase();
    if (HEX6.test(v) && !v.startsWith("#")) { v = `#${v}`; hex.value = v; } // 5a6b7c is as good as #5a6b7c
    const d = deriveAccent(v);
    err.hidden = !d.error; err.textContent = d.error ?? "";
    hex.setAttribute("aria-invalid", String(Boolean(d.error)));
    if (!d.error) setTheme({ ...currentTheme(), accent: v });
  };
  picker.addEventListener("change", () => { hex.value = picker.value; tryCustom(picker.value); });
  hex.addEventListener("input", () => {
    if (HEX6.test(hex.value.trim())) tryCustom(hex.value);
    else { err.hidden = true; hex.setAttribute("aria-invalid", "false"); } // still typing: no complaint until it is a whole colour
  });
  hex.addEventListener("change", () => tryCustom(hex.value));

  // Chart colours: a row per palette, with its eight series colours.
  const palettes = Object.entries(PALETTES).map(([id, p]) => {
    const b = radio("menu__item", null, () => setTheme({ ...currentTheme(), palette: id }));
    const st = strip(p.light);
    b.append(st, el("span", "menu__label", p.label), tick());
    rows.push({ node: b, checked: (t) => t.palette === id, colours: (_, dark) => paint(st, p[dark ? "dark" : "light"]) });
    return b;
  });

  const reset = radio("menu__item", null, () => setTheme(DEFAULT_THEME));
  reset.setAttribute("role", "menuitem"); reset.removeAttribute("aria-checked");
  reset.append(icon("refresh"), el("span", "menu__label", "Reset theme"));

  const heading = (text, value) => { const h = el("div", "menu__heading appearance__head", text); if (value) h.append(value); return h; };
  const sep = () => { const s = el("div", "menu__sep"); s.setAttribute("role", "separator"); return s; };
  card.classList.add("appearance");
  card.replaceChildren(modes, sep(), heading("Dark look"), ...looks, sep(), heading("Accent", accentName), accents, custom, err,
    sep(), heading("Chart colours"), ...palettes, sep(), reset);

  const sync = () => {
    const cur = SCHEME_PREFS.find((p) => p.id === schemePref()), t = currentTheme(), dark = isDark();
    btn.replaceChildren(icon(cur.icon));
    btn.setAttribute("aria-label", `Appearance: ${cur.label}`); btn.title = `Appearance: ${cur.label}`;
    for (const m of modes.children) m.setAttribute("aria-checked", String(m.dataset.schemePref === cur.id));
    for (const r of rows) { r.node.setAttribute("aria-checked", String(r.checked(t))); r.colours?.(t, dark); }
    const preset = ACCENTS[t.accent], set = accentSet(t, dark);
    accentName.textContent = preset ? preset.label : "Custom";
    if (document.activeElement !== hex) { // a rejected colour is dropped once the theme moves on (Reset, another accent)
      hex.value = preset ? "" : t.accent; err.hidden = true; hex.setAttribute("aria-invalid", "false");
    }
    picker.value = set.accent;
    swatch.style.background = set.accent; swatch.style.color = set.on; swatch.dataset.chosen = String(!preset);
    picker.setAttribute("aria-label", preset ? "Custom accent colour" : "Custom accent colour, chosen");
  };

  // Left / Right walk a row of choices (the two modes, the accent swatches); Up / Down (wireMenu) still walk the whole card.
  card.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const group = e.target.closest?.(".appearance__modes, .appearance__accents");
    if (!group) return;
    const all = [...group.children], i = all.indexOf(e.target);
    e.preventDefault();
    all[(i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length]?.focus();
  });
  wireMenu(btn, card, { stayOpen: true });
  for (const type of ["scheme:pref", "scheme:changed", "theme:changed"]) bus.addEventListener(type, sync);
  sync();
}
