// The Data Source's data preview (DOM; the request rule is entityRowsQuery in Rows/rows-model.js): the first rows of one card in a
// panel docked under the canvas, so a table — or what a card's custom SQL now returns — can be checked without leaving the model.
// Opened by Preview data in a card's ☰ menu (canvas.js), which also closes it, and after Edit SQL is saved (canvas.js calls showPreview). It
// re-reads when that card's SQL changes, empties when the card is removed, and shows only on the Data Source. Read-only; the latest
// request wins (switching card, Refresh or Close cancels one in flight). Its height is view state: drag the top edge or ↑ / ↓. Its
// columns fit their content and resize from a grip on each header's right edge (preview-columns.js), kept per card for the session.
// It pages 100 rows at a time (‹ Page n ›; pageState in rows-model.js): Refresh keeps the page, another card or a SQL change goes
// back to page 1. A union card shows its first rows only (canPage), so its pager is hidden.
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { entities, bus, emit, isModelActive } from "../Core/store.js";
import { clampHeight } from "../Core/edge-resize.js";
import { entityRowsQuery, rowsSummary, anyCellCut, CUT_NOTE, canPage, pageState, pageFromInput, DEFAULT_LIMIT } from "../Rows/rows-model.js";
import { rowsTable, downloadRowsCsv } from "../Rows/rows-dialog.js";
import { sizeColumns, widthMemory } from "./preview-columns.js";

const MIN_H = 120, GROUND_MIN = 160, STEP = 16; // the panel's smallest height; the ground it always leaves above it; keyboard step

let panel, main, title, summary, notes, scroll, csv, ground, pager, prevBtn, nextBtn, pageLabel;
let page = 0;          // 0-based page of DEFAULT_LIMIT rows
let currentId = null;   // the entity shown
let ctl = null;         // the request in flight
let result = null;      // the rows shown, for Export CSV
let shownId = null;     // the card whose rows table is on screen (kept, dimmed, while that card re-reads)
let unsized = null;     // a table read while the panel was hidden: measured when it shows (a hidden table has no widths)
let height = 288;       // px
const widths = widthMemory(); // column widths per card for the session (preview-columns.js)

/** The id of the card the panel shows, or null. */
export const previewedId = () => currentId;

/** Show (or re-read) the rows of card `entityId`. */
export function showPreview(entityId) {
  if (!panel || !entities.has(entityId)) return;
  mark(currentId, false);
  currentId = entityId;
  page = 0;
  mark(currentId, true);
  sync();
  load();
}

/** The card's ☰ Preview data: open the panel on that card, or close it when it already shows that card. */
export function togglePreview(entityId) {
  if (currentId === entityId && !panel.hidden) closePreview();
  else showPreview(entityId);
}

export function closePreview() {
  ctl?.abort(); ctl = null;
  mark(currentId, false);
  currentId = null; result = null; shownId = null;
  scroll?.removeAttribute("aria-busy");
  sync();
}

// What the rows area now shows (a table for card `id`, or a status line with id null); a read that was dimming the old rows is over.
function shown(el, id) {
  scroll.replaceChildren(el);
  scroll.removeAttribute("aria-busy");
  shownId = id;
}

export function initDataPreview() {
  panel = document.getElementById("ds-preview");
  if (!panel) return;
  main = panel.parentElement;
  ground = document.getElementById("model-view");
  title = document.getElementById("ds-preview-title");
  summary = document.getElementById("ds-preview-summary");
  notes = document.getElementById("ds-preview-notes");
  scroll = document.getElementById("ds-preview-scroll");
  csv = document.getElementById("ds-preview-csv");
  pager = document.getElementById("ds-preview-pager");
  prevBtn = document.getElementById("ds-preview-prev");
  nextBtn = document.getElementById("ds-preview-next");
  pageLabel = document.getElementById("ds-preview-page");
  prevBtn.addEventListener("click", () => turn(-1));
  nextBtn.addEventListener("click", () => turn(1));
  pageLabel.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); jump(); }
    else if (e.key === "Escape" && pageLabel.value !== String(page + 1)) { e.preventDefault(); e.stopPropagation(); showPage(); }
  });
  pageLabel.addEventListener("change", jump); // typed, then left the field
  pageLabel.addEventListener("input", () => pageError(null));
  pageLabel.addEventListener("focus", () => pageLabel.select());
  document.getElementById("ds-preview-close").addEventListener("click", closePreview);
  document.getElementById("ds-preview-refresh").addEventListener("click", () => { if (currentId) load(); });
  csv.addEventListener("click", () => { const e = entities.get(currentId); if (result && e) downloadRowsCsv(result, `${e.table}-rows`); });
  wireGrip(document.getElementById("ds-preview-grip"));

  bus.addEventListener("view:changed", sync);
  bus.addEventListener("entity:removed", (e) => { widths.clear(e.detail?.entityId); if (e.detail?.entityId === currentId) closePreview(); });
  bus.addEventListener("entity:sql", (e) => { // "using your SQL" / "back to the table": other rows and columns, so page 1 and fresh widths
    widths.clearAuto(e.detail?.entityId);
    if (e.detail?.entityId === currentId) { page = 0; load(); }
  });
  document.addEventListener("connection:form", sync);     // the start card covers the model: the panel steps aside with it
  document.addEventListener("connection:changed", (e) => { if (!e.detail?.connected) closePreview(); });
  window.addEventListener("resize", () => { if (!panel.hidden) setHeight(height); });
}

