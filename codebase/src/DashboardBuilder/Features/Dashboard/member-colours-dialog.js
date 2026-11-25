// The "Edit member colours…" dialog: pick a palette, pick a member, pick one of the palette's colours for it. Everything is
// staged in a draft and applied once by Save (colour-model.js applyMemberDraft keeps every limit); Cancel and Esc discard.
// DOM only — member names are shown with textContent; the swatch hexes are the app's own palettes (data, not CSS).
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { LIMITS } from "../Core/validate.js";
import { PALETTES } from "../Core/theme-model.js";
import { applyMemberDraft, colourOf, memberKey, has } from "./colour-model.js";

const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };

/**
 * `fieldKey` the colour field's storage key; `members` its drawn members ({ name, raw }); `current` the sheet's whole
 * memberColors map; `onSave(map)` receives the new whole map; `onClose()` runs after the dialog is gone (Save or not).
 */
export function openMemberColoursDialog({ fieldKey, members, current, onSave, onClose }) {
  const stored = has(current ?? {}, fieldKey) ? current[fieldKey] : {};
  const shown = members.slice(0, LIMITS.memberColors).map((m) => ({ ...m, key: memberKey(m.raw) }));
  const draft = Object.create(null); // memberKey → "#rrggbb" | null (cleared)
  let clearFirst = false;
  let palette = null; // id of the chosen palette: where the colours come from, never stored
  let selected = null; // the member (key) the next colour goes to

  const dlg = el("dialog", "dialog memcol-dialog");
  const title = el("h3", "dialog__title", "Member colours");
  title.id = "memcol-title";
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body memcol-dialog__body");

  // 1 · Palettes
  const palHead = el("h4", "memcol-head", "Palette");
  const palBox = el("div", "memcol-palettes"); palBox.setAttribute("role", "radiogroup"); palBox.setAttribute("aria-label", "Palette");
  const palBtns = Object.entries(PALETTES).map(([id, p]) => {
    const b = makeButton("", "memcol-palette"); b.setAttribute("role", "radio");
    const strip = el("span", "appearance__strip"); strip.setAttribute("aria-hidden", "true");
    for (const c of p.light) { const s = el("span"); s.style.background = c; strip.append(s); }
    b.append(strip, el("span", "memcol-palette__name", p.label), el("span", "memcol-tick"));
    b.addEventListener("click", () => { palette = id; paint(); });
    palBox.append(b);
    return { id, b };
  });

  // 2 · Members
  const memHead = el("h4", "memcol-head", "Member");
  const memBox = el("div", "memcol-members"); memBox.setAttribute("role", "group"); memBox.setAttribute("aria-label", "Members");
  const rows = shown.map((m) => {
    const row = el("div", "memcol-row");
    const pick = makeButton("", "memcol-member");
    const dot = el("span", "memcol-dot"); dot.setAttribute("aria-hidden", "true");
    pick.append(el("span", "memcol-marker"), dot, el("span", "memcol-member__name", m.name));
    const hex = el("span", "memcol-hex");
    pick.append(hex);
    if (m.key.length > LIMITS.memberKey) { pick.disabled = true; pick.title = `This value is longer than ${LIMITS.memberKey} characters, so it can't be coloured.`; }
    pick.addEventListener("click", () => { selected = m.key; paint(); });
    const reset = makeButton("Reset", "btn btn--ghost memcol-reset");
    reset.setAttribute("aria-label", `Reset the colour of ${m.name}`);
    reset.addEventListener("click", () => { draft[m.key] = null; msg.replaceChildren(); paint(); });
    row.append(pick, reset);
    memBox.append(row);
    return { m, pick, dot, hex, reset };
  });
  const note = el("p", "memcol-note", members.length > shown.length ? `Only the first ${LIMITS.memberColors} members can be coloured.` : (shown.length ? "" : "No members to colour."));
  note.hidden = !note.textContent;

  // 3 · The chosen palette's colours
  const colHead = el("h4", "memcol-head", "Colour");
  const colBox = el("div", "ws-swatches memcol-colours"); colBox.setAttribute("role", "group"); colBox.setAttribute("aria-label", "Colours");
  const swatches = Array.from({ length: 8 }, () => { const b = makeButton("", "ws-swatch memcol-swatch"); b.hidden = true; colBox.append(b); return b; });

  const msg = el("div", "memcol-error"); msg.setAttribute("role", "alert");
  body.append(palHead, palBox, memHead, memBox, note, colHead, colBox, msg);

  const foot = el("div", "dialog__foot");
  const resetAll = makeButton("Reset all", "btn memcol-resetall"), cancel = makeButton("Cancel", "btn"), save = makeButton("Save", "btn btn--primary");
  resetAll.title = "Clear every colour of this field, also those of members no longer in the view";
  foot.append(resetAll, cancel, save);
  dlg.append(title, body, foot);

  // A member's colour as staged: the draft over what is stored (nothing stored once Reset all was pressed).
  const colourNow = (key) => (has(draft, key) ? (draft[key] ?? undefined) : clearFirst ? undefined : colourOf(stored, key));

  function paint() {
    for (const { id, b } of palBtns) b.setAttribute("aria-checked", String(id === palette));
    for (const r of rows) {
      const c = colourNow(r.m.key);
      const on = selected === r.m.key;
      r.pick.setAttribute("aria-pressed", String(on));
      r.pick.classList.toggle("is-selected", on);
      r.dot.style.backgroundColor = c ?? "";
      r.hex.textContent = c ?? "";
      r.reset.disabled = !c;
    }
    const cols = palette ? PALETTES[palette].light : [];
    const cur = selected != null ? colourNow(selected) : undefined;
    const who = rows.find((r) => r.m.key === selected)?.m.name;
    swatches.forEach((b, i) => {
      b.hidden = !cols[i];
      if (!cols[i]) return;
      b.style.backgroundColor = cols[i];
      b.disabled = selected == null;
      b.title = selected == null ? "Select a member first" : "";
      b.setAttribute("aria-label", `${who ? `Colour ${who}` : "Colour"} ${cols[i]}`);
      b.setAttribute("aria-pressed", String(cur === cols[i]));
      b.textContent = cur === cols[i] ? "✓" : "";
    });
    colBox.hidden = !palette;
    colHead.hidden = !palette;
  }

  swatches.forEach((b, i) => b.addEventListener("click", () => {
    if (selected == null || !palette) return;
    draft[selected] = PALETTES[palette].light[i];
    msg.replaceChildren(); paint();
  }));
  resetAll.addEventListener("click", () => { clearFirst = true; for (const k of Object.keys(draft)) delete draft[k]; msg.replaceChildren(); paint(); });

  const finish = () => { closeDialog(dlg); onClose?.(); };
  cancel.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); }); // Esc discards
  save.addEventListener("click", () => {
    const r = applyMemberDraft(current, fieldKey, { ...draft }, clearFirst);
    if (!r.ok) { msg.textContent = r.error; return; }
    onSave(r.value);
    finish();
  });

  paint();
  document.body.append(dlg);
  openDialog(dlg);
  palBtns[0].b.focus();
}
