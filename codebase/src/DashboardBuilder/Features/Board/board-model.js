// Dashboard board data — pure, DOM-free (unit-tested under tests/js/board-model.test.mjs). A dashboard tab holds
// `widgets` on a 12-column snap grid, in whole cells, never overlapping:
//   { id, kind: "sheet", sheetId, x, y, w, h }   a worksheet's view (sheetId = a worksheet tab id)
//   { id, kind: "text", heading, body, x, y, w, h }
//   { id, kind: "image", alt, src, x, y, w, h }   src = a base64 raster data URL (Board/image-model.js)
//   { id, kind: "spacer", x, y, w, h }            a blank cell block
//   { id, kind: "nav", label, tip, target, x, y, w, h }   a button that goes to a tab (target = a tab id or null; Board/nav-model.js)
// The saved form (workbook v2) has no ids and points at worksheets by index:
//   { kind: "sheet", sheet: <worksheet index>, x, y, w, h } | { kind: "text", heading, body, x, y, w, h } | the image and spacer as above
//   | { kind: "nav", label, tip, target: { kind: "worksheet" | "dashboard", index } | null, x, y, w, h }
// Limits live in Core/validate.js LIMITS. The board canvas (drag, resize, side panel) is UI on top of this module.
import { LIMITS } from "../Core/validate.js";
import { isImageSrc, budgetError } from "./image-model.js";

/** Default size in cells for a new widget of each kind. */
export const DEFAULT_SIZE = Object.freeze({ sheet: { w: 6, h: 4 }, text: { w: 12, h: 2 }, image: { w: 6, h: 4 }, spacer: { w: 2, h: 1 }, nav: { w: 4, h: 2 } });
const KINDS = new Set(["sheet", "text", "image", "spacer", "nav"]);
const minH = (kind) => (kind === "text" || kind === "spacer" || kind === "nav" ? LIMITS.textMinH : LIMITS.widgetMinH);
export const NAV_LABEL = "Go to";
const KIND_WORD = { text: "text", image: "image", spacer: "spacer", nav: "button" };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** True when two widgets share at least one cell (touching edges do not overlap). */
export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** True when the rectangle lies inside the 12-column, 96-row grid. */
export const inBounds = (r) => r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= LIMITS.gridCols && r.y + r.h <= LIMITS.boardRows;

/** The first free spot for a w × h widget, scanning rows top to bottom and each row left to right; null when none fits. */
export function firstFreeSpot(widgets, w, h) {
  if (w > LIMITS.gridCols || h > LIMITS.boardRows) return null;
  for (let y = 0; y + h <= LIMITS.boardRows; y++) {
    for (let x = 0; x + w <= LIMITS.gridCols; x++) {
      const cand = { x, y, w, h };
      if (!widgets.some((o) => overlaps(cand, o))) return { x, y };
    }
  }
  return null;
}

/** Where a new widget of `kind` goes: `{ ok: true, x, y, w, h }`, or `{ ok: false, error }` (full board / no room). */
export function placeNew(widgets, kind) {
  if (widgets.length >= LIMITS.widgets) return { ok: false, error: `A dashboard holds at most ${LIMITS.widgets} widgets.` };
  if (kind === "image" && widgets.filter((w) => w.kind === "image").length >= LIMITS.images) return { ok: false, error: `A dashboard holds at most ${LIMITS.images} images.` };
  const { w, h } = DEFAULT_SIZE[kind];
  const spot = firstFreeSpot(widgets, w, h);
  return spot ? { ok: true, ...spot, w, h } : { ok: false, error: "The dashboard is full — remove a widget or make one smaller." };
}

/** May `cand` (a move / resize result) sit among `widgets`? The widget's own record (same id) is ignored. */
export function checkPlacement(widgets, cand) {
  const { x, y, w, h } = cand;
  if (![x, y, w, h].every(Number.isInteger)) return { ok: false, error: "Widgets snap to whole grid cells." };
  if (w < LIMITS.widgetMinW || w > LIMITS.gridCols) return { ok: false, error: `A widget is ${LIMITS.widgetMinW}–${LIMITS.gridCols} columns wide.` };
  if (h < minH(cand.kind) || h > LIMITS.widgetMaxH) return { ok: false, error: `A widget is ${minH(cand.kind)}–${LIMITS.widgetMaxH} rows tall.` };
  if (!inBounds(cand)) return { ok: false, error: "A widget has to stay inside the dashboard grid." };
  if (widgets.some((o) => o.id !== cand.id && overlaps(cand, o))) return { ok: false, error: "A widget can't overlap another." };
  return { ok: true };
}

/** The first thing wrong with `cand` (a move / resize / drop result among `widgets`), in the user's words, or null when it may sit there.
 *  `verb` = "move" | "resize" | "place" (a drop from the side panel); `nameOf(widget)` names the widget it would overlap.
 *  Same rules as checkPlacement; this one says which and where. Order: whole cells, size limits, grid edge, overlap. */
