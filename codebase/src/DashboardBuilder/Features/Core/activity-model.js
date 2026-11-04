// What the app is waiting on — pure, DOM-free (unit-tested under tests/js/). Every API request registers here for as long as it is
// in flight, with a plain-words label built ONLY from the method and URL path (database / table / column names the user already sees) —
// never from a request body, so no query text, filter value or credential can reach the screen (golden rule 4).
// Shell/activity-bar.js shows the result; Core/api.js feeds it.

const seg = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** A short present-tense label for one request, e.g. "Loading tables in sales". `path` is the API path without the base prefix. */
export function describeRequest(method, path) {
  const [route] = String(path ?? "").split("?", 1);
  const p = route.replace(/^\/api\//, "").split("/").filter(Boolean).map(seg);
  const m = String(method ?? "GET").toUpperCase();
  const [a, db, b, table, c, column, d] = p;
  if (a === "connection") {
    if (p[1] === "disconnect") return "Disconnecting from ClickHouse";
    return m === "POST" ? "Connecting to ClickHouse" : "Checking the connection";
  }
  if (a === "databases") {
    if (!db) return "Loading databases";
    if (b !== "tables") return `Loading ${db}`;
    if (!table) return `Loading tables in ${db}`;
    if (!c) return `Loading ${table}`;
    if (c === "columns" && !column) return `Loading columns of ${table}`;
    if (c === "columns" && d === "distinct") return `Loading values of ${column} in ${table}`;
    if (c === "histogram") return `Binning ${table} for the histogram`;
    if (c === "boxplot") return `Summarising ${table} for the box plot`;
    if (c === "profile") return `Profiling a column of ${db}.${table}`;
  }
  if (a === "query") return p[1] === "export.csv" ? "Exporting the worksheet as CSV" : "Running the worksheet query";
  if (a === "rows") return "Loading rows";
  if (a === "union") return "Stacking tables to preview the union";
  if (a === "unpivot") return "Turning columns into rows to preview the unpivot";
  if (a === "source" && db === "columns") return "Loading the source's columns";
  if (a === "relationships" && db === "preview") return "Checking how well the join matches";
  return "Loading data";
}

/** Tracks in-flight requests. `snapshot()` → `{ count, labels, oldestMs }` (labels oldest first, de-duplicated with a ×n suffix). */
export function createActivity({ now = Date.now } = {}) {
  const live = new Map(); // id -> { label, at }
  const subs = new Set();
  let seq = 0;
  const notify = () => { for (const fn of subs) { try { fn(); } catch { /* a listener must never break a request */ } } };
  return {
    start(label) { const id = ++seq; live.set(id, { label, at: now() }); notify(); return id; },
    end(id) { if (live.delete(id)) notify(); },
    snapshot() {
      const items = [...live.values()];
      const counts = new Map();
      for (const it of items) counts.set(it.label, (counts.get(it.label) ?? 0) + 1);
      return {
        count: items.length,
        labels: [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)),
        oldestMs: items.length ? Math.max(0, now() - Math.min(...items.map((i) => i.at))) : 0,
      };
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/** The shared tracker for this page. */
export const activity = createActivity();

/** How long a wait has run, in words that don't flicker: "" under 2 s, then "3 s", "1 min 5 s". */
export function elapsedText(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 2) return "";
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The line shown to the user: the oldest request's label, a "+n more" when several run, the elapsed time, and a reassurance on a long wait. */
export function activityLine(snap) {
  if (!snap.count) return "";
  const [first, ...rest] = snap.labels;
  const more = snap.count > 1 ? ` (+${snap.count - 1} more)` : "";
  const t = elapsedText(snap.oldestMs);
  const slow = snap.oldestMs >= 10000 ? " — still waiting on ClickHouse" : "";
  return `${first}…${more}${t ? ` · ${t}` : ""}${slow}`;
}
