// The column profile dialog (DOM only; every rule lives in column-profile-model.js): one field's properties, rows / distinct /
// null share / min / max tiles and its most frequent values, read-only, from POST .../profile. Opened from a field row on a
// canvas card. Escape, Close and the X close it; closing cancels a request still in flight. Text is always set with textContent.
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { makeButton, openDialog, closeDialog, toast, copyText } from "../Core/ui.js";
import { profileRequest, summarize } from "./column-profile-model.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let seq = 0;

/** Profile one column of one table. `column` is `{ name, type, category }` as the catalog (or the card's custom SQL) described it; `source` is that SQL (`sqlWire`) for a custom SQL card. */
export function openColumnProfile(db, table, column, source = null) {
  const id = `col-profile-${++seq}`;
  const dlg = el("dialog", "dialog col-profile");
  dlg.setAttribute("aria-labelledby", `${id}-title`);
  const head = el("div", "col-profile__head");
  const titles = el("div", "col-profile__titles");
  const h = el("h2", "dialog__title col-profile__title", column.name); h.id = `${id}-title`;
  const sub = el("p", "col-profile__sub", `${db}.${table} · ${column.type}`); sub.title = sub.textContent;
  titles.append(h, sub);
  const x = makeButton("", "iconbtn"); x.append(icon("close")); x.setAttribute("aria-label", "Close");
  head.append(titles, x);

  const body = el("div", "col-profile__body");
  const status = el("p", "col-profile__status col-profile__status--busy", "Profiling…"); status.setAttribute("role", "status");
  const spin = el("span", "col-profile__glyph"); spin.setAttribute("aria-hidden", "true"); spin.append(icon("refresh", { size: 14 }));
  status.prepend(spin);
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
  copyName.addEventListener("click", () => copyText(column.name, "the field name"));
  openDialog(dlg);
  close.focus();

  let req;
  try { req = profileRequest(column.name, undefined, source); } catch (err) { showError(status, err.message); return dlg; }
  api.profile(db, table, req, { signal: ctl.signal }).then((p) => {
    const s = summarize(p);
    copyValues.disabled = s.copyValues === "";
    copyValues.addEventListener("click", () => copyText(s.copyValues, "the values"));
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
  status.classList.remove("col-profile__status--busy"); status.classList.add("col-profile__status--error");
  status.replaceChildren(glyph, document.createTextNode(message));
}

const RANGE = new Set(["Min", "Max"]);

// Related figures share one cell. Order: the reading notes (a caveat comes before the figures it qualifies), the field's properties, its size (rows / distinct / nulls), its range (min / max), the frequent values.
function sections(s) {
  const out = [];
  const cell = (kind) => { const c = el("div", `col-profile__cell col-profile__cell--${kind}`); c.style.setProperty("--i", out.length); out.push(c); return c; };
  const stat = (t) => {
    const c = el("div", "col-profile__tile");
    const val = el("span", "col-profile__tile-value", t.value); val.title = t.value;
    const lab = el("div", "col-profile__tile-text"); lab.append(el("span", "col-profile__tile-label", t.label));
    if (t.note) lab.append(el("span", "col-profile__tile-note", t.note));
    c.append(lab, val);
    return c;
  };
  const notes = [s.sampleNote, s.cutNote].filter(Boolean);
  if (notes.length) {
    const c = cell("note");
    for (const text of notes) {
      const line = el("p", "col-profile__note-line"); const g = el("span", "col-profile__glyph"); g.setAttribute("aria-hidden", "true"); g.append(icon("info", { size: 14 }));
      line.append(g, document.createTextNode(text)); c.append(line);
    }
  }
  const dl = el("dl", "col-profile__props");
  for (const [k, v, tip] of s.details) { const dd = el("dd", "", v); dd.title = tip ?? v; dl.append(el("dt", "", k), dd); }
  cell("details").append(dl);
  const size = s.tiles.filter((t) => !RANGE.has(t.label)), range = s.tiles.filter((t) => RANGE.has(t.label));
  const sizeCell = cell("size"); sizeCell.append(...size.map(stat));
  if (range.length) { const c = cell("range"); c.append(...range.map(stat)); }
  const freq = cell("top");
  freq.append(el("h3", "col-profile__h", "Most frequent values"));
  if (s.empty || s.top.length === 0) { freq.append(el("p", "col-profile__status", "No rows to profile.")); return out; }
  const leader = s.top.findIndex((t) => t.kind === "value");
  const list = el("ol", "col-profile__top");
  for (const [i, t] of s.top.entries()) {
    const li = el("li", `col-profile__row col-profile__row--${t.kind}${i === leader ? " col-profile__row--lead" : ""}`);
    const label = el("span", "col-profile__label", t.label); label.title = t.label;
    const fill = el("span", "col-profile__fill"); fill.setAttribute("aria-hidden", "true"); fill.style.setProperty("--w", `${t.bar}%`); fill.style.setProperty("--i", i);
    li.append(fill, label, el("span", "col-profile__count", t.countText), el("span", "col-profile__share", t.shareText));
    list.append(li);
  }
  freq.append(list);
  return out;
}
