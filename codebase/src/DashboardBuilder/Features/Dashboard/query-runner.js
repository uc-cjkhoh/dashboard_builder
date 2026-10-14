// Worksheet query plumbing — pure, DOM-free (unit-tested under tests/js/).
//  • createLatestGate: latest-wins requests. Starting a query aborts the previous one and makes its
//    response stale, so a slow older answer can never overwrite a newer chart.
//  • createResultCache: the last result per dashboard, keyed by the exact request. Presentation-only
//    changes (legend, decimals, axis titles…) re-render from it instead of re-querying ClickHouse.
//  • truncationNotice: the "more rows exist" line shown when the server reports a truncated result.

import { LIMITS } from "../Core/validate.js";

/** Latest-wins gate. `begin()` returns a ticket `{ signal, isCurrent }` for one request. */
export function createLatestGate() {
  let seq = 0;
  let controller = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const id = ++seq;
      return { signal: controller.signal, isCurrent: () => id === seq };
    },
    /** Abort the in-flight request (if any) and make its ticket stale. */
    cancel() {
      controller?.abort();
      controller = null;
      seq++;
    },
  };
}

/** True for the rejection a fetch raises when its AbortSignal fires. */
export const isAbortError = (err) => err?.name === "AbortError";

/** The most recent results per scope (dashboard id), least-recently-used evicted past `perScope`.
 *  Results are copied in and out so a renderer that sorts or annotates its input can't corrupt the
 *  cache. Results are bounded server-side (≤ 500 rows), so the memory cost stays small. */
export function createResultCache({ perScope = 16 } = {}) {
  const scopes = new Map(); // scope → Map(key → value), insertion order = recency
  return {
    get(scope, key) {
      const entries = scopes.get(scope);
      if (!entries?.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value); // mark most recently used
      return structuredClone(value);
    },
    set(scope, key, value) {
      let entries = scopes.get(scope);
      if (!entries) scopes.set(scope, (entries = new Map()));
      entries.delete(key);
      entries.set(key, structuredClone(value));
      while (entries.size > perScope) entries.delete(entries.keys().next().value);
    },
    clear(scope) { scopes.delete(scope); },
  };
}

/** The cache key for a request: which endpoint plus the full request body. */
export const requestKey = (kind, request) => `${kind}:${JSON.stringify(request)}`;

/** The notice for a truncated result, or null when the result is complete. */
export function truncationNotice({ truncated, chartType, limit }) {
  if (!truncated) return null;
  const n = Number(limit).toLocaleString("en-US");
  if (chartType === "table" || chartType === "text")
    return `Showing the first ${n} rows — more exist. Add a filter to narrow the table.`;
  // "All" asks for the cap: there is no higher Top-N to raise it to.
  if (limit >= LIMITS.rows) return `Showing the first ${n} in sort order — more exist. Add a filter to narrow it.`;
  return `Showing the first ${n} in sort order — more exist. Raise Top-N in Format, or add a filter.`;
}
