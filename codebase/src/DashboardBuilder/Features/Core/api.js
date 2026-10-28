// When the app is hosted under a path prefix (e.g. /dashboardbuilder behind a reverse
// proxy), API calls must carry that prefix. Derive it from this module's own URL —
// .../<base>/features/Core/api.js → "/<base>" — so it's "" when served at the site root.
export const basePathFrom = (moduleUrl) =>
  new URL(".", moduleUrl).pathname.replace(/\/features\/Core\/$/i, "");
const BASE = basePathFrom(import.meta.url);

export function errorMessage(status, data) {
  if (data && typeof data.error === "string" && data.error) return data.error;
  if (data && typeof data.title === "string" && data.title) return data.title;
  return status >= 500 ? `Server error (${status}).` : `Request failed (${status}).`;
}
function httpError(status, data) {
  const e = new Error(errorMessage(status, data));
  e.status = status; e.field = data?.field ?? null;
  return e;
}
async function guardedFetch(url, opts) {
  try { return await fetch(url, opts); } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error("Can't reach the server — check your network and try again.");
  }
}

// Thin fetch wrapper for the JSON API. Parses the body, and on a non-2xx response throws
// an Error carrying the server's { error } message so callers can surface it in a toast. An optional
// AbortSignal cancels the request (the worksheet aborts a query a newer one supersedes).
async function request(method, url, body, signal) {
  const opts = { method, headers: {}, signal };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await guardedFetch(BASE + url, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  }

  if (!res.ok) {
    throw httpError(res.status, data);
  }
  return data;
}

export const api = {
  /** Current session connection status (password-free). */
  getConnection: () => request("GET", "/api/connection"),
  /** Validate + store a connection. Resolves to the connection view, or throws with a message. */
  connect: (payload) => request("POST", "/api/connection", payload),
  /** Drop the session connection. Uses POST **with a body** — the Apache proxy 403s DELETE outright and
   *  also 403s body-less POSTs, so a JSON body is required to pass it (like /connection and /query). */
  disconnect: () => request("POST", "/api/connection/disconnect", {}),

  /** List databases on the current connection. */
  databases: () => request("GET", "/api/databases"),
  /** List tables in a database. */
  tables: (db) => request("GET", `/api/databases/${encodeURIComponent(db)}/tables`),
  /** Column names + types (with display category) for a table. */
  columns: (db, table) =>
    request("GET", `/api/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/columns`),
  /** Distinct values of a column for a filter dropdown (P14): bounded string list. */
  distinct: (db, table, column, limit = 200) =>
    request("GET", `/api/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/columns/${encodeURIComponent(column)}/distinct?limit=${encodeURIComponent(limit)}`),
  /** Histogram (P12): equal-width bins over a numeric column → { bins: [{x0, x1, count}] }. */
  histogram: (db, table, plan, { signal } = {}) =>
    request("POST", `/api/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/histogram`, plan, signal),
  /** Box plot (P12): five-number summary per group → { groups: [{label, min, q1, median, q3, max}] }. */
  boxplot: (db, table, plan, { signal } = {}) =>
    request("POST", `/api/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/boxplot`, plan, signal),
  /** Column profile: rows, NULLs, approximate distinct, min/max and top values of one column over the table's first rows. */
  profile: (db, table, req, { signal } = {}) =>
    request("POST", `/api/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}/profile`, req, signal),
  /** Worksheet query (may join related tables): { rowDimensions, columnDimensions, measures, rows,
   *  truncated } — `truncated` is true when more groups exist beyond the plan's limit. */
  query: (plan, { signal } = {}) => request("POST", "/api/query", plan, signal),
  /** Raw rows of one table (POST /api/rows): { columns:[{name,type}], rows:[[text|null]], truncated, limit, columnsTruncated }. */
  rows: (req, { signal } = {}) => request("POST", "/api/rows", req, signal),
  /** Join safety preview (POST /api/relationships/preview): bounded match / duplicate counts for a key pair → { from, to, sampleLimit, sampled }. */
  joinPreview: (req, { signal } = {}) => request("POST", "/api/relationships/preview", req, signal),
  /** Export the worksheet query's rows as CSV text (P13). Bounded server-side; returns raw text. */
  async exportCsv(plan) {
    const res = await guardedFetch(BASE + "/api/query/export.csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan),
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON */ }
      throw httpError(res.status, data);
    }
    return res.text();
  },
};
