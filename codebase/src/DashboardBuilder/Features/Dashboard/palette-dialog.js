// The "Create palette…" dialog, opened from the Edit member colours dialog: a name and a row of colours, in the order they are made — the
// order matters, because applying a palette gives the n-th member the n-th colour. "+" adds a colour (a generated one, so each new swatch
// differs); the chosen swatch is edited with the colour picker or a #rrggbb, and removed with ✕ (one colour always stays). Create stays
// disabled until Core/palette-model.js checkNewPalette passes (name: required, ≤ 40, unique; 1–24 colours); nothing is stored here —
// `onCreate(palette)` hands the palette to the Edit member colours dialog, which stages it until its own Save (D166).
// `existing` are the palettes that dialog holds right now, so a name made earlier in the same session is also a duplicate.
// DOM only — the palette name is user text (value / textContent); the swatch hexes are data, not CSS.
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { LIMITS } from "../Core/validate.js";
import { categoryColour } from "../Core/theme-model.js";
import { isDark } from "../Core/scheme.js";
import { icon } from "../Core/icons.js";
import { luminance } from "./contrast.js";
import { isHex6, normHex, checkNewPalette, newPaletteDraft, addColour, setColour, removeColour, selectColour } from "../Core/palette-model.js";

const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

export function openPaletteDialog({ existing = [], onCreate, onClose }) {
  const dark = isDark();
  let draft = newPaletteDraft(categoryColour(0, dark));
  let touched = false; // errors about the name stay quiet until the name has been typed in

  const dlg = el("dialog", "dialog palcreate-dialog");
  const head = el("div", "memcol-band memcol-band--head");
  const title = el("h3", "ws-toolpanel__title"); title.id = "palcreate-title";
  title.append(icon("plus"), " Create palette");
  dlg.setAttribute("aria-labelledby", title.id);
  const close = el("button", "iconbtn memcol-close"); close.type = "button"; close.append(icon("close")); close.setAttribute("aria-label", "Close without creating");
  head.append(title, close);

  const body = el("div", "palcreate-body");
  const nameIn = el("input", "input palcreate-name"); nameIn.type = "text"; nameIn.maxLength = LIMITS.paletteName; nameIn.placeholder = "Palette name";
  nameIn.autocomplete = "off"; nameIn.spellcheck = false; nameIn.setAttribute("aria-label", "Palette name");

  // The colours, in creation order: one roving tab stop (arrows move the choice), a tick on the chosen one — never an outline alone.
  const row = el("div", "palcreate-swatches"); row.setAttribute("role", "group"); row.setAttribute("aria-label", "Palette colours");
  const addBtn = el("button", "iconbtn palcreate-add"); addBtn.type = "button"; addBtn.append(icon("plus"));
  addBtn.title = "Add colour"; addBtn.setAttribute("aria-label", "Add colour");

  // The chosen colour: the colour picker and a #rrggbb, as the Edit member colours dialog's custom colour.
  const edit = el("div", "palcreate-edit");
  const cswatch = el("label", "memcol-custom__swatch");
  const picker = el("input", "memcol-custom__picker"); picker.type = "color"; picker.setAttribute("aria-label", "Colour");
  cswatch.append(picker);
  const hexIn = el("input", "input memcol-custom__hex"); hexIn.type = "text"; hexIn.placeholder = "#rrggbb"; hexIn.maxLength = 7; hexIn.spellcheck = false; hexIn.autocomplete = "off";
  hexIn.setAttribute("aria-label", "Colour as #rrggbb");
  const rm = el("button", "iconbtn palcreate-remove"); rm.type = "button"; rm.append(icon("close", { size: 16 }));
  edit.append(cswatch, hexIn, rm);

  const err = el("div", "memcol-error"); err.setAttribute("role", "alert");
  body.append(nameIn, row, edit, err);

  const foot = el("div", "dialog__foot memcol-band memcol-band--foot");
  const cancel = makeButton("Cancel", "btn"), create = makeButton("Create", "btn btn--primary");
  foot.append(cancel, create);
  dlg.append(head, body, foot);

  const result = () => checkNewPalette({ name: nameIn.value, colours: draft.colours }, existing);
  const showErrors = (list) => err.replaceChildren(...list.map((t) => el("div", null, t)));

  function paint({ syncHex = true } = {}) {
    const cells = draft.colours.map((c, i) => {
      const b = makeButton("", "ws-swatch memcol-cell");
      b.append(icon("check")); // drawn once; CSS shows it while the swatch is aria-pressed
      b.style.backgroundColor = c; b.classList.toggle("is-light", luminance(c) > 0.179);
      b.setAttribute("aria-label", `Colour ${i + 1} of ${draft.colours.length}, ${c}`);
      b.setAttribute("aria-pressed", String(i === draft.selected));
      b.tabIndex = i === draft.selected ? 0 : -1;
      b.addEventListener("click", () => { draft = selectColour(draft, i); paint(); row.children[i].focus(); }); // paint rebuilds the row: the focus goes to the new button
      b.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (d) { e.preventDefault(); const n = i + d; if (n >= 0 && n < draft.colours.length) { draft = selectColour(draft, n); paint(); row.children[n].focus(); } return; }
        if ((e.key === "Delete" || e.key === "Backspace") && draft.colours.length > 1) { e.preventDefault(); removeSelected(); }
      });
      return b;
    });
    row.replaceChildren(...cells, addBtn);
    addBtn.disabled = draft.colours.length >= LIMITS.paletteColours;
    addBtn.title = addBtn.disabled ? `A palette holds at most ${LIMITS.paletteColours} colours` : "Add colour";
    const cur = draft.colours[draft.selected];
    cswatch.style.backgroundColor = cur; picker.value = cur;
    if (syncHex || document.activeElement !== hexIn) hexIn.value = cur;
    rm.disabled = draft.colours.length <= 1;
    rm.title = rm.disabled ? "A palette keeps at least one colour" : "Remove colour";
    rm.setAttribute("aria-label", `Remove colour ${cur}`);
    const r = result();
    create.disabled = !r.ok;
    if (touched) showErrors(r.ok ? [] : r.errors);
  }
  function removeSelected() {
    const at = draft.selected;
    draft = removeColour(draft, at); paint();
    row.children[draft.selected]?.focus();
  }

  addBtn.addEventListener("click", () => { draft = addColour(draft, categoryColour(draft.colours.length, dark)); paint(); row.children[draft.selected]?.focus(); });
  rm.addEventListener("click", removeSelected);
  picker.addEventListener("input", () => { draft = setColour(draft, picker.value); paint(); });
  hexIn.addEventListener("input", () => {
    if (isHex6(hexIn.value)) { draft = setColour(draft, hexIn.value); err.replaceChildren(); paint({ syncHex: false }); }
  });
  hexIn.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!isHex6(hexIn.value)) { showErrors(["Enter a colour as #rrggbb."]); return; }
    hexIn.value = normHex(hexIn.value); draft = setColour(draft, hexIn.value); paint();
  });
  hexIn.addEventListener("blur", () => { if (!isHex6(hexIn.value)) hexIn.value = draft.colours[draft.selected]; }); // a half-typed colour never stays
  nameIn.addEventListener("input", () => { touched = true; paint(); });
  nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });

  const finish = () => { closeDialog(dlg); onClose?.(); };
  function submit() {
    touched = true;
    const r = result();
    if (!r.ok) { paint(); nameIn.focus(); return; }
    onCreate?.(r.palette);
    finish();
  }
  create.addEventListener("click", submit);
  cancel.addEventListener("click", finish);
  close.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); }); // Esc closes this dialog only; a disconnect closes it through here too (Core/overlays.js)

  paint();
  document.body.append(dlg);
  openDialog(dlg);
  nameIn.focus();
}
