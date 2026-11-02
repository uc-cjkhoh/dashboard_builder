// Dashboard board geometry — pure, DOM-free (tests/js/board-layout.test.mjs). Turns widget cells ({ x, y, w, h } on the
// 12-column grid) into pixel rectangles for a given panel width. board.js reads the row height and gap from the design
// tokens (`calc(var(--ctl-h) * 2)`, `var(--s2)`) and passes them in; nothing here knows a pixel constant of its own.
//
//   wide panel     column width = (panel − 11 gaps) / 12; a widget is w columns × h rows, gaps included between cells
//   print          `stack: true` stacks the widgets full width in reading order (top to bottom, then left to right), each
//                  keeping its row count, so none splits across pages
import { LIMITS } from "../Core/validate.js";

/** One column's width in pixels (never negative). */
export const columnWidth = (panelWidth, gap, cols = LIMITS.gridCols) => Math.max(0, (panelWidth - gap * (cols - 1)) / cols);

/** Reading order: by row, then column (what a printed, stacked board shows). */
export const widgetOrder = (widgets) => [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);

const MIN_FIXED_ROW = 16; // px

/** A fixed board's row height: the rows in use (down to the lowest widget) share the box height. */
export function fixedRowH(widgets, fixed, gap, fallback) {
  const rows = widgets.reduce((m, wd) => Math.max(m, wd.y + wd.h), 0);
  return rows > 0 ? Math.max(MIN_FIXED_ROW, (fixed.height - gap * (rows - 1)) / rows) : fallback; // floored: a tall stack in a short box overflows rather than collapsing
}

const span = (n, unit, gap) => n * unit + (n - 1) * gap;

/**
 * Where every widget sits. `metrics` = { rowH, gap, stack?, fixed? } in pixels; `stack: true` stacks the widgets in one column (print); `fixed` = { width, height }
 * lays the board out as exactly that box (never stacked): columns span the width, rows stretch so the lowest widget ends at the height. Returns { stacked, height, rects: Map(id → { left, top, width, height }) };
 * `height` is the canvas height — the bottom of the lowest widget (at most 96 rows).
 */
export function layoutBoard(widgets, panelWidth, { rowH, gap, stack = false, fixed = null }) {
  const rects = new Map();
  if (fixed) {
    const row = fixedRowH(widgets, fixed, gap, rowH);
    const col = columnWidth(fixed.width, gap);
    for (const wd of widgets) rects.set(wd.id, { left: wd.x * (col + gap), top: wd.y * (row + gap), width: span(wd.w, col, gap), height: span(wd.h, row, gap) });
    return { stacked: false, height: fixed.height, rects };
  }
  const width = Math.max(0, panelWidth);
  const stacked = stack;
  let height = 0;
  if (stacked) {
    let top = 0;
    for (const wd of widgetOrder(widgets)) {
      const h = span(wd.h, rowH, gap);
      rects.set(wd.id, { left: 0, top, width, height: h });
      top += h + gap;
      height = top - gap;
    }
  } else {
    const col = columnWidth(width, gap);
    for (const wd of widgets) {
      const rect = { left: wd.x * (col + gap), top: wd.y * (rowH + gap), width: span(wd.w, col, gap), height: span(wd.h, rowH, gap) };
      rects.set(wd.id, rect);
      height = Math.max(height, rect.top + rect.height);
    }
  }
  return { stacked, height, rects };
}

// --- Pixels → cells (drag, resize and drop). Points are relative to the grid's top-left; metrics = { rowH, gap }. ---
const strides = (panelWidth, { rowH, gap }) => ({ sx: columnWidth(Math.max(0, panelWidth), gap) + gap, sy: rowH + gap });

/** The grid cell ({ col 0..11, row 0..95 }) under a point; a point left of / above the grid is cell 0. */
export function cellAt(point, panelWidth, metrics) {
  const { sx, sy } = strides(panelWidth, metrics);
  const at = (v, stride, max) => (stride > 0 ? Math.min(max, Math.max(0, Math.floor(v / stride))) : 0);
  return { col: at(point.x, sx, LIMITS.gridCols - 1), row: at(point.y, sy, LIMITS.boardRows - 1) };
}

/** `start` ({ x, y, w, h }) moved by a pointer delta in pixels, snapped to the nearest whole cell. Not clamped: an out-of-grid
 *  result is for the caller to refuse (checkPlacement), never to move elsewhere. */
export function snapMove(start, dx, dy, panelWidth, metrics) {
  const { sx, sy } = strides(panelWidth, metrics);
  return { ...start, x: start.x + (sx > 0 ? Math.round(dx / sx) : 0), y: start.y + (sy > 0 ? Math.round(dy / sy) : 0) };
}

/** `start` resized from its bottom-right corner by a pointer delta, snapped to whole cells; never below 1 × 1 (so a ghost can
 *  be drawn — the size limits are the caller's to enforce). */
export function snapResize(start, dx, dy, panelWidth, metrics) {
  const { sx, sy } = strides(panelWidth, metrics);
  return { ...start, w: Math.max(1, start.w + (sx > 0 ? Math.round(dx / sx) : 0)), h: Math.max(1, start.h + (sy > 0 ? Math.round(dy / sy) : 0)) };
}

/** The pixel rectangle of a cell rectangle on a wide panel (what a ghost covers). */
export function cellRect(cand, panelWidth, { rowH, gap }) {
  const col = columnWidth(Math.max(0, panelWidth), gap);
  return { left: cand.x * (col + gap), top: cand.y * (rowH + gap), width: span(cand.w, col, gap), height: span(cand.h, rowH, gap) };
}
