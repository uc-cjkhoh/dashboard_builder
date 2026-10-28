// Bullet target from a field (T03-12) — pure, DOM-free (tests/js/charts1.test.mjs). Format → Target field
// names one of the view's other measures; each category's target is that measure's value there. With no
// field (or one that's gone) the fixed Format → Target number applies to every category.

/** The Target-field choices: [shelfIndex, name] for every measure after the first (the value). */
export const targetChoices = (names) => names.slice(1).map((n, i) => [i + 1, n]);

/** One target per category (null where the field is empty), or null when there is no target at all. */
export function bulletTargets({ fixed, measureIndex, series, count }) {
  const src = Number.isInteger(measureIndex) && measureIndex >= 1 ? series[measureIndex] : null;
  if (src) return Array.from({ length: count }, (_, i) => (src.data[i] == null || !Number.isFinite(Number(src.data[i])) ? null : Number(src.data[i])));
  return fixed == null ? null : Array.from({ length: count }, () => fixed);
}

/** A band's width per category: the share [from, to] of each target (0 where there is none). */
export const bandsFor = (targets, from, to) => targets.map((t) => (t == null ? 0 : t * (to - from)));

/** The target-field index that still points at a measure after the first (else null): a stale index is ignored. */
export const effectiveTargetMeasure = (index, measureCount) => (Number.isInteger(index) && index >= 1 && index < measureCount ? index : null);
