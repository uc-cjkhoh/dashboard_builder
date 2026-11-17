// The Data Source's data preview (DOM; the request rule is entityRowsQuery in Rows/rows-model.js): the first rows of one card in a
// panel docked under the canvas, so a table — or what a card's custom SQL now returns — can be checked without leaving the model.
// Opened by a card's table button (canvas.js), which also closes it, and after Edit SQL is saved (canvas.js calls showPreview). It
// re-reads when that card's SQL changes, empties when the card is removed, and shows only on the Data Source. Read-only; the latest
// request wins (switching card, Refresh or Close cancels one in flight). Its height is view state: drag the top edge or ↑ / ↓.
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { entities, bus, emit, isModelActive } from "../Core/store.js";
import { clampHeight } from "../Core/edge-resize.js";
import { entityRowsQuery, rowsSummary, anyCellCut, CUT_NOTE } from "../Rows/rows-model.js";
import { rowsTable, downloadRowsCsv } from "../Rows/rows-dialog.js";

const MIN_H = 120, GROUND_MIN = 160, STEP = 16; // the panel's smallest height; the ground it always leaves above it; keyboard step

let panel, main, title, summary, notes, scroll, csv, ground;
let currentId = null;   // the entity shown
let ctl = null;         // the request in flight
let result = null;      // the rows shown, for Export CSV
let height = 288;       // px

/** The id of the card the panel shows, or null. */
export const previewedId = () => currentId;

/** Show (or re-read) the rows of card `entityId`. */
export function showPreview(entityId) {
  if (!panel || !entities.has(entityId)) return;
  mark(currentId, false);
  currentId = entityId;
  mark(currentId, true);
  sync();
  load();
}

/** The card's table button: open the panel on that card, or close it when it already shows that card. */
export function togglePreview(entityId) {
  if (currentId === entityId && !panel.hidden) closePreview();
  else showPreview(entityId);
}

export function closePreview() {
  ctl?.abort(); ctl = null;
  mark(currentId, false);
  currentId = null; result = null;
  sync();
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
  document.getElementById("ds-preview-close").addEventListener("click", closePreview);
  document.getElementById("ds-preview-refresh").addEventListener("click", () => { if (currentId) load(); });
  csv.addEventListener("click", () => { const e = entities.get(currentId); if (result && e) downloadRowsCsv(result, `${e.table}-rows`); });
  wireGrip(document.getElementById("ds-preview-grip"));

  bus.addEventListener("view:changed", sync);
  bus.addEventListener("entity:removed", (e) => { if (e.detail?.entityId === currentId) closePreview(); });
  bus.addEventListener("entity:sql", (e) => { if (e.detail?.entityId === currentId) load(); }); // "using your SQL" / "back to the table"
  document.addEventListener("connection:form", sync);     // the start card covers the model: the panel steps aside with it
  document.addEventListener("connection:changed", (e) => { if (!e.detail?.connected) closePreview(); });
  window.addEventListener("resize", () => { if (!panel.hidden) setHeight(height); });
}

// The previewed card says so: an accent outline (canvas.css) and its table button pressed — never colour alone.
function mark(id, on) {
  const el = entities.get(id)?.el;
  if (!el) return;
  el.classList.toggle("entity--previewed", on);
  el.querySelector(".entity__peek")?.setAttribute("aria-pressed", String(on));
}

// Shown only on the Data Source, with a card picked, and while the connect form isn't over the model.
function sync() {
  const formOpen = !(document.getElementById("conn-form")?.hidden ?? true);
  const visible = Boolean(currentId) && isModelActive() && !formOpen;
  if (panel.hidden === !visible) return;
  panel.hidden = !visible;
  main.classList.toggle("has-ds-preview", visible);
  if (visible) setHeight(height);
  emit("canvas:zoomed", { zoom: Number(ground?.style.getPropertyValue("--zoom")) || 1 }); // the ground changed height: links re-measure
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

async function load() {
  const entity = entities.get(currentId);
  if (!entity) return;
  ctl?.abort();
  const mine = (ctl = new AbortController());
  result = null; csv.disabled = true;
  title.textContent = entity.source ? entity.table : `${entity.db}.${entity.table}`;
  title.title = title.textContent;
  summary.textContent = entity.customSql ? "Custom SQL" : "";
  notes.replaceChildren(); notes.hidden = true;
  scroll.replaceChildren(status("Loading rows…"));
  let query;
  try { query = entityRowsQuery(entity); } catch (err) { scroll.replaceChildren(status(err.message, true)); return; }
  try {
    const res = await api[query.load](query.request, { signal: mine.signal });
    if (mine !== ctl) return; // a newer request (another card, Refresh) took over
    result = res;
    summary.textContent = (entity.customSql ? "Custom SQL · " : "") + rowsSummary(res) + (res.columnsTruncated ? ` · first ${res.columns.length} columns` : "");
    if (anyCellCut(res.rows)) { notes.append(note(CUT_NOTE, "info")); notes.hidden = false; }
    scroll.replaceChildren(res.rows.length ? rowsTable(res) : status("No rows."));
    scroll.scrollTo(0, 0);
    csv.disabled = res.rows.length === 0;
  } catch (err) {
    if (err?.name === "AbortError" || mine !== ctl) return;
    scroll.replaceChildren(status(err.message, true)); // inline, beside the card it belongs to: the panel is the place the user is looking
  }
}