export function explainRefusal(widgets, cand, verb, nameOf = () => "another widget") {
  const lead = `Can't ${verb}:`;
  const { x, y, w, h } = cand;
  if (![x, y, w, h].every(Number.isInteger)) return `${lead} widgets snap to whole grid cells.`;
  if (w < LIMITS.widgetMinW) return `${lead} a widget is at least ${LIMITS.widgetMinW} columns wide.`;
  if (h < minH(cand.kind)) return `${lead} a ${KIND_WORD[cand.kind] ?? "worksheet"} widget is at least ${minH(cand.kind)} ${minH(cand.kind) === 1 ? "row" : "rows"} tall.`;
  if (h > LIMITS.widgetMaxH) return `${lead} a widget is at most ${LIMITS.widgetMaxH} rows tall.`;
  if (x < 0) return `${lead} the widget is at the left edge of the dashboard.`;
  if (x + w > LIMITS.gridCols) return `${lead} the widget is at the right edge of the dashboard.`;
  if (y < 0) return `${lead} the widget is at the top of the dashboard.`;
  if (y + h > LIMITS.boardRows) return `${lead} the dashboard is at most ${LIMITS.boardRows} rows tall.`;
  const hit = widgets.find((o) => o.id !== cand.id && overlaps(cand, o));
  if (hit) return `${lead} it would overlap “${nameOf(hit)}”.`;
  return null;
}

/** A widget dropped from the side panel with the pointer on grid cell `cell` ({ col, row }): the default size, its top-left at that
 *  cell, but slid left just enough to stay inside the 12 columns (the pointer stays within it). Refused — never relocated — when
 *  the dashboard already has 12 widgets or the spot overlaps / runs past row 96. */
export function placeAt(widgets, kind, cell, nameOf) {
  if (widgets.length >= LIMITS.widgets) return { ok: false, error: `Can't place: a dashboard holds at most ${LIMITS.widgets} widgets.` };
  const { w, h } = DEFAULT_SIZE[kind];
  const cand = { kind, x: Math.min(cell.col, LIMITS.gridCols - w), y: cell.row, w, h };
  const error = explainRefusal(widgets, cand, "place", nameOf);
  return error ? { ok: false, error, cand } : { ok: true, x: cand.x, y: cand.y, w, h, cand };
}

/** Import validation of one dashboard's saved widgets → saved-form widgets. Every repair or drop is pushed to `issues`.
 *  Dropped: not an object, unknown kind, a worksheet index outside 0..worksheetCount-1, no room after an overlap, past 12.
 *  Clamped: size and position into the grid; text truncated; an overlapping widget moves to the first free spot. */
export function cleanWidgets(raw, { worksheetCount, dashboardCount = 0, ownDashboard = -1, where, budget = { left: LIMITS.imagesTotal } }, issues) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { issues.push(`${where}: the widgets weren't a list — none were opened.`); return []; }
  const out = [];
  let past = 0, pastImages = 0;
  for (const w of raw) {
    if (!w || typeof w !== "object") { issues.push(`${where}: skipped a widget that wasn't a widget.`); continue; }
    if (!KINDS.has(w.kind)) { issues.push(`${where}: skipped a widget of an unknown kind.`); continue; }
    if (w.kind === "sheet" && !(Number.isInteger(w.sheet) && w.sheet >= 0 && w.sheet < worksheetCount)) {
      issues.push(`${where}: removed a widget whose worksheet is missing.`); continue;
    }
    if (w.kind === "image" && !isImageSrc(w.src)) { issues.push(`${where}: removed an image widget whose picture wasn't a PNG, JPEG, GIF or WebP data URL.`); continue; }
    if (w.kind === "image" && out.filter((o) => o.kind === "image").length >= LIMITS.images) { pastImages++; continue; }
    if (w.kind === "image" && budgetError(LIMITS.imagesTotal - budget.left, w.src.length)) { issues.push(`${where}: removed an image widget — the pictures in a workbook can take at most ${LIMITS.imagesTotal / 1048576} MB in all.`); continue; }
    if (out.length >= LIMITS.widgets) { past++; continue; }
    if (w.kind === "image") budget.left -= w.src.length;
    const def = DEFAULT_SIZE[w.kind];
    let adjusted = false;
    const num = (v, fallback) => {
      if (Number.isInteger(v)) return v;
      adjusted = true;
      return Number.isFinite(v) ? Math.round(v) : fallback;
    };
    const rect = { w: num(w.w, def.w), h: num(w.h, def.h), x: num(w.x, 0), y: num(w.y, 0) };
    const fit = {
      w: clamp(rect.w, LIMITS.widgetMinW, LIMITS.gridCols),
      h: clamp(rect.h, minH(w.kind), LIMITS.widgetMaxH),
    };
    fit.x = clamp(rect.x, 0, LIMITS.gridCols - fit.w);
    fit.y = clamp(rect.y, 0, LIMITS.boardRows - fit.h);
    if (fit.w !== rect.w || fit.h !== rect.h || fit.x !== rect.x || fit.y !== rect.y) adjusted = true;
    if (adjusted) issues.push(`${where}: a widget was resized or moved to fit the grid.`);
    if (out.some((o) => overlaps(fit, o))) {
      const spot = firstFreeSpot(out, fit.w, fit.h);
      if (!spot) { issues.push(`${where}: removed a widget that overlapped another — no room was left for it.`); continue; }
      Object.assign(fit, spot);
      issues.push(`${where}: a widget overlapped another and was moved to the first free spot.`);
    }
    if (w.kind === "sheet") out.push({ kind: "sheet", sheet: w.sheet, ...fit });
    else if (w.kind === "image") out.push({ kind: "image", alt: cleanText(w.alt, LIMITS.imageAlt, "alt text", where, issues, "an image widget's"), src: w.src, ...fit });
    else if (w.kind === "spacer") out.push({ kind: "spacer", ...fit });
    else if (w.kind === "nav") {
      const t = w.target, count = t?.kind === "worksheet" ? worksheetCount : t?.kind === "dashboard" ? dashboardCount : 0;
      const live = t && typeof t === "object" && Number.isInteger(t.index) && t.index >= 0 && t.index < count && !(t.kind === "dashboard" && t.index === ownDashboard);
      if (w.target != null && !live) issues.push(`${where}: a navigation button's tab is missing — the button was left unlinked.`);
      const label = cleanText(w.label, LIMITS.navLabel, "label", where, issues, "a navigation button's");
      if (!label.trim() && w.label != null && typeof w.label === "string") issues.push(`${where}: a navigation button had no label — it was named “${NAV_LABEL}”.`);
      out.push({ kind: "nav", label: label.trim() || NAV_LABEL, tip: cleanText(w.tip, LIMITS.navTip, "tooltip", where, issues, "a navigation button's"), target: live ? { kind: t.kind, index: t.index } : null, ...fit });
    }
    else out.push({ kind: "text", heading: cleanText(w.heading, LIMITS.widgetHeading, "heading", where, issues), body: cleanText(w.body, LIMITS.widgetBody, "body", where, issues), ...fit });
  }
  if (pastImages) issues.push(`${where}: only the first ${LIMITS.images} images were opened.`);
  if (past) issues.push(`${where}: only the first ${LIMITS.widgets} widgets were opened.`);
  return out;
}

