// Gantt bars from a result — pure, DOM-free (tests/js/gantt-model.test.mjs). One dimension is the row, the
// first measure the bar's start (a number, or a date the server returns as text), the second its length. With
// a date start the length counts days. Format → Length can make the second measure the end instead. Rows without a usable start or a
// length >= 0 are skipped and counted.

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

/** Wall-clock days from `a` to `b` (local dates and clock times, so a daylight-saving change does not add an hour). */
function wallDays(a, b) {
  const wall = (ms) => { const t = new Date(ms); return Date.UTC(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds()); };
  return (wall(b) - wall(a)) / DAY;
}

/** Format → Length: the second measure is the bar's length, or the end it runs to. */
export const GANTT_LENGTH_CHOICES = Object.freeze([["length", "Length"], ["end", "End"]]);

/**
 * `second` holds each row's length, or its end with `opts.end`. `opts.slots` (a key per row) puts rows that share a key on one
 * y slot, and `opts.colours` (a member label per row) colours the bars by member; both come from a Colour field.
 * @returns {{ bars: {i, name, start, end, duration, group}[], rows: string[], raws: unknown[] (`opts.raws` of each slot's first row), groups: string[], isDate: boolean, hasTime: boolean, skipped: number }}
 * `i` is the bar's slot on the category axis (a skipped row keeps its slot, so no gap closes); `group` indexes `groups`, -1 with no colours.
 */
export function ganttBars(categories, starts, second, opts = {}) {
  const { end: endMode = false, slots = null, colours = null, raws = null } = opts;
  const dates = starts.map(parseDate);
  const ends = endMode ? second.map(parseDate) : null;
  const isDate = dates.some(Boolean);
  const bars = [], rows = [], groups = [], slotRaws = [];
  const slotOf = new Map(), groupOf = new Map();
  let hasTime = false;
  categories.forEach((name, row) => {
    let i = row;
    if (slots) {
      if (!slotOf.has(slots[row])) { slotOf.set(slots[row], rows.length); rows.push(name); slotRaws.push(raws?.[row]); }
      i = slotOf.get(slots[row]);
    } else { rows.push(name); slotRaws.push(raws?.[row]); }
    let group = -1;
    if (colours) {
      if (!groupOf.has(colours[row])) { groupOf.set(colours[row], groups.length); groups.push(colours[row]); }
      group = groupOf.get(colours[row]);
    }
    const raw = starts[row], sec = second[row];
    let start = null;
    if (isDate) start = dates[row]?.ms ?? null;
    else if (raw != null && raw !== "" && Number.isFinite(Number(raw))) start = Number(raw);
    if (start == null) return;
    let end, duration;
    if (endMode) {
      if (isDate) { end = ends[row]?.ms ?? NaN; duration = wallDays(start, end); }
      else { end = sec == null || sec === "" ? NaN : Number(sec); duration = end - start; }
      if (!Number.isFinite(end) || !Number.isFinite(duration) || duration < 0) return;
      if (isDate && (dates[row].time || ends[row].time)) hasTime = true;
    } else {
      duration = sec == null || sec === "" ? NaN : Number(sec);
      if (!Number.isFinite(duration) || duration < 0) return;
      if (isDate && dates[row].time) hasTime = true; // before the end check: a row whose end can't be placed still counts, as it always did
      end = isDate ? addDays(start, duration) : start + duration;
      if (!Number.isFinite(end)) return; // a length too large to place
    }
    bars.push({ i, name, start, end, duration, group });
  });
  return { bars, rows, groups, raws: slotRaws, isDate, hasTime, skipped: categories.length - bars.length };
}

/**
 * A Colour field splits a Gantt: the result's last key is the colour member and the keys before it name the row.
 * @returns {{ categories: string[], slots: string[]|null, colours: string[]|null, rawRows: unknown[] }} per result row; `rawRows` is
 * each row's first key (what a click filters on). Without a colour field the keys all name the row and slots / colours are null.
 */
export function ganttSplit(rows, fmtCat, hasColour) {
  const n = (r) => (hasColour ? r.keys.length - 1 : r.keys.length);
  const label = (k, i) => (k == null ? "—" : fmtCat(k, i));
  return {
    categories: rows.map((r) => r.keys.slice(0, n(r)).map(label).join(" / ")),
    slots: hasColour ? rows.map((r) => JSON.stringify(r.keys.slice(0, n(r)))) : null,
    colours: hasColour ? rows.map((r) => label(r.keys[n(r)], n(r))) : null,
    rawRows: rows.map((r) => r.keys[0]),
  };
}

const pad = (n) => String(n).padStart(2, "0");
/** A time-axis value as text: the date, plus HH:mm when `withTime`. */
export function ganttTime(ms, withTime) {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** The notice for skipped rows, or null. */
export const ganttNotice = (skipped, end = false) => (skipped
  ? `${skipped} ${skipped === 1 ? "row has" : "rows have"} no valid start or ${end ? "an end that is missing or before the start" : "a negative length"} and ${skipped === 1 ? "is" : "are"} not drawn.` : null);

/** Whether the date axis labels carry the time: the bars have a time and together span under three days. */
export function ganttAxisTime(bars, hasTime) {
  if (!hasTime || !bars.length) return false;
  const span = Math.max(...bars.map((b) => b.end)) - Math.min(...bars.map((b) => b.start));
  return span < 3 * DAY;
}

/** The grid's right margin in px: room for the widest length label (about 8 px a character), at least 56, at most 240. */
export const ganttLabelMargin = (labels) => Math.min(240, Math.max(56, Math.max(0, ...labels.map((l) => String(l).length)) * 8 + 12));
