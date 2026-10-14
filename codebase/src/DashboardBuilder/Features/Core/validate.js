// Pure input parsers (no DOM) shared by every form. Each returns { ok: true, value } or
// { ok: false, error } — a user-facing sentence. Mirrors ClickHouse/RequestValidation.cs: keep LIMITS and
// the host messages identical on both sides.
export const LIMITS = Object.freeze({
  host: 253, user: 64, password: 256, tabName: 60, axisTitle: 80, filterValue: 1000,
  // The user's OWN filters. The server allows 16 per query (these + drill path + page + selection).
  filters: 8,
  sharedFilters: 4, // P40: filters shared by every dashboard (server MaxFilters 20 = 8 + 4 + drill 5 + page + selection + date range)
  fieldChoices: 8,
  bookmarks: 30,
  fieldSettings: 2000, // P28: renamed / hidden / default-aggregation fields per workbook    // P39: saved views per workbook  // P40: alternative fields one shelf slot can switch between
  inValues: 500, dashboards: 50, pillsPerShelf: 20,
  entities: 100,       // tables on the canvas a workbook may open
  relationships: 200,  // links a workbook may open
  dimensions: 12, measures: 10, // per view (server MaxDimensions / MaxMeasures)
  drillLevels: 6, // keeps user filters (8) + drill path (≤5) + page + selection within the server's 16
  rows: 5000, // groups one chart query returns: Top-N "All" (server MaxRowLimit); the Table pages instead
  exportRows: 100000, // rows in a CSV export (server MaxExportRows)
});
export const HOST_MESSAGES = Object.freeze({
  scheme: "Enter the host name only — no http:// or https://.",
  port: "Enter the host name only — put the port in Port.",
  path: "Enter the host name only — no path.",
  invalid: "Enter a valid host name or IP address.",
});
const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });
const HOSTNAME = /^[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/;
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const isIPv6 = (s) => /^[0-9A-Fa-f:.]+$/.test(s) && (() => { try { new URL(`http://[${s}]/`); return true; } catch { return false; } })();

export function host(raw) {
  const h = String(raw ?? "").trim();
  if (!h) return fail("Host is required.");
  if (h.length > LIMITS.host) return fail(`Host must be at most ${LIMITS.host} characters.`);
  if (h.includes("://")) return fail(HOST_MESSAGES.scheme);
  if (h.includes("/")) return fail(HOST_MESSAGES.path);
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    if (close < 0) return fail(HOST_MESSAGES.invalid);
    if (close !== h.length - 1) return fail(HOST_MESSAGES.port);
    return isIPv6(h.slice(1, close)) ? ok(h) : fail(HOST_MESSAGES.invalid);
  }
  if ((h.match(/:/g) ?? []).length >= 2) return isIPv6(h) ? ok(h) : fail(HOST_MESSAGES.invalid);
  if (h.includes(":")) return fail(HOST_MESSAGES.port);
  return HOSTNAME.test(h) ? ok(h) : fail(HOST_MESSAGES.invalid);
}
export function port(raw) {
  const p = String(raw ?? "").trim();
  if (!p) return fail("Port is required.");
  const n = /^\d{1,5}$/.test(p) ? Number(p) : NaN;
  return n >= 1 && n <= 65535 ? ok(n) : fail("Port must be a whole number from 1 to 65535.");
}
export function text(raw, { label, max, required = false, trim = true }) {
  const s = String(raw ?? "");
  const v = trim ? s.trim() : s;
  if (required && !v.trim()) return fail(`${label} is required.`);
  if (v.length > max) return fail(`${label} must be at most ${max} characters.`);
  return ok(v);
}
export function number(raw) {
  const s = String(raw ?? "").trim();
  const n = PLAIN_NUMBER.test(s) ? Number(s) : NaN;
  return Number.isFinite(n) ? ok(n) : fail(`'${raw}' is not a number.`);
}
export function dateTime(raw) {
  const m = ISO.exec(String(raw ?? "").trim());
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", se = "00"] = m;
    const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
    const real = t.getUTCFullYear() === +y && t.getUTCMonth() === +mo - 1 && t.getUTCDate() === +d && t.getUTCHours() === +h && t.getUTCMinutes() === +mi;
    if (real) return ok(m[4] === undefined ? `${y}-${mo}-${d}` : `${y}-${mo}-${d} ${h}:${mi}:${se}`);
  }
  return fail(`'${raw}' is not a date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS).`);
}
export function filterValue(category, raw, column) {
  const s = String(raw ?? "");
  if (!s.trim()) return fail(`Enter a value for ${column}.`);
  if (s.length > LIMITS.filterValue) return fail(`A filter value must be at most ${LIMITS.filterValue} characters.`);
  switch (category) {
    case "numeric": { const r = number(s); return r.ok ? r : fail(`'${s}' is not a number for column ${column}.`); }
    case "temporal": { const r = dateTime(s); return r.ok ? r : fail(`'${s}' is not a date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS) for column ${column}.`); }
    case "boolean": {
      const b = s.trim().toLowerCase();
      if (b === "true" || b === "1") return ok("true");
      if (b === "false" || b === "0") return ok("false");
      return fail(`'${s}' is not true or false for column ${column}.`);
    }
    case "text": return ok(s);
    default: return fail(`Column ${column} can't be filtered — its type can't be compared.`);
  }
}
export function range(category, lo, hi, column) {
  const a = filterValue(category, lo, column);
  if (!a.ok) return a;
  const b = filterValue(category, hi, column);
  if (!b.ok) return b;
  const inverted = category === "numeric" ? a.value > b.value : category === "temporal" ? a.value > b.value : false;
  return inverted ? fail(`From must be less than or equal to To for column ${column}.`) : ok([a.value, b.value]);
}
