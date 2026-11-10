import test from "node:test";
import assert from "node:assert/strict";
import { createPerfLog, formatPerfText, queryKindOf, rowCountOf } from "../../src/DashboardBuilder/Features/Core/perf-log.js";

test("records entries newest-last and keeps only whitelisted numeric/boolean/kind fields", () => {
  const log = createPerfLog({ capacity: 5, now: () => 1000 });
  log.record({ kind: "query", ms: 12.4, rows: 7, cached: false, password: "x", sql: "SELECT 'secret'", value: "leak" });
  const [e] = log.entries();
  assert.deepEqual(e, { at: 1000, kind: "query", ms: 12, rows: 7, cached: false, renderMs: null, outcome: "ok" });
});

test("ring buffer drops the oldest past capacity", () => {
  const log = createPerfLog({ capacity: 3 });
  for (let i = 0; i < 5; i++) log.record({ kind: "query", ms: i });
  assert.deepEqual(log.entries().map((e) => e.ms), [2, 3, 4]);
});

test("unknown kinds and bad numbers are normalised", () => {
  const log = createPerfLog();
  log.record({ kind: "weird; DROP", ms: -5, rows: NaN, renderMs: "abc" });
  const [e] = log.entries();
  assert.equal(e.kind, "other");
  assert.equal(e.ms, 0);
  assert.equal(e.rows, null);
  assert.equal(e.renderMs, null);
});

test("attachRender adds render ms to the newest entry, then falls back to a render-only entry", () => {
  const log = createPerfLog();
  log.record({ kind: "query", ms: 5 });
  log.attachRender(33.6);
  assert.equal(log.entries()[0].renderMs, 34);
  log.attachRender(1); // already has one: a new render-only entry
  assert.equal(log.entries().length, 2);
  assert.equal(log.entries()[1].kind, "render");
});

test("clear empties, subscribers are told", () => {
  const log = createPerfLog();
  let n = 0;
  const off = log.subscribe(() => n++);
  log.record({ kind: "query", ms: 1 });
  log.clear();
  assert.equal(log.entries().length, 0);
  assert.equal(n, 2);
  off(); log.record({ kind: "query", ms: 1 });
  assert.equal(n, 2);
});

test("entries() returns copies", () => {
  const log = createPerfLog();
  log.record({ kind: "query", ms: 1 });
  log.entries()[0].ms = 999;
  assert.equal(log.entries()[0].ms, 1);
});

test("queryKindOf reads the request-key prefix; rowCountOf handles result shapes", () => {
  assert.equal(queryKindOf('query:{"a":1}'), "query");
  assert.equal(queryKindOf("histogram:{}"), "histogram");
  assert.equal(queryKindOf("nope:{}"), "other");
  assert.equal(rowCountOf({ rows: [1, 2] }), 2);
  assert.equal(rowCountOf({ bins: [1] }), 1);
  assert.equal(rowCountOf({ groups: [1, 2, 3] }), 3);
  assert.equal(rowCountOf(null), null);
});

test("formatPerfText gives a header and one line per entry; an empty log says so", () => {
  const log = createPerfLog({ now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
  log.record({ kind: "query", ms: 120, rows: 9, cached: false });
  log.record({ kind: "query", ms: 0, rows: 9, cached: true });
  log.attachRender(15);
  const t = formatPerfText(log.entries());
  const lines = t.split("\n");
  assert.match(lines[0], /^time\tkind\tquery ms\trows\tcache\trender ms$/);
  assert.equal(lines.length, 1 + 2);
  assert.match(lines[1], /\tquery\t120\t9\tmiss\t$/);
  assert.match(lines[2], /\tquery\t0\t9\thit\t15$/);
  assert.equal(formatPerfText([]), "No timings recorded.");
});

test("a throwing subscriber never breaks recording or other subscribers", () => {
  const log = createPerfLog();
  let ok = 0;
  log.subscribe(() => { throw new Error("boom"); });
  log.subscribe(() => ok++);
  assert.doesNotThrow(() => log.record({ kind: "query", ms: 1 }));
  assert.doesNotThrow(() => log.clear());
  assert.equal(ok, 2);
});

test("outcome defaults to ok, accepts failed/aborted, and normalises anything else", () => {
  const log = createPerfLog();
  log.record({ kind: "query", ms: 5 });
  log.record({ kind: "query", ms: 7, outcome: "failed" });
  log.record({ kind: "histogram", ms: 9, outcome: "aborted" });
  log.record({ kind: "query", ms: 1, outcome: "'; DROP" });
  assert.deepEqual(log.entries().map((e) => e.outcome), ["ok", "failed", "aborted", "ok"]);
});

test("a failed or aborted entry never takes a render time", () => {
  const log = createPerfLog();
  log.record({ kind: "query", ms: 5, outcome: "failed" });
  log.attachRender(10);
  assert.equal(log.entries()[0].renderMs, null);
  assert.equal(log.entries()[1].kind, "render");
});

test("formatPerfText shows failed and aborted in the cache column", () => {
  const log = createPerfLog({ now: () => 0 });
  log.record({ kind: "query", ms: 30, outcome: "failed" });
  log.record({ kind: "query", ms: 4, outcome: "aborted" });
  const [, a, b] = formatPerfText(log.entries()).split("\n");
  assert.match(a, /\tquery\t30\t\tfailed\t$/);
  assert.match(b, /\tquery\t4\t\taborted\t$/);
});

test("attachRender with a handle times that entry, not a later comparison entry (ok or failed)", () => {
  for (const cmpOutcome of ["ok", "failed"]) {
    const log = createPerfLog();
    const main = log.record({ kind: "query", ms: 20, rows: 3 });
    log.record({ kind: "query", ms: 9, outcome: cmpOutcome });
    log.attachRender(15, main);
    const [m, c] = log.entries();
    assert.equal(m.renderMs, 15);
    assert.equal(c.renderMs, null);
    assert.equal(log.entries().length, 2); // no render-only row
  }
});

test("attachRender with a cleared handle adds a render-only entry instead", () => {
  const log = createPerfLog();
  const h = log.record({ kind: "query", ms: 1 });
  log.clear();
  log.attachRender(5, h);
  assert.deepEqual(log.entries().map((e) => e.kind), ["render"]);
});
