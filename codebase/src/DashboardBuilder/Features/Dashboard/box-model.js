// Box plot data (T07-08) — pure: the boxplot series rows (whiskers stop at the Tukey fences) and the outlier points.

/** `[low whisker, Q1, median, Q3, high whisker]` per box; the true min/max when the server sent no whiskers. */
export function boxData(boxes) {
  return boxes.map((b) => [b.lowerWhisker ?? b.min, b.q1, b.median, b.q3, b.upperWhisker ?? b.max]);
}

/** `[category index, value]` per outlier, matched to a box by label (null label = the missing group). */
export function outlierPoints(boxes, outliers) {
  const index = new Map(boxes.map((b, i) => [b.label ?? null, i]));
  const out = [];
  for (const o of outliers ?? []) {
    const i = index.get(o.label ?? null);
    if (i !== undefined) out.push([i, o.value]);
  }
  return out;
}

/** Mirrors ApiLimits.MaxBoxOutliers on the server. */
export const MAX_OUTLIERS = 500;

/** The notice when the server held back outlier points beyond the cap. */
export function outlierNotice(truncated) {
  return truncated ? `Showing the first ${MAX_OUTLIERS} outliers — more exist. Add a filter to narrow it.` : null;
}