function cleanText(v, max, label, where, issues, owner = "a text widget's") {
  if (v == null) return "";
  if (typeof v !== "string") { issues.push(`${where}: ${owner} ${label} wasn't text — cleared.`); return ""; }
  if (v.length > max) { issues.push(`${where}: ${owner} ${label} was cut to ${max} characters.`); return v.slice(0, max); }
  return v;
}

/** Store widgets → the saved form. `indexOf` maps a worksheet tab id to its index in the saved `worksheets`; a widget of an unknown worksheet is dropped. */
export function savedWidgets(widgets, indexOf, dbIndexOf = new Map()) {
  const out = [];
  for (const w of widgets) {
    const { x, y, w: cw, h } = w;
    if (w.kind === "text") out.push({ kind: "text", heading: w.heading ?? "", body: w.body ?? "", x, y, w: cw, h });
    else if (w.kind === "image") out.push({ kind: "image", alt: w.alt ?? "", src: w.src, x, y, w: cw, h });
    else if (w.kind === "spacer") out.push({ kind: "spacer", x, y, w: cw, h });
    else if (w.kind === "nav") {
      const target = indexOf.has(w.target) ? { kind: "worksheet", index: indexOf.get(w.target) } : dbIndexOf.has(w.target) ? { kind: "dashboard", index: dbIndexOf.get(w.target) } : null;
      out.push({ kind: "nav", label: w.label ?? NAV_LABEL, tip: w.tip ?? "", target, x, y, w: cw, h });
    } else if (indexOf.has(w.sheetId)) out.push({ kind: "sheet", sheet: indexOf.get(w.sheetId), x, y, w: cw, h });
  }
  return out;
}

/** The widgets without those showing worksheet `sheetId` (the same array when none do). */
export function removeSheetWidgets(widgets, sheetId) {
  return widgets.some((w) => w.kind === "sheet" && w.sheetId === sheetId)
    ? widgets.filter((w) => !(w.kind === "sheet" && w.sheetId === sheetId))
    : widgets;
}

/** The dashboard tabs that show worksheet `sheetId`. */
export const dashboardsUsing = (tabs, sheetId) =>
  tabs.filter((t) => t.kind === "dashboard" && t.widgets.some((w) => w.kind === "sheet" && w.sheetId === sheetId));

const NAME_BASE = { worksheet: "Worksheet", dashboard: "Dashboard" };
/** "Worksheet N" / "Dashboard N": the first number not already used by a tab name. */
export function defaultTabName(kind, names) {
  const taken = new Set(names);
  for (let n = 1; ; n++) {
    const name = `${NAME_BASE[kind]} ${n}`;
    if (!taken.has(name)) return name;
  }
}
