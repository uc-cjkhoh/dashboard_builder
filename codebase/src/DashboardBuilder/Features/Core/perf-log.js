// Performance recording — pure, DOM-free (unit-tested under tests/js/). A bounded in-memory ring of
// query and render timings. It stores only the query kind, durations, a row count and whether the
// result came from the browser cache — never a request body, a SQL text, a value or a credential.
// Nothing is sent anywhere: the log lives in this tab and goes with it.

export const KINDS = Object.freeze(["query", "histogram", "boxplot", "render", "other"]);
const DEFAULT_CAPACITY = 200;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null);

/** The kind of a request key (`requestKey(kind, …)` in query-runner.js): the text before the first colon. */
export function queryKindOf(key) {
  const kind = String(key ?? "").split(":", 1)[0];
  return KINDS.includes(kind) && kind !== "render" ? kind : "other";
}

/** How many rows a query result holds (query rows, histogram bins or box-plot groups), or null. */
export function rowCountOf(result) {
  for (const k of ["rows", "bins", "groups"]) if (Array.isArray(result?.[k])) return result[k].length;
  return null;
}

/** A ring buffer of timing entries `{ at, kind, ms, rows, cached, renderMs }`; oldest dropped past `capacity`. */
export function createPerfLog({ capacity = DEFAULT_CAPACITY, now = Date.now } = {}) {
  let list = [];
  const subs = new Set();
  const notify = () => { for (const fn of subs) fn(); };
  const push = (entry) => { list.push(entry); if (list.length > capacity) list = list.slice(list.length - capacity); };
  return {
    /** Record one entry. Only the whitelisted fields are kept; everything else is ignored. */
    record(e = {}) {
      push({ at: now(), kind: KINDS.includes(e.kind) ? e.kind : "other", ms: num(e.ms) ?? 0, rows: num(e.rows),
        cached: e.cached === true, renderMs: num(e.renderMs) });
      notify();
    },
    /** Attach a render time to the newest entry when it has none yet; otherwise add a render-only entry. */
    attachRender(ms) {
      const last = list[list.length - 1];
      if (last && last.kind !== "render" && last.renderMs === null) { last.renderMs = num(ms); notify(); }
      else this.record({ kind: "render", ms: 0, renderMs: ms });
    },
    entries: () => list.map((e) => ({ ...e })),
    clear() { list = []; notify(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/** The shared log for this page. */
export const perfLog = createPerfLog();

const pad = (n) => String(n).padStart(2, "0");
const clock = (t) => { const d = new Date(t); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };

/** The entries as tab-separated text (header + one line each), for copying out. */
export function formatPerfText(entries) {
  if (!entries.length) return "No timings recorded.";
  const head = "time\tkind\tquery ms\trows\tcache\trender ms";
  return [head, ...entries.map((e) => [clock(e.at), e.kind, e.ms, e.rows ?? "", e.kind === "render" ? "" : e.cached ? "hit" : "miss", e.renderMs ?? ""].join("\t"))].join("\n");
}
