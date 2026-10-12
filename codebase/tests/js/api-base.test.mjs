// The API base path is derived from api.js's own URL so the app works at the site root or under a
// reverse-proxy prefix. api.js is served from /features/Core/ (feature-folder layout, D19).
import { test } from "node:test";
import assert from "node:assert/strict";
import { basePathFrom } from "../../src/DashboardBuilder/Features/Core/api.js";

test("under a proxy prefix the base is the prefix", () => {
  assert.equal(basePathFrom("https://10.168.49.20:8443/dashboardbuilder/features/Core/api.js"), "/dashboardbuilder");
});

test("at the site root the base is empty", () => {
  assert.equal(basePathFrom("http://localhost:5080/features/Core/api.js"), "");
});
