// The column profile dialog (DOM only; every rule lives in column-profile-model.js): one field's properties, rows / distinct /
// null share / min / max tiles and its most frequent values, read-only, from POST .../profile. Opened from a field row on a
// canvas card. Escape, Close and the X close it; closing cancels a request still in flight. Text is always set with textContent.
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { makeButton, openDialog, closeDialog, copyText } from "../Core/ui.js";
import { morphIn, morphOut } from "../Core/motion.js";
import { distributionFailure, histogramRequest, histogramView, profileFailure, profileRequest, roleOf, summarize } from "./column-profile-model.js";

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let seq = 0;

/** Profile one column of one table. `column` is `{ name, type, category }` as the catalog (or the card's custom SQL) described it; `source` is that SQL (`sqlWire`) for a custom SQL card; `origin` is the Profile button, which the dialog grows out of and folds back into (motion.js `morphIn` / `morphOut`). */
export function openColumnProfile(db, table, column, source = null, origin = null) {
  const id = `col-profile-${++seq}`;
  const dlg = el("dialog", "dialog col-profile");
  dlg.setAttribute("aria-labelledby", `${id}-title`);
  const head = el("div", "col-profile__head");
  const titles = el("div", "col-profile__titles");
  const h = el("h2", "dialog__title col-profile__title", column.name); h.id = `${id}-title`;
  const sub = el("p", "col-profile__sub", `${db}.${table} · ${column.type} · ${roleOf(column.category)}`); sub.title = sub.textContent;
  titles.append(h, sub);
  const x = makeButton("", "iconbtn"); x.append(icon("close")); x.setAttribute("aria-label", "Close");
  head.append(titles, x);

  const body = el("div", "col-profile__body");
  const status = el("p", "col-profile__status col-profile__status--busy", "Reading every row…"); status.setAttribute("role", "status");
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
  let closing = false; // Escape, X and Close all land here; the fold-back takes ~200ms, so a second press must not start another
  const finish = async () => { if (closing) return; closing = true; ctl.abort(); if (origin?.isConnected) await morphOut(dlg, origin.getBoundingClientRect()); closeDialog(dlg); };
  x.addEventListener("click", finish); close.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  copyName.addEventListener("click", () => copyText(column.name, "the field name"));
  openDialog(dlg);
  if (origin?.isConnected) morphIn(dlg, origin.getBoundingClientRect());
  close.focus();

  let req;
  try { req = profileRequest(column.name, undefined, source); } catch (err) { showError(status, err.message); return dlg; }
  // The distribution of a numeric column is read in parallel (the worksheet's histogram endpoint); it has its own section, states and errors, so a slow or
  // failed distribution never replaces the figures. Closing aborts it with the profile.
  const hist = column.category === "numeric"
    ? api.histogram(db, table, histogramRequest(column.name, source), { signal: ctl.signal }).then((h) => ({ h }), (err) => ({ err }))
    : null;
  api.profile(db, table, req, { signal: ctl.signal }).then((p) => {
    const s = summarize(p, Boolean(source));
    copyValues.disabled = s.copyValues === "";
    if (copyValues.disabled) copyValues.title = s.empty ? "No values to copy: there are no rows" : "No plain values to copy: the top values are NULL, empty or cut";
    copyValues.addEventListener("click", () => copyText(s.copyValues, "the values"));
    const out = sections(s, hist && p.nulls < p.rows);
    body.replaceChildren(...out.cells);
    if (out.distribution) hist.then((res) => { if (!ctl.signal.aborted) fillDistribution(out.distribution, res, p.rows, Boolean(source)); });
  }).catch((err) => {
    if (err?.name === "AbortError") return;
    showError(status, profileFailure(err, Boolean(source)));
  });
  return dlg;
}

function showError(status, message) {
  const glyph = el("span", "col-profile__glyph"); glyph.setAttribute("aria-hidden", "true"); glyph.append(icon("warning", { size: 14 }));
  status.classList.remove("col-profile__status--busy"); status.classList.add("col-profile__status--error");
  status.replaceChildren(glyph, document.createTextNode(message));
}

const RANGE = new Set(["Min", "Max"]);
const longIn = (tiles) => tiles.some((t) => t.value.length > LONG_FIGURE); // one size per group: if any figure is long, they all step down together
const LONG_FIGURE = 12;  // characters: a group with a longer figure steps from 24px to 16px
const STACK_RANGE = 18;  // characters: when Min or Max is longer, they stack so each has the full width

