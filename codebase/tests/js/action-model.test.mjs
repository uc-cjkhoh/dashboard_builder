import { test } from "node:test";
import assert from "node:assert/strict";
import { templateError, buildActionUrl, cleanAction } from "../../src/DashboardBuilder/Features/Dashboard/action-model.js";

test("a good template builds an encoded https link", () => {
  assert.equal(templateError("https://crm.example.com/customers/{value}"), null);
  assert.deepEqual(buildActionUrl("https://crm.example.com/c/{value}?from=dash", "A&B / C"),
    { url: "https://crm.example.com/c/A%26B%20%2F%20C?from=dash" });
  assert.equal(buildActionUrl("https://x.example/{value}/{value}", 7).url, "https://x.example/7/7");
});
test("only https, with a host and a {value}", () => {
  for (const bad of ["http://x.example/{value}", "javascript:alert(1)//{value}", "data:text/html,{value}",
    "//x.example/{value}", "https://x.example/item", "https:// x.example/{value}", "", "ftp://x/{value}"])
    assert.ok(templateError(bad), bad);
});
test("a value can't break out of its slot", () => {
  const r = buildActionUrl("https://x.example/q?id={value}", "1&admin=true#frag");
  assert.equal(new URL(r.url).searchParams.get("id"), "1&admin=true#frag");
  assert.equal(new URL(r.url).hostname, "x.example");
  const host = buildActionUrl("https://{value}.example/", "evil.com/");
  assert.ok(host.error || new URL(host.url).hostname !== "evil.com"); // encoded: the value can't become the host
});
test("no value, no link", () => {
  assert.match(buildActionUrl("https://x.example/{value}", null).error, /no value/);
});
test("saved actions are checked", () => {
  const issues = [];
  assert.deepEqual(cleanAction({ label: "", template: "https://x.example/{value}" }, "S", issues), { label: "Open link", template: "https://x.example/{value}" });
  assert.equal(cleanAction({ label: "Go", template: "http://x.example/{value}" }, "S", issues), null);
  assert.equal(cleanAction(null, "S", issues), null);
  assert.equal(issues.length, 1);
});

import { cleanParamAction, applyParamAction } from "../../src/DashboardBuilder/Features/Dashboard/action-model.js";

test("a saved parameter action is checked", () => {
  const issues = [];
  assert.deepEqual(cleanParamAction({ param: "prm3" }, "S", issues), { param: "prm3" });
  assert.equal(cleanParamAction(null, "S", issues), null);
  assert.equal(issues.length, 0);
  assert.equal(cleanParamAction({ param: "x; drop" }, "S", issues), null);
  assert.equal(cleanParamAction("prm1", "S", issues), null);
  assert.equal(issues.length, 2);
});
test("a click sets the parameter to the mark's value", () => {
  const params = [{ id: "prm1", name: "Region", type: "text", value: "EU", allowed: { kind: "any" } },
    { id: "prm2", name: "Top", type: "number", value: 5, allowed: { kind: "range", min: 1, max: 10 } }];
  assert.deepEqual(applyParamAction({ param: "prm1" }, params, "APAC"), { ok: true, id: "prm1", value: "APAC", name: "Region" });
  assert.deepEqual(applyParamAction({ param: "prm2" }, params, "7"), { ok: true, id: "prm2", value: 7, name: "Top" });
});
test("a value the parameter refuses, or a missing parameter, changes nothing", () => {
  const params = [{ id: "prm2", name: "Top", type: "number", value: 5, allowed: { kind: "range", min: 1, max: 10 } }];
  assert.equal(applyParamAction({ param: "prm2" }, params, "99").ok, false);
  assert.equal(applyParamAction({ param: "prm2" }, params, "EU").ok, false);
  assert.equal(applyParamAction({ param: "prm2" }, params, null).ok, false);
  assert.match(applyParamAction({ param: "prm9" }, params, "1").error, /no longer exists/);
});
