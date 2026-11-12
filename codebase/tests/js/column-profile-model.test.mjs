import test from "node:test";
import assert from "node:assert/strict";
import { profileRequest, formatCount, formatShare, roleOf, summarize, PROFILE_LIMITS } from "../../src/DashboardBuilder/Features/Schema/column-profile-model.js";

test("limits mirror the server (ApiLimits.ProfileSampleRows / DefaultProfileTop / MaxProfileTop / MaxColumnName)", () => {
  assert.deepEqual({ ...PROFILE_LIMITS }, { top: 10, maxTop: 50, maxColumn: 1000, sampleRows: 1_000_000, valueLength: 100 });
});
test("profileRequest builds the body and rejects out-of-range input instead of clamping", () => {
  assert.deepEqual(profileRequest("city"), { column: "city", limit: 10 });
  assert.deepEqual(profileRequest("city", 50), { column: "city", limit: 50 });
  assert.throws(() => profileRequest("city", 0), /between 1 and 50/);
  assert.throws(() => profileRequest("city", 51), /between 1 and 50/);
  assert.throws(() => profileRequest("city", 2.5), /between 1 and 50/);
  assert.throws(() => profileRequest(""), /column/i);
  assert.throws(() => profileRequest("x".repeat(1001)), /1000/);
});
test("formatCount groups thousands", () => { assert.equal(formatCount(0), "0"); assert.equal(formatCount(1234567), "1,234,567"); });
test("formatShare: exact zero and full, a floor for tiny shares, never rounds a partial share up to 100", () => {
  assert.equal(formatShare(0, 0), "0%");
  assert.equal(formatShare(0, 10), "0%");
  assert.equal(formatShare(10, 10), "100%");
  assert.equal(formatShare(1, 3), "33%");
  assert.equal(formatShare(1, 1000), "0.1%");
  assert.equal(formatShare(1, 100000), "<0.1%");
  assert.equal(formatShare(4, 100), "4.0%");
  assert.equal(formatShare(99999, 100000), "99.9%");
});
test("role follows the worksheet rule: numeric is a measure, everything else a dimension", () => {
  assert.equal(roleOf("numeric"), "measure");
  for (const c of ["text", "temporal", "boolean", "compound", "other"]) assert.equal(roleOf(c), "dimension");
});

const P = (over = {}) => ({ column: "grp", type: "Nullable(String)", category: "text", rows: 6, nulls: 1, distinct: 3, min: null, max: null,
  top: [{ value: "a", count: 2, cut: false }, { value: "b", count: 2, cut: false }, { value: "", count: 1, cut: false }, { value: null, count: 1, cut: false }], sampled: false, sampleLimit: 1000000, ...over });

test("summarize: tiles, honest wording, no sampling note for a whole table", () => {
  const s = summarize(P());
  assert.deepEqual(s.tiles.map((t) => [t.label, t.value]), [["Rows", "6"], ["Distinct (approx.)", "3"], ["Null share", "17%"]]);
  assert.equal(s.tiles[2].note, "1 of 6 rows");
  assert.equal(s.sampleNote, null);
  assert.equal(s.role, "dimension");
  assert.deepEqual(s.details, [["Name", "grp"], ["Type", "text", "Nullable(String)"], ["Role", "dimension"]]);
});
test("summarize: a sampled profile says so; min/max tiles only when present", () => {
  const s = summarize(P({ rows: 1000000, nulls: 0, distinct: 5000, sampled: true, category: "numeric", min: "5", max: "20" }));
  assert.match(s.sampleNote, /first 1,000,000 rows.*no particular order.*not a statistical sample/i);
  assert.equal(s.cutNote, null);
  assert.deepEqual(s.tiles.map((t) => t.label), ["Rows", "Distinct (approx.)", "Null share", "Min", "Max"]);
  assert.equal(s.tiles[0].note, "first 1,000,000 rows");
  assert.equal(s.role, "measure");
});
test("summarize: top rows carry labels, counts, shares and bar widths; NULL and empty are named, cut values flagged", () => {
  const s = summarize(P({ top: [...P().top, { value: "x".repeat(100), count: 1, cut: true }] }));
  assert.deepEqual(s.top.map((t) => [t.label, t.kind, t.countText, t.shareText]),
    [["a", "value", "2", "33%"], ["b", "value", "2", "33%"], ["(empty)", "empty", "1", "17%"], ["(NULL)", "null", "1", "17%"], ["x".repeat(100) + "…", "value", "1", "17%"]]);
  assert.equal(s.top[0].bar, 33); assert.equal(s.top[4].cut, true);
  assert.match(s.cutNote, /first 100 characters.*differ only after/);
});
test("summarize: an empty table has no tiles' shares to divide and no top values", () => {
  const s = summarize(P({ rows: 0, nulls: 0, distinct: 0, top: [] }));
  assert.equal(s.tiles[2].value, "0%"); assert.equal(s.top.length, 0); assert.equal(s.empty, true);
});
test("copy text: the name, and the plain non-null values (cut values left out)", () => {
  const s = summarize(P({ top: [...P().top, { value: "x".repeat(100), count: 1, cut: true }] }));
  assert.equal(s.copyName, "grp");
  assert.equal(s.copyValues, "a\nb");
});

test("a custom SQL card's profile request carries its query as `source`", () => {
  const source = { kind: "sql", db: "shop", name: "orders", sql: "SELECT city FROM shop.o" };
  assert.deepEqual(profileRequest("city", undefined, source), { column: "city", limit: 10, source });
  assert.equal("source" in profileRequest("city", 5, null), false);
});
