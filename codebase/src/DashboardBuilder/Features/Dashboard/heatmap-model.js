// Heatmap shape — pure, DOM-free (tests/js/charts1.test.mjs). Squares fill the grid cell;
// circles are scatter marks over the same category grid, sized by the cell.
export const HEATMAP_SHAPE_CHOICES = [["square", "Squares"], ["circle", "Circles"]];

/** Circle diameter in px for a w × h plot with nx × ny cells: 80 % of the smaller cell side, 6–48 px. */
export function circleSize(w, h, nx, ny) {
  if (!(w > 0 && h > 0 && nx > 0 && ny > 0)) return 6;
  return Math.round(Math.min(48, Math.max(6, Math.min(w / nx, h / ny) * 0.8)));
}

/** Pixels of the chart box the axes, labels and colour legend take (the plot is the rest). */
export const HEATMAP_GUTTER = Object.freeze({ x: 90, y: 80 });

/** The cells that have a value: an empty cell (null, undefined, NaN, non-numeric) draws no circle. */
export const circleCells = (cells) => cells.filter((d) => d[2] != null && Number.isFinite(Number(d[2])));

/** Label type size in px (design rule: 14). */
export const LABEL_FONT = 14;
const CHAR_W = 8, LABEL_PAD = 8, LABEL_H = 20; // 14 px type: ~8 px a character, 4 px each side, one 20 px line

/** Whether `text` fits a cell of w × h px. */
export const labelFits = (w, h, text) => String(text ?? "").length > 0 && h >= LABEL_H && w >= String(text).length * CHAR_W + LABEL_PAD;

/** One cell's px size for a w × h chart with nx × ny categories and the axes' `gutter` ({ x, y }); 0 × 0 when there is no room. */
export function cellSizeOf(w, h, nx, ny, gutter) {
  if (!(w > 0 && h > 0 && nx > 0 && ny > 0)) return { w: 0, h: 0 };
  return { w: Math.max(0, (w - gutter.x) / nx), h: Math.max(0, (h - gutter.y) / ny) };
}

/** Draw the value labels? Forced (Label flyout → Show mark labels) = always; otherwise only when the longest label fits the cell, so the grid is all or nothing. */
export function labelsShown({ forced, cellW, cellH, texts }) {
  if (forced) return true;
  const longest = texts.reduce((a, t) => (String(t ?? "").length > a.length ? String(t) : a), "");
  return labelFits(cellW, cellH, longest);
}
