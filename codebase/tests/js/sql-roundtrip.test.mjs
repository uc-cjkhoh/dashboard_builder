import test from "node:test";
import assert from "node:assert/strict";
import { meaningKept } from "../../src/DashboardBuilder/Features/Core/sql-roundtrip.js";

const cols = [{ name: "a", type: "UInt8" }, { name: "b", type: "String" }];
const base = { ch: "SELECT a, b FROM t", back: "SELECT a, b FROM t WHERE 1", columnsBefore: cols, columnsAfter: cols, syntaxBefore: "SELECT a, b\nFROM t", syntaxAfter: "SELECT a, b\nFROM t" };
const verdict = (over) => meaningKept({ ...base, ...over });

test("the same text back is kept without asking anyone", () => assert.deepEqual(meaningKept({ ch: "SELECT 1", back: "SELECT 1" }), { kept: true, reason: "same" }));
test("a clean round trip is kept: same columns, same way ClickHouse reads it (case and layout aside)", () => {
  assert.deepEqual(verdict({}), { kept: true, reason: "ok" });
  assert.equal(verdict({ syntaxBefore: "SELECT count()\nFROM t", syntaxAfter: "SELECT COUNT() FROM t" }).kept, true);
  assert.equal(verdict({ syntaxBefore: "SELECT ifNull(a, 0) FROM t", syntaxAfter: "SELECT COALESCE(a, 0) FROM t" }).kept, true);
});
test("any meaning-changing repair on the way back means changed, whatever else matches (ilike, case-fold, div-null, nulls-first, and any future one)", () => {
  for (const c of ["ilike", "case-fold", "div-null", "nulls-first", "something-new"]) assert.deepEqual(verdict({ changes: [c] }), { kept: false, reason: "changes" }, c);
  assert.equal(verdict({ changes: [] }).kept, true);
});
test("a round trip ClickHouse refuses (a mangled function name) is changed", () => {
  assert.deepEqual(verdict({ columnsAfter: undefined }), { kept: false, reason: "refused" });
  assert.deepEqual(verdict({ columnsBefore: null }), { kept: false, reason: "refused" });
});
test("different columns are changed", () => assert.deepEqual(verdict({ columnsAfter: [{ name: "a", type: "Nullable(UInt8)" }, cols[1]] }), { kept: false, reason: "columns" }));
test("the same columns read differently by ClickHouse are changed (a changed WHERE, LIKE vs ILIKE, NULL placement)", () => {
  assert.deepEqual(verdict({ syntaxBefore: "SELECT a FROM t WHERE equals(a, 1)", syntaxAfter: "SELECT a FROM t WHERE equals(a, 2)" }), { kept: false, reason: "syntax" });
  assert.equal(verdict({ syntaxBefore: "SELECT a FROM t WHERE like(b, 'x%')", syntaxAfter: "SELECT a FROM t WHERE ilike(b, 'x%')" }).kept, false);
  assert.equal(verdict({ syntaxBefore: "SELECT a FROM t ORDER BY a ASC", syntaxAfter: "SELECT a FROM t ORDER BY a ASC NULLS FIRST" }).kept, false);
});
test("without EXPLAIN anywhere the other checks decide; EXPLAIN working for only one text is a doubt, so changed", () => {
  assert.deepEqual(verdict({ syntaxBefore: null, syntaxAfter: null }), { kept: true, reason: "ok-no-explain" });
  assert.deepEqual(verdict({ syntaxBefore: undefined, syntaxAfter: undefined }), { kept: true, reason: "ok-no-explain" });
  assert.deepEqual(verdict({ syntaxBefore: undefined, syntaxAfter: "SELECT 1" }), { kept: false, reason: "syntax" });
  assert.deepEqual(verdict({ syntaxBefore: "SELECT 1", syntaxAfter: null }), { kept: false, reason: "syntax" });
  assert.equal(verdict({ syntaxBefore: null, syntaxAfter: null, changes: ["case-fold"] }).kept, false);
});