// The previewed card says so: an accent outline (canvas.css), its name in the panel title, and Preview data ticked in its ☰ menu (canvas.js) — never colour alone.
function mark(id, on) {
  const el = entities.get(id)?.el;
  if (!el) return;
  el.classList.toggle("entity--previewed", on);
}

// Shown only on the Data Source, with a card picked, and while the connect form isn't over the model.
function sync() {
  const formOpen = !(document.getElementById("conn-form")?.hidden ?? true);
  const visible = Boolean(currentId) && isModelActive() && !formOpen;
  if (panel.hidden === !visible) return;
  panel.hidden = !visible;
  main.classList.toggle("has-ds-preview", visible);
  if (visible) { setHeight(height); if (unsized?.table.isConnected) size(unsized); }
  emit("canvas:zoomed", { zoom: Number(ground?.style.getPropertyValue("--zoom")) || 1 }); // the ground changed height: links re-measure
}

// Measured once the web fonts are in (a header measured in the fallback face comes out too narrow) and while the panel shows.
function size(t) {
  unsized = t;
  document.fonts.ready.then(() => {
    if (unsized !== t || panel.hidden || !t.table.isConnected) return; // replaced, or measured when the panel shows again (sync)
    unsized = null;
    sizeColumns(t.table, t.columns, widths, t.id);
  });
}

function setHeight(px) {
  const max = (main.clientHeight || 0) - (main.querySelector(".canvas__bar")?.offsetHeight ?? 0) - GROUND_MIN;
  height = clampHeight(px, MIN_H, max);
  main.style.setProperty("--ds-preview-h", `${height}px`);
  const grip = document.getElementById("ds-preview-grip");
  grip.setAttribute("aria-valuenow", String(height));
  grip.setAttribute("aria-valuemin", String(MIN_H));
  grip.setAttribute("aria-valuemax", String(Math.max(MIN_H, max)));
}

// The top edge: drag it up to grow the panel (the ground above shrinks), ↑ / ↓ in 16px steps, double-click for the default.
function wireGrip(grip) {
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY, start = height;
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("is-active");
    const move = (ev) => setHeight(start - (ev.clientY - startY));
    const up = () => {
      grip.classList.remove("is-active");
      grip.releasePointerCapture(event.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      emit("canvas:zoomed", { zoom: Number(ground?.style.getPropertyValue("--zoom")) || 1 });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => setHeight(288));
  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setHeight(height + (event.key === "ArrowUp" ? STEP : -STEP));
  });
}

const note = (text, kind) => {
  const p = document.createElement("p");
  p.className = "rows-dialog__note";
  const g = document.createElement("span");
  g.className = "rows-dialog__note-icon"; g.setAttribute("aria-hidden", "true"); g.append(icon(kind, { size: 14 }));
  p.append(g, document.createTextNode(" " + text));
  return p;
};
const status = (text, error = false) => {
  const p = document.createElement("p");
  p.className = "rows-dialog__status" + (error ? " rows-dialog__status--error" : "");
  if (error) { const g = document.createElement("span"); g.className = "rows-dialog__note-icon"; g.setAttribute("aria-hidden", "true"); g.append(icon("warning", { size: 14 })); p.append(g, " "); }
  p.append(text);
  return p;
};

// Previous / Next: one page back or on. A click while a page is loading waits for it (the buttons keep the last page's state).
function turn(dir) {
  if (ctl || !currentId) return;
  page = Math.max(0, page + dir);
  load();
}

