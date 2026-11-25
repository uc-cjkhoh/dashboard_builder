// The "Edit member colours…" dialog, landscape and split at the golden ratio: the left pane (38.2%) is the picker — palettes, each under its title
// with a hairline between them (the generated Default first: a sample of the first 24 colours of theme-model.js categoryColour, in ascending hex
// order; then the palettes the workbook holds, made here in the Create palette dialog: palette-dialog.js, Core/palette-model.js), one custom colour (the colour
// picker, or a #rrggbb) and Create palette… — the right pane (61.8%) lists the members, with a search box above a long list. A member without a
// colour of its own shows the one the chart draws for it (also generated: the n-th member gets the n-th colour, however many there are).
// Select a member, click a swatch: that colour is staged for it and the selection moves to the next shown member, so a run of members is coloured
// by clicking swatches alone. Click a palette's title: its colours are staged for every member in list order, repeating from the first when the
// members outnumber the colours (the Default's title is Reset all). Reset (per member) and Reset all hand a member back to its generated colour.
// Everything — colours, created palettes, removed palettes — is staged in a draft and applied once by Save (colour-model.js applyMemberDraft keeps
// every limit; `onSave(map, palettes)`); Cancel, ✕ and Esc discard. The header and footer are the Color flyout's recessed bands.
// DOM only — member and palette names are shown with textContent; the swatch hexes are data (generated or made by the user), not CSS.
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { LIMITS } from "../Core/validate.js";
import { categoryColour, categoryColours } from "../Core/theme-model.js";
import { isDark } from "../Core/scheme.js";
import { icon } from "../Core/icons.js";
import { applyMemberDraft, colourOf, memberKey, has } from "./colour-model.js";
import { luminance } from "./contrast.js";
import { DEFAULT_PALETTE_NAME, isHex6, normHex, assignPalette } from "../Core/palette-model.js";
import { openPaletteDialog } from "./palette-dialog.js";

const SAMPLE = 24; // generated colours offered as swatches
const FILTER_MIN = 8; // more members than this and the list can outgrow the pane at its default size: the search box appears

const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

/**
 * `fieldKey` the colour field's storage key; `members` its drawn members ({ name, raw }); `current` the sheet's whole
 * memberColors map; `palettes` the workbook's palettes ([{ name, colours }]); `onSave(map, palettes)` receives the new whole map and the
 * palettes as they stand after the dialog's creations and removals; `onClose()` runs after the dialog is gone (Save or not).
 */
