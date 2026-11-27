// The "Edit Shape" dialog (Shape flyout → Edit shapes…), laid out like Tableau's: the left pane "Select Data Item" lists the Shape field's members, each with the
// symbol it wears now; the right pane "Select Shape Palette" shows a palette dropdown (Default, Outline, Arrows, Weather) at its upper right over that palette's shapes.
// Select a member, click a shape: it is staged for that member and the selection moves to the next one. Assign Palette stages the palette's shapes for every member in
// list order (repeating from the first when the members outnumber the shapes); Reset hands every member back to its default symbol. Everything is a draft until OK
// (shape-model.js setFieldShapes keeps every limit; `onSave(map)`); Cancel, ✕ and Esc discard. DOM only — member names are shown with textContent.
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { LIMITS } from "../Core/validate.js";
import { memberKey, has } from "./colour-model.js";
import { SHAPE_PALETTES, shapeOf, defaultShapeAt, assignPalette, setFieldShapes } from "./shape-model.js";

let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

/** A filled 20-unit glyph in the ink colour (never colour alone: the shape is the message). */
export function shapeGlyph(d, size = 16) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
  for (const [k, v] of Object.entries({ viewBox: "0 0 20 20", width: size, height: size, fill: "currentColor", "aria-hidden": "true" })) svg.setAttribute(k, String(v));
  p.setAttribute("d", d); svg.append(p);
  return svg;
}

/**
 * `fieldKey` the Shape field's storage key; `members` its drawn members ({ name, raw }); `current` the sheet's whole memberShapes map;
 * `onSave(map)` receives the new whole map; `onClose()` runs after the dialog is gone (OK or not).
 */
export function openShapeDialog({ fieldKey, members, current, onSave, onClose }) {
  const n = ++seq;
  const stored = has(current ?? {}, fieldKey) ? current[fieldKey] : {};
  const shown = members.slice(0, LIMITS.memberColors).map((m, index) => ({ ...m, index, key: memberKey(m.raw), tooLong: memberKey(m.raw).length > LIMITS.memberKey }));
  let draft = { ...stored };                // memberKey → shape key (members that left the view keep theirs until Reset)
  let palette = SHAPE_PALETTES[0];
  let selected = shown.find((m) => !m.tooLong)?.key ?? null; // the member the next shape goes to; one is always chosen, so the shapes are never dead

  const dlg = el("dialog", "dialog shapedlg");
  const title = el("h3", "dialog__title", "Edit shape"); title.id = `shapedlg-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "shapedlg__body");

  // Left: Select Data Item
  const itemsPane = el("section", "shapedlg__pane"); itemsPane.setAttribute("aria-label", "Select data item");
  itemsPane.append(el("div", "shapedlg__head", "Select data item"));
  const list = el("div", "shapedlg__items"); list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Members");
  itemsPane.append(list);

  // Right: Select Shape Palette
  const palPane = el("section", "shapedlg__pane"); palPane.setAttribute("aria-label", "Select shape palette");
  const palHead = el("div", "shapedlg__head shapedlg__head--bar");
  palHead.append(el("span", null, "Select shape palette"));
  const pick = el("select", "input shapedlg__palette"); pick.setAttribute("aria-label", "Shape palette");
  for (const p of SHAPE_PALETTES) pick.append(new Option(p.name, p.key));
  palHead.append(pick);
  const grid = el("div", "shapedlg__grid"); grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Shapes");
  const assign = makeButton("Assign palette", "btn shapedlg__assign");
  assign.title = "Give the members this palette's shapes, in order";
  palPane.append(palHead, grid, assign);
  body.append(itemsPane, palPane);

  const err = el("div", "tipdlg__error shapedlg__error"); err.setAttribute("role", "alert");
  const foot = el("div", "dialog__foot");
  const reset = makeButton("Reset", "btn shapedlg__reset"), cancel = makeButton("Cancel", "btn"), ok = makeButton("OK", "btn btn--primary");
  reset.title = "Every member back to its default shape";
  foot.append(reset, cancel, ok);
  dlg.append(title, body, err, foot);

  const shapeFor = (m) => shapeOf(draft[m.key]) ?? defaultShapeAt(m.index); // the symbol the chart draws: the chosen one, else the one at the member's position
  const select = (key) => { selected = key; err.textContent = ""; paintItems(); paintGrid(); list.querySelector('[aria-selected="true"]')?.focus(); };
  const paintItems = () => {
    list.replaceChildren();
    for (const m of shown) {
      const row = el("button", "shapedlg__item"); row.type = "button"; row.setAttribute("role", "option"); row.dataset.member = m.key;
      row.setAttribute("aria-selected", String(m.key === selected));
      const g = el("span", "shapedlg__now"); g.append(shapeGlyph(shapeFor(m)[3]));
      row.append(g, el("span", "shapedlg__name", m.name));
      if (m.tooLong) { row.disabled = true; row.title = `A member name must be at most ${LIMITS.memberKey} characters to be given a shape.`; }
      else row.addEventListener("click", () => select(m.key)); // the grid marks the shape of the member now selected
      list.append(row);
    }
    if (members.length > LIMITS.memberColors) list.append(el("p", "shapedlg__note", `Only the first ${LIMITS.memberColors} members can be given a shape.`));
  };
  const paintGrid = () => {
    grid.replaceChildren();
    const mine = shown.find((m) => m.key === selected);
    for (const [key, name, , path] of palette.shapes) {
      const b = el("button", "shapedlg__shape"); b.type = "button"; b.title = name; b.dataset.shape = key;
      b.setAttribute("aria-label", mine ? `Shape ${mine.name} ${name}` : name);
      b.setAttribute("aria-pressed", String(mine ? draft[mine.key] === key : false));
      b.append(shapeGlyph(path, 20));
      b.addEventListener("click", () => {
        if (selected == null) return;
        draft = { ...draft, [selected]: key }; err.textContent = "";
        const next = shown.find((m, i) => i > shown.findIndex((x) => x.key === selected) && !m.tooLong); // the next member is the one to give a shape now
        if (next) selected = next.key;
        paintItems(); paintGrid();
        grid.querySelector(`[data-shape="${key}"]`)?.focus(); // the repaint replaced the button: keep the keyboard where it was
        list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
      });
      grid.append(b);
    }
    assign.disabled = !shown.some((m) => !m.tooLong);
  };
  const paint = () => { paintItems(); paintGrid(); };

  list.addEventListener("keydown", (e) => { // Up / Down move the selection, as in any listbox
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const ok = shown.filter((m) => !m.tooLong), at = ok.findIndex((m) => m.key === selected), to = ok[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (!to) return;
    e.preventDefault(); select(to.key);
  });
  pick.addEventListener("change", () => { palette = SHAPE_PALETTES.find((p) => p.key === pick.value) ?? SHAPE_PALETTES[0]; paintGrid(); });
  assign.addEventListener("click", () => { draft = { ...draft, ...assignPalette(palette, shown.filter((m) => !m.tooLong).map((m) => m.key)) }; err.textContent = ""; paint(); });
  reset.addEventListener("click", () => { draft = {}; err.textContent = ""; paint(); });
  const finish = () => { closeDialog(dlg); setTimeout(() => onClose?.(), 0); };
  cancel.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); }); // Esc discards
  ok.addEventListener("click", () => {
    const r = setFieldShapes(current, fieldKey, draft);
    if (!r.ok) { err.textContent = r.error; return; }
    onSave(r.value); finish();
  });
  document.body.append(dlg);
  openDialog(dlg);
  paint();
  list.querySelector('[aria-selected="true"]')?.focus();
}
