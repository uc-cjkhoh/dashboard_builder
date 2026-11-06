// The zone the UI shows clock times in and takes "today" from — the server puts its id in <meta name="app-timezone"> (Display:TimeZone,
// else the host machine's zone, else Asia/Kuala_Lumpur, UTC+8). Pure helpers: every one takes the zone as an argument (default: the page's).
export const FALLBACK_TZ = "Asia/Kuala_Lumpur";
let cached = null;

const usable = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };

/** The page's zone id (the meta tag), or the fallback when it is missing or unknown to the browser. */
export function appTimeZone() {
  if (cached) return cached;
  const tag = typeof document !== "undefined" && typeof document.querySelector === "function" ? document.querySelector('meta[name="app-timezone"]')?.content : null;
  cached = tag && usable(tag) ? tag : FALLBACK_TZ;
  return cached;
}

const partsOf = (ms, tz) => {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return Object.fromEntries(f.formatToParts(ms).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
};
const two = (n) => String(n).padStart(2, "0");

/** "14:32:05" in the zone. */
export function clockIn(ms, tz = appTimeZone()) { const p = partsOf(ms, tz); return `${two(p.hour)}:${two(p.minute)}:${two(p.second)}`; }
/** "2026-11-03" in the zone. */
export function dateIn(ms, tz = appTimeZone()) { const p = partsOf(ms, tz); return `${p.year}-${two(p.month)}-${two(p.day)}`; }
/** "2026-11-03 14:32:05" in the zone. */
export function dateTimeIn(ms, tz = appTimeZone()) { return `${dateIn(ms, tz)} ${clockIn(ms, tz)}`; }
/** The zone's current calendar date as a local-midnight Date, so `getFullYear()` / `getMonth()` / `getDate()` read the zone's date. */
export function todayIn(tz = appTimeZone(), now = Date.now()) { const p = partsOf(now, tz); return new Date(p.year, p.month - 1, p.day); }
/** "UTC+8", "UTC+5:30", "UTC-3" or "UTC" at that moment. */
export function offsetLabel(tz = appTimeZone(), ms = Date.now()) {
  const name = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!m || (Number(m[2]) === 0 && m[3] === "00")) return "UTC";
  return `UTC${m[1]}${Number(m[2])}${m[3] === "00" ? "" : `:${m[3]}`}`;
}
