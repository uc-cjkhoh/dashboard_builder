// Axis labels for a date (or any long-label) category axis: abbreviate datetimes to what varies, then pick
// which labels to draw so none touch — always the first and last, evenly spaced between — and turn a
// bottom axis's labels upright when even three horizontal ones will not fit. Pure: unit-tested in
// tests/js/date-axis.test.mjs; chart.js feeds the result to ECharts (interval + formatter + rotate).

const RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const GAP = { bottom: 8, left: 4 }; // px kept clear between two shown labels
const LINE = 14;                    // px a label occupies along a left axis (and across an upright bottom one)
const pad = (n) => String(n).padStart(2, "0");

/** { y, mo, d, h, mi, s, hasTime, ms } for "YYYY-MM-DD[ HH:MM[:SS]]", else null. */
export function parseDateLabel(label) {
  const m = typeof label === "string" ? RE.exec(label) : null;
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1).map((v) => (v === undefined ? undefined : Number(v)));
  return { y, mo, d, h, mi, s, hasTime: m[4] !== undefined, ms: Date.UTC(y, mo - 1, d, h, mi, s) };
}

/**
 * Datetime labels shortened to the parts that vary across the whole set (same length as `labels`):
 * midnight-only data reads as dates; one day reads as times; one year drops the year; zero seconds drop.
 * `dateOnly` forces the date part alone (used when ticks are days apart). Non-dates come back unchanged.
 */
export function shortDateLabels(labels, { dateOnly = false } = {}) {
  const ps = labels.map(parseDateLabel);
  if (!labels.length || ps.some((p) => !p)) return { texts: [...labels], parsed: null };
  const time = (p) => p.h * 3600 + p.mi * 60 + p.s;
  const timeVaries = ps.some((p) => time(p) !== time(ps[0]));
  const dayVaries = ps.some((p) => p.y !== ps[0].y || p.mo !== ps[0].mo || p.d !== ps[0].d);
  const yearVaries = ps.some((p) => p.y !== ps[0].y);
  const showTime = timeVaries && !dateOnly;
  const showDate = dayVaries || !showTime;
  const showSec = showTime && ps.some((p) => p.s !== 0);
  const showYear = showDate && (yearVaries || !showTime);
  const texts = ps.map((p) => {
    const date = `${showYear ? `${p.y}-` : ""}${pad(p.mo)}-${pad(p.d)}`;
    const t = `${pad(p.h)}:${pad(p.mi)}${showSec ? `:${pad(p.s)}` : ""}`;
    return showDate ? (showTime ? `${date} ${t}` : date) : t;
  });
  return { texts, parsed: ps };
}

// Evenly spread `m` of `n` indices including both ends; backs off until every neighbouring pair is `needPx` apart
// (`endPx` for the pairs at either end, whose outer label is aligned inward rather than centred).
function spread(n, m, slot, needPx, endPx = needPx) {
  const ok = (idx) => idx.every((v, j) => j === 0 || (v - idx[j - 1]) * slot >= (j === 1 || j === idx.length - 1 ? endPx : needPx) - 1e-6);
  const all = Array.from({ length: Math.min(m, n) }, (_, i) => i);
  if (m >= n && ok(all.length === n ? all : [])) return all;
  for (m = Math.min(m, n - 1); m >= 2; m--) {
    const idx = Array.from({ length: m }, (_, j) => Math.round((j * (n - 1)) / (m - 1)));
    if (ok(idx)) return idx;
  }
  return [0, n - 1];
}

function layout(texts, n, length, side, measure) {
  const slot = n > 1 ? (length * (n - 1)) / n / (n - 1) : length; // px between two neighbouring ticks
  const span = slot * (n - 1);
  const widest = texts.reduce((w, t) => Math.max(w, measure(t)), 0);
  if (side === "left") return { indices: spread(n, Math.floor(span / (LINE + GAP.left)) + 1, slot, LINE + GAP.left), rotate: 0 };
  const need = widest + GAP.bottom;
  const flat = spread(n, Math.floor(span / need) + 1, slot, need, need + widest / 2); // first and last labels hang inward, so they sit closer to their neighbour
  const want = Math.min(n, 3);
  if (flat.length >= want) return { indices: flat, rotate: 0 };
  const upright = spread(n, Math.floor(span / (LINE + GAP.left)) + 1, slot, LINE + GAP.left);
  return upright.length > flat.length ? { indices: upright, rotate: 90 } : { indices: flat, rotate: 0 };
}

/**
 * Which labels an axis draws and how.
 * @param labels   every category label, in order
 * @param length   px of axis the ticks spread over (the plot's width for a bottom axis, its height for a left one)
 * @param side     "bottom" | "left"
 * @param measure  (text) => px width of that text in the axis font
 * @returns { indices: shown category indices (ascending, first and last included), texts: label text per category
 *            (parallel to `labels`), rotate: 0 | 90 }
 */
export function axisLabelPlan({ labels, length, side, measure }) {
  const n = labels.length;
  if (n === 0) return { indices: [], texts: [], rotate: 0 };
  if (n === 1) return { indices: [0], texts: shortDateLabels(labels).texts, rotate: 0 };
  const full = shortDateLabels(labels);
  const first = { ...layout(full.texts, n, length, side, measure), texts: full.texts };
  if (!full.parsed || full.texts.every((t) => t.length <= 5)) return first;
  // Ticks a day or more apart do not need their time of day: say the date alone, if that still leaves them a day apart.
  const gap = (ix) => { const g = ix.slice(1).map((v, j) => full.parsed[v].ms - full.parsed[ix[j]].ms).sort((a, b) => a - b); return g.length ? g[g.length >> 1] : 0; };
  if (gap(first.indices) < 864e5 || !full.parsed.some((p) => p.hasTime)) return first;
  const dates = shortDateLabels(labels, { dateOnly: true });
  const second = { ...layout(dates.texts, n, length, side, measure), texts: dates.texts };
  return gap(second.indices) >= 864e5 ? second : first;
}
