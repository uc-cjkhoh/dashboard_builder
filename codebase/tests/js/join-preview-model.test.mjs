import { test } from "node:test";
import assert from "node:assert/strict";
import { previewRequest, pct, observedCardinality, describePreview, repeatsMaterially, MATERIAL_AVG } from "../../src/DashboardBuilder/Features/Relations/join-preview-model.js";

const side = (o) => ({ rows: 100, nullRows: 0, keys: 100, matchedKeys: 100, matchedRows: 100, maxDuplicates: 1, avgDuplicates: 1, ...o });
const result = (from, to, extra = {}) => ({ from: side(from), to: side(to), sampleLimit: 1000000, sampled: false, ...extra });
const names = { fromTable: "orders", toTable: "customers", fromColumn: "cust_id", toColumn: "id" };

test("the request names both keys' db, table and column and nothing else", () => {
  const e = (table) => ({ db: "shop", table });
  assert.deepEqual(previewRequest(e("orders"), "cust_id", e("customers"), "id"),
    { from: { db: "shop", table: "orders", column: "cust_id" }, to: { db: "shop", table: "customers", column: "id" } });
});

test("percentages are whole numbers, never a false 0% or 100%", () => {
  assert.equal(pct(0.94), "94%");
  assert.equal(pct(0), "0%");
  assert.equal(pct(1), "100%");
  assert.equal(pct(0.001), "<1%");
  assert.equal(pct(0.999), ">99%");
});

test("observed cardinality reads the repeats on each side (FROM is the first letter)", () => {
  const o = (f, t) => observedCardinality(result({ maxDuplicates: f }, { maxDuplicates: t }));
  assert.equal(o(1, 1), "1:1");
  assert.equal(o(1, 5), "1:N");
  assert.equal(o(7, 1), "N:1");
  assert.equal(o(7, 5), "N:M");
});

test("the plain-words summary: matched share, unmatched share, repeats, and the many-to-one reading", () => {
  const r = result({ rows: 1000, keys: 200, matchedKeys: 190, matchedRows: 940, maxDuplicates: 14, avgDuplicates: 5 },
    { rows: 200, keys: 200, matchedKeys: 190, matchedRows: 190, maxDuplicates: 1, avgDuplicates: 1 });
  const d = describePreview(r, { ...names, declared: "N:1" });
  assert.equal(d.observed, "N:1");
  assert.equal(d.summary[0], "94% of the rows in orders have a match in customers; 6% don't.");
  assert.equal(d.summary[1], "95% of the rows in customers have a match in orders; 5% don't.");
  assert.match(d.summary[2], /each cust_id key appears about 5 times in orders/i);
  assert.match(d.summary[2], /each id key appears once in customers/i);
  assert.deepEqual(d.findings.filter((f) => f.level === "warn"), []);
  assert.match(d.verdict, /many-to-one/i);
});

test("declaring one side as 'one' when it repeats keys warns, naming the table and the repeat", () => {
  const r = result({ maxDuplicates: 1 }, { maxDuplicates: 3, avgDuplicates: 2 });
  const d = describePreview(r, { ...names, declared: "N:1" }); // N:1 says customers (TO) is the one side
  const w = d.findings.filter((f) => f.level === "warn");
  assert.equal(w.length, 1);
  assert.match(w[0].text, /customers/);
  assert.match(w[0].text, /declared as the "one" side/);
  assert.match(w[0].text, /up to 3 times/);
});

test("both sides repeating warns about fan-out and double-counted sums, even when declared many-to-many", () => {
  const r = result({ maxDuplicates: 4, avgDuplicates: 2 }, { maxDuplicates: 6, avgDuplicates: 3 });
  for (const declared of ["N:M", "1:N", undefined]) {
    const w = describePreview(r, { ...names, declared }).findings.filter((f) => f.level === "warn");
    assert.ok(w.some((f) => /many-to-many/i.test(f.text) && /double-count/i.test(f.text)), `declared ${declared}`);
  }
});

test("a declaration that agrees with the data draws no warning; with no declaration (a new link) a suggestion is made", () => {
  const r = result({ maxDuplicates: 1 }, { maxDuplicates: 9, avgDuplicates: 4 });
  assert.deepEqual(describePreview(r, { ...names, declared: "1:N" }).findings.filter((f) => f.level === "warn"), []);
  assert.match(describePreview(r, { ...names }).verdict, /1:N/);
});

