// P41 — the Theme dialog (Workbook menu → Theme…): an accent (five checked presets or a custom colour)
// and a chart palette. Choices apply live and save with the workbook; a custom colour that can't carry
// white button text is refused with the reason. Swatches are labelled — never colour alone.
import { currentTheme, setTheme } from "../Core/store.js";
import { ACCENTS, PALETTES, DEFAULT_THEME, deriveAccent } from "../Core/theme-model.js";
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { isDark } from "../Core/scheme.js";

export function openThemeDialog() {
  const dark = isDark() ? "dark" : "light";
  const dlg = document.createElement("dialog");
  dlg.className = "dialog theme-dialog";
  dlg.setAttribute("aria-labelledby", "theme-title");
  const head = el("div", "dialog__head");
  const title = el("h2", null, "Theme"); title.id = "theme-title";
  head.append(title);
  const body = el("div", "dialog__body theme-dialog__body");
  const foot = el("div", "dialog__foot");
  const reset = makeButton("Reset to default", "btn");
  const done = makeButton("Done", "btn btn--primary");
  foot.append(reset, done);
  dlg.append(head, body, foot);

  const render = () => {
    const t = currentTheme();
    const custom = !ACCENTS[t.accent];
    body.replaceChildren(accentGroup(t, custom), paletteGroup(t));
  };

  function accentGroup(t, custom) {
    const fs = el("fieldset", "theme-group");
    fs.append(el("legend", "theme-group__title", "Accent — buttons, selected tabs, single-series charts"));
    const list = el("div", "theme-options");
    for (const [id, a] of Object.entries(ACCENTS)) list.append(option("accent", id, a.label, t.accent === id, [a[dark].accent],
      () => setTheme({ ...currentTheme(), accent: id })));
    // Custom: a colour picker + hex field; refused colours explain why and keep the current accent.
    const row = el("label", "theme-option theme-option--custom");
    const radio = el("input"); radio.type = "radio"; radio.name = "accent"; radio.checked = custom;
    const picker = el("input", "theme-picker"); picker.type = "color";
    picker.value = custom ? t.accent : ACCENTS[t.accent][dark].accent;
    picker.setAttribute("aria-label", "Custom accent colour");
    const hex = el("input", "input theme-hex"); hex.type = "text"; hex.value = custom ? t.accent : "";
    hex.placeholder = "#2260bf"; hex.maxLength = 7; hex.setAttribute("aria-label", "Custom accent as #rrggbb");
    const err = el("span", "field-error theme-error"); err.hidden = true; err.setAttribute("role", "alert");
    const tryCustom = (value) => {
      const v = value.trim().toLowerCase();
      const d = deriveAccent(v);
      err.hidden = !d.error; err.textContent = d.error ?? "";
      hex.setAttribute("aria-invalid", String(Boolean(d.error)));
      if (!d.error) setTheme({ ...currentTheme(), accent: v });
    };
    picker.addEventListener("change", () => { hex.value = picker.value; tryCustom(picker.value); });
    hex.addEventListener("change", () => tryCustom(hex.value));
    radio.addEventListener("change", () => tryCustom(hex.value || picker.value));
    row.append(radio, picker, el("span", "theme-option__label", "Custom"), hex);
    list.append(row, err);
    fs.append(list);
    return fs;
  }

  function paletteGroup(t) {
    const fs = el("fieldset", "theme-group");
    fs.append(el("legend", "theme-group__title", "Chart colours — series and categories"));
    const list = el("div", "theme-options");
    for (const [id, p] of Object.entries(PALETTES)) list.append(option("palette", id, p.label, t.palette === id, p[dark],
      () => setTheme({ ...currentTheme(), palette: id })));
    fs.append(list);
    return fs;
  }

  function option(name, value, label, checked, swatches, onPick) {
    const row = el("label", "theme-option");
    const radio = el("input"); radio.type = "radio"; radio.name = name; radio.value = value; radio.checked = checked;
    radio.addEventListener("change", () => { if (radio.checked) { onPick(); render(); } });
    const sw = el("span", "theme-swatches"); sw.setAttribute("aria-hidden", "true");
    // Swatch colours are the theme's own token values (theme-model.js), shown as data — not styling.
    for (const c of swatches) { const s = el("span", "theme-swatch"); s.style.background = c; sw.append(s); }
    row.append(radio, sw, el("span", "theme-option__label", label));
    return row;
  }

  reset.addEventListener("click", () => { setTheme(DEFAULT_THEME); render(); });
  const finish = () => closeDialog(dlg);
  done.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  render();
  document.body.append(dlg);
  openDialog(dlg);
  body.querySelector("input:checked")?.focus();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