export function openMemberColoursDialog({ fieldKey, members, current, palettes: storedPalettes = [], onSave, onClose }) {
  const stored = has(current ?? {}, fieldKey) ? current[fieldKey] : {};
  const shown = members.slice(0, LIMITS.memberColors).map((m) => ({ ...m, key: memberKey(m.raw), tooLong: memberKey(m.raw).length > LIMITS.memberKey }));
  const draft = Object.create(null); // memberKey → "#rrggbb" | null (cleared)
  let clearFirst = false;
  let selected = shown.find((m) => !m.tooLong)?.key ?? null; // the member the next colour goes to; one is always chosen, so the swatches are never dead

  const dlg = el("dialog", "dialog memcol-dialog");

  // Header band: the Color flyout's recessed title band
  const head = el("div", "memcol-band memcol-band--head");
  const title = el("h3", "ws-toolpanel__title");
  title.id = "memcol-title";
  title.append(icon("color"), " Member colours");
  dlg.setAttribute("aria-labelledby", title.id);
  const close = el("button", "iconbtn memcol-close"); close.type = "button"; close.append(icon("close")); close.setAttribute("aria-label", "Close without saving");
  head.append(title, close);

  const body = el("div", "memcol-body");

  // Left pane · the picker: each palette under its title (the generated Default, then the ones the workbook holds), the custom colour, Create palette…
  const dark = isDark();
  const palPane = el("section", "memcol-pane memcol-pane--colours"); palPane.setAttribute("aria-label", "Colours");
  const palettes = storedPalettes.map((p) => ({ name: p.name, colours: [...p.colours] })); // staged: Save stores them, Cancel drops every change
  const cells = []; // { b, colour, palette }
  const appliers = []; // { b, tick, colours? }: a palette's title, the button that applies it to every member (no colours: the Default, which is Reset all)
  const palList = el("div", "memcol-palettes");
  const colourable = () => shown.filter((m) => !m.tooLong); // the members a colour can be stored for
  const byHex = (a, z) => parseInt(a.slice(1), 16) - parseInt(z.slice(1), 16);
  const generated = categoryColours(SAMPLE, dark);
  const inkOf = (b, c) => b.classList.toggle("is-light", luminance(c) > 0.179); // 0.179: where black and white ink read equally well; the tick takes the one that reads
  const stage = (c) => { if (selected == null) return false; draft[selected] = c; msg.replaceChildren(); return true; };
  const goNext = () => { const next = advance(); paint(true); next?.row.scrollIntoView({ block: "nearest" }); }; // the colour is set: the next shown member is the one to colour now
  function group(name, colours, removable) {
    const g = el("div", "memcol-palette"); g.setAttribute("role", "group"); g.setAttribute("aria-label", name);
    const head = el("div", "memcol-palette__head");
    const apply = makeButton("", "memcol-palette__apply");
    const tick = el("span", "memcol-tick"); tick.setAttribute("aria-hidden", "true"); tick.append(icon("check"));
    apply.append(el("span", "memcol-palette__name", name), tick);
    apply.title = `Apply ${name} to every member`; apply.setAttribute("aria-label", apply.title);
    head.append(apply);
    let rm = null;
    if (removable) {
      rm = el("button", "iconbtn memcol-palette__remove"); rm.type = "button"; rm.append(icon("close", { size: 16 }));
      rm.title = "Remove palette"; rm.setAttribute("aria-label", `Remove palette ${name}`);
      head.append(rm);
    }
    const swatches = el("div", "memcol-swatches");
    for (const c of [...colours].sort(byHex)) { // ascending hex on screen; Apply keeps the palette's own order
      const b = makeButton("", "ws-swatch memcol-cell");
      b.style.backgroundColor = c; inkOf(b, c); b.append(icon("check")); // the tick is drawn once and shown by aria-pressed (CSS)
      b.addEventListener("click", () => { if (stage(c)) goNext(); });
      swatches.append(b);
      cells.push({ b, colour: c, palette: name });
    }
    g.append(head, swatches);
    return { g, apply, tick, rm };
  }
  function renderPalettes() {
    cells.length = 0; appliers.length = 0;
    const groups = [];
    const d = group(DEFAULT_PALETTE_NAME, generated, false);
    d.apply.addEventListener("click", clearAll);
    appliers.push({ b: d.apply, tick: d.tick });
    groups.push(d.g);
    for (const p of palettes) {
      const x = group(p.name, p.colours, true);
      x.apply.addEventListener("click", () => { Object.assign(draft, assignPalette(p.colours, colourable().map((m) => m.key))); msg.replaceChildren(); paint(); });
      x.rm.addEventListener("click", () => { palettes.splice(palettes.indexOf(p), 1); renderPalettes(); paint(); createBtn.focus(); }); // a draft until Save: no confirm (coding-standards § 13)
      appliers.push({ b: x.apply, tick: x.tick, colours: p.colours });
      groups.push(x.g);
    }
    palList.replaceChildren(...groups);
    syncCreate();
  }
  // Custom colour: a swatch that opens the browser's colour picker, and the #rrggbb it holds. A whole valid hex applies as it is typed
  // (the member stays selected); Enter, or closing the picker, sets it and moves on.
  const custom = el("div", "memcol-custom");
  const cswatch = el("label", "memcol-custom__swatch");
  const picker = el("input", "memcol-custom__picker"); picker.type = "color"; picker.setAttribute("aria-label", "Custom colour");
  const ctick = el("span", "memcol-custom__tick"); ctick.setAttribute("aria-hidden", "true"); ctick.append(icon("check"));
  cswatch.append(ctick, picker);
  const hexIn = el("input", "input memcol-custom__hex"); hexIn.type = "text"; hexIn.placeholder = "#rrggbb"; hexIn.maxLength = 7; hexIn.spellcheck = false; hexIn.autocomplete = "off";
  hexIn.setAttribute("aria-label", "Custom colour as #rrggbb");
  custom.append(cswatch, hexIn);
  picker.addEventListener("input", () => { if (stage(picker.value)) paint(); });
  picker.addEventListener("change", () => { if (stage(picker.value)) goNext(); });
  hexIn.addEventListener("input", () => { if (isHex6(hexIn.value) && stage(normHex(hexIn.value))) paint(); else msg.replaceChildren(); });
  hexIn.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = hexIn.value.trim();
    if (!v) return;
    if (!isHex6(v)) { msg.textContent = "Enter a colour as #rrggbb."; return; }
    hexIn.value = normHex(v);
    if (stage(normHex(v))) goNext();
  });
  // Create palette…: opens the Create palette dialog (palette-dialog.js). The palette it makes is staged here, like a removal: Save stores it.
  const createBtn = makeButton("", "btn btn--ghost memcol-create__open");
  const createLabel = el("span", "memcol-create__label"); createLabel.append(icon("plus", { size: 16 }), el("span", null, "Create palette\u2026"));
  createBtn.append(createLabel); // icon and label as one centred group (a wrapper, so buttons.css's uneven padding for a button that starts with an icon does not apply)
  const syncCreate = () => { // at the limit the button says why, rather than open a dialog that can only refuse
    const full = palettes.length >= LIMITS.palettes;
    createBtn.disabled = full;
    createBtn.title = full ? `A workbook can hold at most ${LIMITS.palettes} palettes. Remove one to create another.` : "";
  };
  createBtn.addEventListener("click", () => {
    let made = false;
    openPaletteDialog({
      existing: palettes, // the staged ones, so a name made in this session is also a duplicate
      onCreate: (p) => { palettes.push(p); made = true; msg.replaceChildren(); renderPalettes(); paint(); },
      onClose: () => (made ? appliers.at(-1)?.b : createBtn)?.focus(), // the new palette's title, else back on the button
    });
  });
  // The palettes and the custom colour scroll in the body; Create palette… is pinned below them, full width.
  const paneBody = el("div", "memcol-pane__body"); paneBody.append(palList, custom);
  const paneFoot = el("div", "memcol-pane__foot"); paneFoot.append(createBtn);
  palPane.append(paneBody, paneFoot);
  renderPalettes();

  // Right pane · the members
  const memPane = el("section", "memcol-pane memcol-pane--members"); memPane.setAttribute("aria-label", "Members");
  const search = el("input", "input memcol-search"); search.type = "search"; search.autocomplete = "off"; search.spellcheck = false; search.maxLength = 100;
  search.placeholder = "Search members"; search.setAttribute("aria-label", "Search members");
  search.hidden = shown.length <= FILTER_MIN;
  const scroll = el("div", "memcol-scroll"); // the list scrolls under the search box
  const list = el("div", "memcol-members");
  const rows = shown.map((m, i) => {
    const row = el("div", "memcol-row");
    const pick = makeButton("", "memcol-member");
    const dot = el("span", "memcol-dot"); dot.setAttribute("aria-hidden", "true");
    const hex = el("span", "memcol-hex");
    const nameEl = el("span", "memcol-member__name", m.name);
    pick.append(dot, nameEl, hex);
    if (m.tooLong) pick.title = `This value is longer than ${LIMITS.memberKey} characters, so it can't be coloured.`; // a name that fits needs no tooltip repeating it; a clipped one gets it below
    pick.disabled = m.tooLong;
    pick.addEventListener("click", () => { selected = m.key; paint(); });
    const reset = el("button", "iconbtn memcol-reset"); reset.type = "button"; reset.append(icon("refresh"));
    reset.tabIndex = -1; // keyboard: Delete on the member does the same
    reset.title = "Reset"; reset.setAttribute("aria-label", `Reset the colour of ${m.name}`);
    const clear = () => { draft[m.key] = null; msg.replaceChildren(); paint(); };
    reset.addEventListener("click", clear);
    pick.addEventListener("keydown", (e) => {
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); clear(); return; }
      const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      let n = rows.findIndex((r) => r.m.key === m.key) + d;
      while (rows[n] && (rows[n].m.tooLong || rows[n].row.hidden)) n += d;
      if (rows[n]) { selected = rows[n].m.key; paint(); rows[n].pick.focus(); }
    });
    row.append(pick, reset);
    list.append(row);
    return { m, row, pick, nameEl, dot, hex, reset, auto: categoryColour(i, dark) }; // auto: the colour the chart draws for it while it has none of its own
  });
  const note = el("p", "memcol-note", members.length > shown.length ? `Only the first ${LIMITS.memberColors} members can be coloured.` : (shown.length ? "" : "No members to colour."));
  note.hidden = !note.textContent;
  const none = el("p", "memcol-note", "No members match."); none.hidden = true; none.setAttribute("role", "status");
  const msg = el("div", "memcol-error"); msg.setAttribute("role", "alert");
  scroll.append(list, note, none);
  memPane.append(search, scroll, msg);

  body.append(palPane, memPane);

  // Footer band: the same recessed band, a hairline above
  const foot = el("div", "dialog__foot memcol-band memcol-band--foot");
  const resetAll = makeButton("Reset all", "btn memcol-resetall"), cancel = makeButton("Cancel", "btn"), save = makeButton("Save", "btn btn--primary");
  resetAll.title = "Clear every colour of this field, also those of members no longer in the view";
  foot.append(resetAll, cancel, save);
  dlg.append(head, body, foot);

  // A member's colour as staged: the draft over what is stored (nothing stored once Reset all was pressed).
  const colourNow = (key) => (has(draft, key) ? (draft[key] ?? undefined) : clearFirst ? undefined : colourOf(stored, key));

  const shownRows = () => rows.filter((r) => !r.row.hidden && !r.m.tooLong); // the members a colour can go to right now

  // The member after the selected one that is shown and can be coloured becomes the selected one; none after it: the selection stays.
  function advance() {
    const at = rows.findIndex((r) => r.m.key === selected);
    const next = shownRows().find((r) => rows.indexOf(r) > at);
    if (next) selected = next.m.key;
    return next;
  }

  // Search: a member shows when its name contains the text (any case). It only narrows the list.
  function applyFilter() {
    const q = search.value.trim().toLocaleLowerCase();
    for (const r of rows) r.row.hidden = !!q && !r.m.name.toLocaleLowerCase().includes(q);
    none.hidden = !q || rows.some((r) => !r.row.hidden);
    if (!shownRows().some((r) => r.m.key === selected)) selected = shownRows()[0]?.m.key ?? null; // never a selected member out of sight
    paint();
  }
  search.addEventListener("input", applyFilter);

  function paint(syncField = false) { // syncField: also rewrite the #rrggbb field although it has focus (the selection just moved on)
    for (const r of rows) {
      const c = colourNow(r.m.key);
      const on = selected === r.m.key;
      r.pick.setAttribute("aria-pressed", String(on));
      r.pick.classList.toggle("is-selected", on);
      r.pick.tabIndex = on ? 0 : -1; // the list is one tab stop (roving)
      r.dot.style.backgroundColor = c ?? r.auto; // its own colour, else the generated one the chart draws
      r.hex.textContent = c ?? ""; // a hex and Reset only once the member has a colour of its own
      r.reset.hidden = !c;
    }
    // A tooltip only where the ellipsis clips the name (the hex appearing, a search or the stacked layout can change that), after the writes above.
    for (const r of rows) if (!r.m.tooLong && !r.row.hidden) { const clipped = r.nameEl.scrollWidth > r.nameEl.clientWidth; if (clipped) r.pick.title = r.m.name; else r.pick.removeAttribute("title"); }
    // A palette reads as applied when every colourable member holds the colour the palette would give it (the Default: none holds a colour of its own).
    const some = colourable();
    for (const a of appliers) {
      const on = some.length > 0 && some.every((m, i) => (a.colours ? colourNow(m.key) === a.colours[i % a.colours.length] : colourNow(m.key) === undefined));
      a.b.disabled = !some.length;
      a.b.setAttribute("aria-pressed", String(on));
    }
    const cur = selected != null ? colourNow(selected) : undefined;
    const row = rows.find((r) => r.m.key === selected);
    const who = row?.m.name;
    for (const { b, colour, palette } of cells) {
      b.disabled = selected == null;
      b.setAttribute("aria-label", `${who ? `Colour ${who}` : "Colour"} ${colour}, ${palette}`);
      b.setAttribute("aria-pressed", String(cur === colour));
    }
    // The custom colour shows the selected member's colour (its own, else the generated one); ticked when its own is not one of the swatches.
    const shownColour = cur ?? row?.auto;
    const own = !!cur && !cells.some((c) => c.colour === cur);
    picker.disabled = hexIn.disabled = selected == null;
    if (shownColour) { cswatch.style.backgroundColor = shownColour; picker.value = shownColour; cswatch.classList.toggle("is-light", luminance(shownColour) > 0.179); }
    else cswatch.style.backgroundColor = "";
    cswatch.dataset.chosen = String(own);
    picker.setAttribute("aria-label", own ? "Custom colour, chosen" : "Custom colour");
    if (syncField || document.activeElement !== hexIn) hexIn.value = cur ?? ""; // not while it is being typed in
  }

  function clearAll() { clearFirst = true; for (const k of Object.keys(draft)) delete draft[k]; msg.replaceChildren(); paint(); } // Reset all, and the Default's title
  resetAll.addEventListener("click", clearAll);

  const finish = () => { closeDialog(dlg); onClose?.(); };
  cancel.addEventListener("click", finish);
  close.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); }); // Esc discards
  save.addEventListener("click", () => {
    const r = applyMemberDraft(current, fieldKey, { ...draft }, clearFirst);
    if (!r.ok) { msg.textContent = r.error; return; }
    onSave(r.value, palettes.map((p) => ({ name: p.name, colours: [...p.colours] })));
    finish();
  });

  paint();
  document.body.append(dlg);
  openDialog(dlg);
  (rows.find((r) => r.m.key === selected)?.pick ?? close).focus();
}