// One full-width block (no card) in two sections (figures, then frequent values) split by a hairline; a caveat note, when there is one, is a strip above it,
// before the figures it qualifies. The field's name, type and role are the title and subtitle, so they are not listed again.
function sections(s, withDistribution = false) {
  const out = [];
  let distribution = null;
  const card = (kind) => { const c = el(kind === "note" ? "div" : "article", `col-profile__cell col-profile__cell--${kind}`); c.style.setProperty("--i", out.length); out.push(c); return c; };
  const section = (parent, kind, label) => { const e = el("section", `col-profile__section col-profile__section--${kind}`); e.setAttribute("aria-label", label); parent.append(e); return e; };
  const stat = (t, long) => {
    const c = el("div", "col-profile__tile");
    const val = el("span", `col-profile__tile-value${long ? " col-profile__tile-value--long" : ""}`, t.value); val.title = t.value;
    c.append(el("span", "col-profile__tile-label", t.label), val);
    if (t.note) c.append(el("span", "col-profile__tile-note", t.note));
    return c;
  };
  const notes = [s.cutNote].filter(Boolean);
  if (notes.length) {
    const c = card("note");
    for (const text of notes) {
      const line = el("p", "col-profile__note-line"); const g = el("span", "col-profile__glyph"); g.setAttribute("aria-hidden", "true"); g.append(icon("info", { size: 14 }));
      line.append(g, document.createTextNode(text)); c.append(line);
    }
  }
  const reason = (text) => {
    const line = el("p", "col-profile__reason"); const g = el("span", "col-profile__glyph"); g.setAttribute("aria-hidden", "true"); g.append(icon("info", { size: 14 }));
    line.append(g, document.createTextNode(text)); return line;
  };
  const profile = card("profile");
  // No rows: nothing to measure, so the block is the reason alone (zeros and a 0% null share would only mislead).
  if (s.empty) { section(profile, "empty", "Nothing to profile").append(reason(s.reason)); return { cells: out, distribution: null }; }
  const size = s.tiles.filter((t) => !RANGE.has(t.label)), range = s.tiles.filter((t) => RANGE.has(t.label));
  const figures = section(profile, "figures", "Figures");
  const sizeRow = el("div", "col-profile__size"); sizeRow.append(...size.map((t) => stat(t, longIn(size)))); sizeRow.style.setProperty("--n", size.length); figures.append(sizeRow);
  if (range.length) { const r = el("div", `col-profile__range${range.some((t) => t.value.length > STACK_RANGE) ? " col-profile__range--stack" : ""}`); r.append(...range.map((t) => stat(t, longIn(range)))); r.style.setProperty("--n", range.length); figures.append(r); }
  if (s.summary.length) {
    const group = el("div", "col-profile__stats"), cells = s.summary.length, padded = Math.ceil(cells / 3) * 3;
    group.append(...s.summary.map((t) => stat(t, longIn(s.summary))));
    for (let i = cells; i < padded; i++) group.append(el("div", "col-profile__tile col-profile__tile--blank")); // an empty cell still carries its rule
    group.style.setProperty("--n", cells); group.style.setProperty("--rows", padded / 3);
    figures.append(group);
  }
  if (withDistribution) {
    distribution = section(profile, "dist", "Distribution");
    distribution.append(el("h3", "col-profile__h", "Distribution"));
    const busy = el("p", "col-profile__reason col-profile__reason--busy", "Reading the distribution…"); busy.setAttribute("role", "status");
    const g = el("span", "col-profile__glyph"); g.setAttribute("aria-hidden", "true"); g.append(icon("refresh", { size: 14 })); busy.prepend(g);
    distribution.append(busy);
  }
  const freq = section(profile, "top", "Most frequent values");
  freq.append(el("h3", "col-profile__h", "Most frequent values"));
  if (s.top.length === 0) { freq.append(reason("There are no values to list.")); return { cells: out, distribution }; }
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
  if (s.reason) freq.append(reason(s.reason));
  return { cells: out, distribution };
}

// The distribution section: bars (one per bin, tallest = the accent), the first and last value under them, the fullest bin in words, and every bin's range and count as
// text for assistive tech and the tooltip. Its own error / empty line replaces only the chart, never the figures above.
function fillDistribution(section, res, rows, custom) {
  const note = (text, glyph) => {
    const line = el("p", "col-profile__reason"); const g = el("span", "col-profile__glyph"); g.setAttribute("aria-hidden", "true"); g.append(icon(glyph, { size: 14 }));
    line.append(g, document.createTextNode(text)); return line;
  };
  const keep = section.querySelector(".col-profile__h");
  if (res.err) { if (res.err?.name === "AbortError") return; section.replaceChildren(keep, note(distributionFailure(res.err, custom), "warning")); return; }
  const v = histogramView(res.h, rows);
  if (v.empty) { section.replaceChildren(keep, note(v.reason, "info")); return; }
  const list = el("ol", "col-profile__bins");
  for (const [i, b] of v.bars.entries()) {
    const li = el("li", `col-profile__bin${b.peak ? " col-profile__bin--peak" : ""}`);
    li.title = `${b.range}: ${b.countText} ${b.count === 1 ? "row" : "rows"} (${b.shareText})`;
    const bar = el("span", "col-profile__bar"); bar.setAttribute("aria-hidden", "true"); bar.style.setProperty("--h", `${b.height}%`); bar.style.setProperty("--i", i);
    li.append(bar, el("span", "col-profile__sr", li.title));
    list.append(li);
  }
  const axis = el("div", "col-profile__axis"); axis.setAttribute("aria-hidden", "true");
  axis.append(el("span", "", v.min), el("span", "", v.max));
  section.replaceChildren(keep, list, axis, el("p", "col-profile__tile-note", v.peak));
}
