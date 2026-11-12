// Stacked bar / column of measures on very different scales — pure, DOM-free (tests/js/heatmap-labels.test.mjs).
// A measure whose largest value is under 2 % of the tallest stack is a sliver a few pixels high: say so in words.

/** A measure below this share of the tallest stack is "nearly invisible". */
export const STACK_TINY = 0.02;

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? 0 : Math.abs(Number(v)));

/** The series (`[{ name, data }]`) whose biggest value is under STACK_TINY of the tallest stack; [] with fewer than two measures that have values. */
export function tinyStackedSeries(series) {
  const live = (series ?? []).filter((s) => (s.data ?? []).some((v) => num(v) > 0));
  if (live.length < 2) return [];
  const n = Math.max(...live.map((s) => s.data.length));
  let tallest = 0;
  for (let i = 0; i < n; i++) tallest = Math.max(tallest, live.reduce((sum, s) => sum + num(s.data[i]), 0));
  return live.filter((s) => Math.max(...s.data.map(num)) < STACK_TINY * tallest);
}

/** The one-line notice (icon + text in the worksheet notice), or null when every measure is visible. */
export function stackedScaleNotice(series) {
  const tiny = tinyStackedSeries(series);
  if (!tiny.length) return null;
  const names = tiny.length <= 2 ? tiny.map((s) => s.name).join(" and ") : `${tiny[0].name}, ${tiny[1].name} and ${tiny.length - 2} more`;
  const many = tiny.length > 1;
  return `${names} ${many ? "are" : "is"} under ${STACK_TINY * 100}% of the tallest stack, so ${many ? "they are" : "it is"} almost invisible. Chart ${many ? "them on their own" : "it on its own"} or use a Combo chart with a second axis.`;
}
