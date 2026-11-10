import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, rememberWorkbook, forgetWorkbook, sanitizeWorkbooks, workbookKey, ago, describe, MAX_WORKBOOKS } from "../../src/DashboardBuilder/Features/Start/start-model.js";

const view = (o = {}) => ({ connected: true, host: "ch1", port: 8443, user: "ann", secure: true, allowInvalidCertificate: false, ...o });
const sum = { tables: 2, worksheets: 3, dashboards: 1, stories: 0 };

test("summarize counts the saved workbook's parts and tolerates missing lists", () => {
  assert.deepEqual(summarize({ entities: [1, 2], worksheets: [1], dashboards: [], stories: [1] }), { tables: 2, worksheets: 1, dashboards: 0, stories: 1 });
  assert.deepEqual(summarize({}), { tables: 0, worksheets: 0, dashboards: 0, stories: 0 });
});
test("remembering keeps only non-secret metadata, never data, names or a password", () => {
  const out = rememberWorkbook([], { ...view(), password: "hunter2", host: "ch1" }, { ...sum, secret: "x" }, 1000);
  assert.deepEqual(out, [{ host: "ch1", port: 8443, user: "ann", secure: true, allowInvalidCert: false, savedAt: 1000, ...sum }]);
  assert.ok(!JSON.stringify(out).includes("hunter2"));
});
test("one entry per server and user, most recent first, capped", () => {
  let l = rememberWorkbook([], view({ host: "a" }), sum, 1);
  l = rememberWorkbook(l, view({ host: "b" }), sum, 2);
  l = rememberWorkbook(l, view({ host: "a" }), { ...sum, tables: 9 }, 3);
  assert.deepEqual(l.map((e) => [e.host, e.savedAt, e.tables]), [["a", 3, 9], ["b", 2, 2]]);
  for (let i = 0; i < 10; i++) l = rememberWorkbook(l, view({ host: `h${i}` }), sum, 10 + i);
  assert.equal(l.length, MAX_WORKBOOKS);
});
test("an empty workbook is not remembered, and removes the entry", () => {
  let l = rememberWorkbook([], view(), sum, 1);
  l = rememberWorkbook(l, view(), { tables: 0, worksheets: 0, dashboards: 0, stories: 0 }, 2);
  assert.deepEqual(l, []);
});
test("sanitize drops malformed entries and unknown fields", () => {
  const out = sanitizeWorkbooks([{ host: "x", port: 8443, user: "u", secure: true, savedAt: 5, ...sum, password: "p" }, { host: "", port: 1, user: "u" }, null, "x", { host: "y", port: 99999, user: "u", savedAt: 1 }]);
  assert.equal(out.length, 1); assert.ok(!("password" in out[0]));
  assert.deepEqual(sanitizeWorkbooks("nope"), []);
});
test("forget removes by key", () => {
  const l = rememberWorkbook([], view(), sum, 1);
  assert.deepEqual(forgetWorkbook(l, workbookKey(l[0])), []);
});
test("ago words", () => {
  const n = 10 * 86400000;
  assert.equal(ago(n - 20000, n), "just now");
  assert.equal(ago(n - 5 * 60000, n), "5 min ago");
  assert.equal(ago(n - 3 * 3600000, n), "3 h ago");
  assert.equal(ago(n - 86400000, n), "yesterday");
  assert.equal(ago(n - 4 * 86400000, n), "4 days ago");
  assert.equal(ago(n - 40 * 86400000, n), "over a month ago");
});
test("describe lists non-zero parts with plurals", () => {
  assert.equal(describe(sum), "2 tables · 3 worksheets · 1 dashboard");
  assert.equal(describe({ tables: 1, worksheets: 0, dashboards: 0, stories: 1 }), "1 table · 1 story");
});
