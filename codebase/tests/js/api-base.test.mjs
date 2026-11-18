// The API base path is derived from api.js's own URL so the app works at the site root or under a
// reverse-proxy prefix. api.js is served from /features/Core/ (feature-folder layout, D19).
import { test } from "node:test";
import assert from "node:assert/strict";
import { basePathFrom, errorMessage } from "../../src/DashboardBuilder/Features/Core/api.js";

test("under a proxy prefix the base is the prefix", () => {
  assert.equal(basePathFrom("https://10.168.49.20:8443/dashboardbuilder/features/Core/api.js"), "/dashboardbuilder");
});

test("the content-hash prefix of a versioned module URL is not part of the base", () => {
  assert.equal(basePathFrom("https://10.168.49.20:8443/dashboardbuilder/features/v-0123456789ab/Core/api.js"), "/dashboardbuilder");
  assert.equal(basePathFrom("http://localhost:5080/features/v-0123456789ab/Core/api.js"), "");
});

test("at the site root the base is empty", () => {
  assert.equal(basePathFrom("http://localhost:5080/features/Core/api.js"), "");
});

test("errorMessage prefers {error}, then ProblemDetails title, then a status line", () => {
  assert.equal(errorMessage(400, { error: "Port is required.", field: "port" }), "Port is required.");
  assert.equal(errorMessage(400, { title: "One or more validation errors occurred." }), "One or more validation errors occurred.");
  assert.equal(errorMessage(502, null), "Server error (502).");
  assert.equal(errorMessage(404, null), "Request failed (404).");
});
