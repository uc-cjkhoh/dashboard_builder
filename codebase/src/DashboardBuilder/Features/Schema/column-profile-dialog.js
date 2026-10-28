// The column profile dialog (DOM only; every rule lives in column-profile-model.js): one field's properties, rows / distinct /
// null share / min / max tiles and its most frequent values, read-only, from POST .../profile. Opened from a field row on a
// canvas card. Escape, Close and the X close it; closing cancels a request still in flight. Text is always set with textContent.
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { makeButton, openDialog, closeDialog, toast } from "../Core/ui.js";
import { profileRequest, summarize } from "./column-profile-model.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let seq = 0;

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}.`, "info"); }
  catch { toast("Couldn't copy — your browser blocked clipboard access.", "danger"); }
}

/** Profile one column of one table. `column` is `{ name, type, category }` as the catalog described it. */
export function openColumnProfile(db, table, column) {
  const id = `col-profile-${++seq}`;
  const dlg = el("dialog", "dialog col-profile");
  dlg.setAttribute("aria-labelledby", `${id}-title`);
  const head = el("div", "col-profile__head");
  const titles = el("div", "col-profile__titles");
  const h = el("h2", "dialog__title col-profile__title", column.name); h.id = `${id}-title`;
  titles.append(h, el("p", "col-profile__sub", `${db}.${table} · ${column.type}`));
  const x = makeButton("", "iconbtn"); x.append(icon("close")); x.setAttribute("aria-label", "Close");
  head.append(titles, x);

  const body = el("div", "col-profile__body");
  const status = el("p", "col-profile__status", "Profiling…"); status.setAttribute("role", "status");
  body.append(status);

  const foot = el("div", "dialog__foot col-profile__foot");
  const copyName = makeButton("Copy name", "btn"); copyName.prepend(icon("duplicate", { size: 14 }));
  const copyValues = makeButton("Copy values", "btn"); copyValues.prepend(icon("duplicate", { size: 14 })); copyValues.disabled = true;
  copyValues.title = "Copies the top values shown, one per line (NULL, empty and cut values are left out)";
  const close = makeButton("Close", "btn btn--primary");
  foot.append(copyName, copyValues, close);
  dlg.append(head, body, foot);
  document.body.append(dlg);

  const ctl = new AbortController();
  const finish = () => { ctl.abort(); closeDialog(dlg); };
  x.addEventListener("click", finish); close.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  copyName.addEventListener("click", () => copy(column.name, "the field name"));
  openDialog(dlg);
  close.focus();

  let req;
  try { req = profileRequest(column.name); } catch (err) { showError(status, err.message); return dlg; }
  api.profile(db, table, req, { signal: ctl.signal }).then((p) => {
    const s = summarize(p);
    copyValues.disabled = s.copyValues === "";
    copyValues.addEventListener("click", () => copy(s.copyValues, "the values"));
    body.replaceChildren(...sections(s));
  }).catch((err) => {
    if (err?.name === "AbortError") return;
    showError(status, err.message);
    toast(err.message, "danger");
  });
  return dlg;
}

function showError(status, message) {
  const glyph = el("span", "col-profile__glyph"); glyph.setAttribute("aria-hidden", "true"); glyph.append(icon("warning", { size: 14 }));
  status.classList.add("col-profile__status--error");
  status.replaceChildren(glyph, document.createTextNode(" " + message));
}

function sections(s) {
  const out = [];
  const dl = el("dl", "col-profile__props");
  for (const [k, v] of s.details) { dl.append(el("dt", "", k), el("dd", "", v)); }
  out.push(dl);
  if (s.sampleNote) {
    const p = el("p", "col-profile__note"); const g = el("span", "col-profile__glyph"); g.setAttribute("aria-hidden", "true"); g.append(icon("info", { size: 14 }));
    p.append(g, document.createTextNode(" " + s.sampleNote)); out.push(p);
  }
  const tiles = el("div", "col-profile__tiles");
  for (const t of s.tiles) {
    const tile = el("div", "col-profile__tile");
    tile.append(el("span", "col-profile__tile-label", t.label), el("span", "col-profile__tile-value", t.value));
    if (t.note) tile.append(el("span", "col-profile__tile-note", t.note));
    tiles.append(tile);
  }
  out.push(tiles);
  out.push(el("h3", "col-profile__h", "Most frequent values"));
  if (s.empty || s.top.length === 0) { out.push(el("p", "col-profile__status", "No rows to profile.")); return out; }
  const list = el("ol", "col-profile__top");
  for (const t of s.top) {
    const li = el("li", `col-profile__row col-profile__row--${t.kind}`);
    const label = el("span", "col-profile__label", t.label); label.title = t.label;
    const bar = el("span", "col-profile__bar"); bar.setAttribute("aria-hidden", "true");
    const fill = el("span", "col-profile__fill"); fill.style.setProperty("--w", `${t.bar}%`); bar.append(fill);
    li.append(label, bar, el("span", "col-profile__count", t.countText), el("span", "col-profile__share", t.shareText));
    list.append(li);
  }
  out.push(list);
  return out;
}