test("NULL keys, zero matches, sampling and empty tables are called out", () => {
  const d = describePreview(result({ rows: 100, nullRows: 20, keys: 80, matchedKeys: 0, matchedRows: 0 }, { matchedKeys: 0, matchedRows: 0 }, { sampled: true, sampleLimit: 500 }), { ...names, declared: "1:1" });
  assert.ok(d.findings.some((f) => f.level === "info" && /20% of orders rows have no cust_id/.test(f.text)));
  assert.ok(d.findings.some((f) => f.level === "info" && /can't tell from a sample/i.test(f.text)));
  assert.ok(d.findings.some((f) => /first 500 rows of each table/.test(f.text)));
  const e = describePreview(result({ rows: 0, keys: 0, matchedKeys: 0, matchedRows: 0, maxDuplicates: 0 }), { ...names });
  assert.ok(e.findings.some((f) => /empty/i.test(f.text)));
  assert.equal(e.summary.length, 0);
});

test("every finding has a level and plain text", () => {
  const d = describePreview(result({ maxDuplicates: 3 }, { maxDuplicates: 3 }), { ...names, declared: "1:1" });
  for (const f of d.findings) { assert.ok(["warn", "info"].includes(f.level)); assert.equal(typeof f.text, "string"); }
});

test("a single repeated key is not material; a side repeats materially when its average repeat reaches MATERIAL_AVG", () => {
  assert.equal(MATERIAL_AVG, 1.1);
  assert.equal(repeatsMaterially(side({ maxDuplicates: 2, avgDuplicates: 1.001 })), false);
  assert.equal(repeatsMaterially(side({ maxDuplicates: 1, avgDuplicates: 1 })), false);
  assert.equal(repeatsMaterially(side({ maxDuplicates: 3, avgDuplicates: 1.1 })), true);
});

test("one stray duplicate key on both sides is a note, not a fan-out warning", () => {
  const r = result({ maxDuplicates: 2, avgDuplicates: 1.001 }, { maxDuplicates: 2, avgDuplicates: 1.002 });
  const d = describePreview(r, { ...names, declared: "N:M" });
  assert.deepEqual(d.findings.filter((f) => f.level === "warn"), []);
  assert.ok(d.findings.some((f) => f.level === "info" && /few keys repeat on both sides/i.test(f.text)));
});

test("declared 1:1 but both sides repeat gives ONE warning that names the declaration", () => {
  const r = result({ maxDuplicates: 4, avgDuplicates: 2 }, { maxDuplicates: 6, avgDuplicates: 3 });
  const w = describePreview(r, { ...names, declared: "1:1" }).findings.filter((f) => f.level === "warn");
  assert.equal(w.length, 1);
  assert.match(w[0].text, /many-to-many/); assert.match(w[0].text, /double-count/); assert.match(w[0].text, /declared 1:1/);
});

const sampled = (from, to) => result(from, to, { sampled: true, sampleLimit: 500 });
test("a sampled result opens with the sampling caveat and words every share 'within the sample'", () => {
  const d = describePreview(sampled({ rows: 500, matchedRows: 400, matchedKeys: 80 }, { rows: 500, matchedRows: 100, matchedKeys: 20 }), { ...names });
  assert.match(d.findings[0].text, /^Based on the first 500 rows of each table, in no particular order/);
  assert.equal(d.findings[0].level, "info");
  assert.match(d.summary[0], /^Within the sample, 80% of the rows read from orders have a match in customers/);
  assert.match(d.summary[1], /^Within the sample, 20% of the rows read from customers/);
  assert.match(d.verdict, /within the sample/i);
});

test("sampled and no matches: no amber 'no keys match' warning, a neutral can't-tell note instead", () => {
  const d = describePreview(sampled({ matchedKeys: 0, matchedRows: 0 }, { matchedKeys: 0, matchedRows: 0 }), { ...names, declared: "1:1" });
  assert.ok(!d.findings.some((f) => /No keys match at all/.test(f.text)));
  assert.deepEqual(d.findings.filter((f) => f.level === "warn"), []);
  assert.ok(d.findings.some((f) => f.level === "info" && /can't tell from a sample/i.test(f.text)));
});

test("sampled: both sides repeating is information only (overlap is unknown); a side declared 'one' that repeats still warns (a repeat is a fact)", () => {
  const both = describePreview(sampled({ maxDuplicates: 4, avgDuplicates: 2 }, { maxDuplicates: 6, avgDuplicates: 3 }), { ...names, declared: "N:M" });
  assert.deepEqual(both.findings.filter((f) => f.level === "warn"), []);
  assert.ok(both.findings.some((f) => /may be many-to-many/i.test(f.text)));
  const one = describePreview(sampled({}, { maxDuplicates: 3, avgDuplicates: 2 }), { ...names, declared: "N:1" });
  assert.equal(one.findings.filter((f) => f.level === "warn").length, 1);
});

test("a full (not sampled) result still warns on no matches", () => {
  const d = describePreview(result({ matchedKeys: 0, matchedRows: 0 }, { matchedKeys: 0, matchedRows: 0 }), { ...names });
  assert.ok(d.findings.some((f) => f.level === "warn" && /No keys match at all/.test(f.text)));
});
