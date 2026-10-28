// Dashboard board geometry — pure, DOM-free (tests/js/board-layout.test.mjs). Turns widget cells ({ x, y, w, h } on the
// 12-column grid) into pixel rectangles for a given panel width. board.js reads the row height and gap from the design
// tokens (`calc(var(--ctl-h) * 2)`, `var(--s3)`) and passes them in; nothing here knows a pixel constant of its own.
//
//   wide panel     column width = (panel − 11 gaps) / 12; a widget is w columns × h rows, gaps included between cells
//   narrow panel   below STACK_BELOW the grid is unusable (a 2-column widget would be ~110px), so widgets stack full width
//                  in reading order (top to bottom, then left to right), each keeping its row count
import { LIMITS } from "../Core/validate.js";

/** Panel widths under this many pixels stack the widgets (a phone-width board). */
export const STACK_BELOW = 720;

export const isStacked = (panelWidth) => panelWidth < STACK_BELOW;

/** One column's width in pixels (never negative). */
export const columnWidth = (panelWidth, gap, cols = LIMITS.gridCols) => Math.max(0, (panelWidth - gap * (cols - 1)) / cols);

/** Reading order: by row, then column (what a stacked board shows). */
export const widgetOrder = (widgets) => [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);

const span = (n, unit, gap) => n * unit + (n - 1) * gap;

/**
 * Where every widget sits. `metrics` = { rowH, gap, stack? } in pixels; `stack: true` stacks whatever the width (print). Returns { stacked, height, rects: Map(id → { left, top, width, height }) };
 * `height` is the canvas height — the bottom of the lowest widget (at most 96 rows).
 */
export function layoutBoard(widgets, panelWidth, { rowH, gap, stack = false }) {
  const width = Math.max(0, panelWidth);
  const stacked = stack || isStacked(width);
  const rects = new Map();
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
