// Heatmap shape (T03-10) — pure, DOM-free (tests/js/charts1.test.mjs). Squares fill the grid cell;
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
