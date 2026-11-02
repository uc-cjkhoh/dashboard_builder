// Gantt bars from a result — pure, DOM-free (tests/js/gantt-model.test.mjs). One dimension is the row, the
// first measure the bar's start (a number, or a date the server returns as text), the second its length. With
// a date start the length counts days. Rows without a usable start or a length >= 0 are skipped and counted.

const DAY = 86400000;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** A start value as { ms, time } for a date text (local time, as the time axis draws it), else null. */
function parseDate(v) {
  const m = typeof v === "string" ? DATE_TEXT.exec(v.trim()) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  const ms = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(ms) ? { ms, time: Boolean(h || mi || s) } : null;
}

/** `start` plus `days` calendar days (the whole part moves the local date, so a DST change keeps the clock time). */
function addDays(start, days) {
  const whole = Math.trunc(days);
  const t = new Date(start);
  t.setDate(t.getDate() + whole);
  const ms = t.getTime() + (days - whole) * DAY;
  return Number.isFinite(new Date(ms).getTime()) ? ms : NaN;
}

/**
 * @returns {{ bars: {i, name, start, end, duration}[], isDate: boolean, hasTime: boolean, skipped: number }}
 * `i` is the row's slot on the category axis (the original index, so skipped rows leave no gap).
 */
export function ganttBars(categories, starts, durations) {
  const dates = starts.map(parseDate);
  const isDate = dates.some(Boolean);
  const bars = [];
  let hasTime = false;
  categories.forEach((name, i) => {
    const raw = starts[i], dur = durations[i];
    const d = dur == null || dur === "" ? NaN : Number(dur);
    let start = null;
    if (isDate) start = dates[i]?.ms ?? null;
    else if (raw != null && raw !== "" && Number.isFinite(Number(raw))) start = Number(raw);
    if (start == null || !Number.isFinite(d) || d < 0) return;
    if (isDate && dates[i].time) hasTime = true;
    const end = isDate ? addDays(start, d) : start + d;
    if (!Number.isFinite(end)) return; // a length too large to place
    bars.push({ i, name, start, end, duration: d });
  });
  return { bars, isDate, hasTime, skipped: categories.length - bars.length };
}

const pad = (n) => String(n).padStart(2, "0");
/** A time-axis value as text: the date, plus HH:mm when `withTime`. */
export function ganttTime(ms, withTime) {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** The notice for skipped rows, or null. */
export const ganttNotice = (skipped) => (skipped
  ? `${skipped} ${skipped === 1 ? "row has" : "rows have"} no valid start or a negative length and ${skipped === 1 ? "is" : "are"} not drawn.` : null);

/** Whether the date axis labels carry the time: the bars have a time and together span under three days. */
export function ganttAxisTime(bars, hasTime) {
  if (!hasTime || !bars.length) return false;
  const span = Math.max(...bars.map((b) => b.end)) - Math.min(...bars.map((b) => b.start));
  return span < 3 * DAY;
}

/** The grid's right margin in px: room for the widest length label (about 8 px a character), at least 56, at most 240. */
export const ganttLabelMargin = (labels) => Math.min(240, Math.max(56, Math.max(0, ...labels.map((l) => String(l).length)) * 8 + 12));