// A typed page number (Enter, or leaving the field after typing): 1 to MAX_PAGE, else the field says so and the page stays.
// Past the last page there are no rows to show — the panel says so, and Previous is still there. Escape puts the shown page back.
function jump() {
  if (!currentId || pageLabel.value === String(page + 1)) { pageError(null); return; }
  const r = pageFromInput(pageLabel.value);
  if (r.error) { pageError(r.error); return; }
  pageError(null);
  if (ctl) { showPage(); return; } // a page is loading: it wins
  page = r.page;
  load();
}
const showPage = () => { pageLabel.value = String(page + 1); pageError(null); };

// The page field's error: aria-invalid on the field, the sentence (warning icon + text) in the panel's notes, read out as it appears.
function pageError(message) {
  notes.querySelector(".ds-preview__page-error")?.remove();
  if (!message) { pageLabel.removeAttribute("aria-invalid"); pageLabel.removeAttribute("aria-describedby"); notes.hidden = !notes.childElementCount; return; }
  const p = note(message, "warning");
  p.classList.add("ds-preview__page-error"); p.id = "ds-preview-page-error"; p.setAttribute("role", "alert");
  notes.prepend(p); notes.hidden = false;
  pageLabel.setAttribute("aria-invalid", "true");
  pageLabel.setAttribute("aria-describedby", p.id);
}

async function load() {
  const entity = entities.get(currentId);
  if (!entity) return;
  ctl?.abort();
  const mine = (ctl = new AbortController());
  result = null; csv.disabled = true;
  title.textContent = entity.source ? entity.table : `${entity.db}.${entity.table}`;
  title.title = title.textContent;
  // Another page, Refresh or a SQL change of the card already shown: its rows stay in place, dimmed and aria-busy, until the new
  // ones arrive, so the table, its summary and its notes never blink out. A first open or another card starts from "Loading rows…".
  if (shownId === currentId && scroll.querySelector(".rows-table")) scroll.setAttribute("aria-busy", "true");
  else {
    shownId = null;
    summary.textContent = entity.customSql ? "Custom SQL" : "";
    notes.replaceChildren(); notes.hidden = true;
    scroll.replaceChildren(status("Loading rows…"));
  }
  const paged = canPage(entity);
  pager.hidden = !paged;
  showPage();
  let query;
  try { query = entityRowsQuery(entity, DEFAULT_LIMIT, paged ? page * DEFAULT_LIMIT : undefined); }
  catch (err) { ctl = null; shown(status(err.message, true), null); return; }
  try {
    const res = await api[query.load](query.request, { signal: mine.signal });
    if (mine !== ctl) return; // a newer request (another card, Refresh) took over
    ctl = null;
    result = res;
    const st = paged ? pageState(page, DEFAULT_LIMIT, res) : null;
    summary.textContent = (entity.customSql ? "Custom SQL · " : "") + (st ? st.summary : rowsSummary(res)) + (res.columnsTruncated ? ` · first ${res.columns.length} columns` : "");
    if (st) setPager(st);
    notes.querySelector(".ds-preview__cut-note")?.remove(); // a typed page's error (if any) stays until the field is edited
    if (anyCellCut(res.rows)) { const n = note(CUT_NOTE, "info"); n.classList.add("ds-preview__cut-note"); notes.append(n); }
    notes.hidden = !notes.childElementCount;
    if (res.rows.length) { const table = rowsTable(res); shown(table, currentId); size({ table, columns: res.columns, id: currentId }); }
    else shown(status(page > 0 ? "No rows on this page." : "No rows."), null);
    scroll.scrollTo(0, 0);
    csv.disabled = res.rows.length === 0;
  } catch (err) {
    if (err?.name === "AbortError" || mine !== ctl) return;
    ctl = null;
    shown(status(err.message, true), null); // inline, beside the card it belongs to: the panel is the place the user is looking
  }
}

// The pager after a read. A button that was focused and now can't go on hands focus to the other one, so the keyboard keeps its place.
function setPager({ prev, next }) {
  if (document.activeElement !== pageLabel) showPage();
  const focused = document.activeElement;
  prevBtn.disabled = !prev;
  nextBtn.disabled = !next;
  if (focused === nextBtn && !next && prev) prevBtn.focus();
  else if (focused === prevBtn && !prev && next) nextBtn.focus();
}
