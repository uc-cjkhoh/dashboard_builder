// Worksheet query plumbing (roadmap items 1–3): latest-wins requests, a per-dashboard result cache,
// and the truncation notice. Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLatestGate, createResultCache, isAbortError, truncationNotice,
} from "../../src/DashboardBuilder/Features/Dashboard/query-runner.js";

test("a newer request supersedes the older one", () => {
  const gate = createLatestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
});

test("starting a newer request aborts the older one's fetch", () => {
  const gate = createLatestGate();
  const first = gate.begin();
  gate.begin();
  assert.equal(first.signal.aborted, true);
});

test("cancel makes the in-flight request stale and aborts it", () => {
  const gate = createLatestGate();
  const ticket = gate.begin();
  gate.cancel();
  assert.equal(ticket.isCurrent(), false);
  assert.equal(ticket.signal.aborted, true);
});

test("an AbortError is recognised so it can be ignored silently", () => {
  assert.equal(isAbortError(new DOMException("aborted", "AbortError")), true);
  assert.equal(isAbortError(new Error("Query failed")), false);
});

test("the cache returns the stored result for the same request", () => {
  const cache = createResultCache();
  cache.set("dash#1", "query:{a:1}", { rows: [1, 2] });
  assert.deepEqual(cache.get("dash#1", "query:{a:1}"), { rows: [1, 2] });
});

test("the cache misses when the request changed", () => {
  const cache = createResultCache();
  cache.set("dash#1", "query:{a:1}", { rows: [1] });
  assert.equal(cache.get("dash#1", "query:{a:2}"), undefined);
});

test("each dashboard keeps its own cached result", () => {
  const cache = createResultCache();
  cache.set("dash#1", "k", { rows: [1] });
  cache.set("dash#2", "k", { rows: [2] });
  assert.deepEqual(cache.get("dash#1", "k"), { rows: [1] });
});

test("a cached result can't be corrupted by the renderer mutating it", () => {
  const cache = createResultCache();
  cache.set("dash#1", "k", { rows: [3, 1, 2] });
  cache.get("dash#1", "k").rows.sort();
  assert.deepEqual(cache.get("dash#1", "k"), { rows: [3, 1, 2] });
});

test("clearing a dashboard forces the next run to re-query", () => {
  const cache = createResultCache();
  cache.set("dash#1", "k", { rows: [1] });
  cache.clear("dash#1");
  assert.equal(cache.get("dash#1", "k"), undefined);
});

test("no notice when the result is complete", () => {
  assert.equal(truncationNotice({ truncated: false, chartType: "bar", limit: 50 }), null);
});

test("a truncated chart says how many are shown and how to see more", () => {
  const note = truncationNotice({ truncated: true, chartType: "bar", limit: 50 });
  assert.match(note, /top 50/);
  assert.match(note, /Top-N/);
});

test("a truncated table says how many rows are shown", () => {
  const note = truncationNotice({ truncated: true, chartType: "table", limit: 500 });
  assert.match(note, /first 500 rows/);
});

test("going back to an earlier request is served from the cache (e.g. paging back)", () => {
  const cache = createResultCache();
  cache.set("dash#1", "page=a", { rows: ["a"] });
  cache.set("dash#1", "page=b", { rows: ["b"] });
  assert.deepEqual(cache.get("dash#1", "page=a"), { rows: ["a"] });
});

test("each dashboard keeps only its most recent results", () => {
  const cache = createResultCache({ perScope: 2 });
  cache.set("dash#1", "k1", 1);
  cache.set("dash#1", "k2", 2);
  cache.set("dash#1", "k3", 3);
  assert.equal(cache.get("dash#1", "k1"), undefined);
  assert.equal(cache.get("dash#1", "k3"), 3);
});
