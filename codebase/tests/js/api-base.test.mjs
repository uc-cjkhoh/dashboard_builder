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

// --- a lost session is announced (D162) ---------------------------------------------------------------------------------
import { api } from "../../src/DashboardBuilder/Features/Core/api.js";

function stubFetch(handler) {
  const realFetch = globalThis.fetch, realDoc = globalThis.document;
  const doc = new EventTarget(); const seen = [];
  doc.addEventListener("connection:check", () => seen.push("check"));
  globalThis.document = doc;
  globalThis.fetch = handler;
  return { seen, restore() { globalThis.fetch = realFetch; globalThis.document = realDoc; } };
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a 409 'Not connected' fires connection:check and still throws for the caller", async () => {
  const s = stubFetch(async () => json(409, { error: "Not connected to a ClickHouse server." }));
  try {
    await assert.rejects(api.getConnection(), (e) => e.status === 409 && /Not connected/.test(e.message));
    assert.deepEqual(s.seen, ["check"]);
  } finally { s.restore(); }
});

test("the CSV export path announces a lost session too", async () => {
  const s = stubFetch(async () => json(409, { error: "Not connected to a ClickHouse server." }));
  try {
    await assert.rejects(api.exportCsv({}), (e) => e.status === 409);
    assert.deepEqual(s.seen, ["check"]);
  } finally { s.restore(); }
});

test("other failures do not fire connection:check", async () => {
  for (const status of [400, 403, 500, 504]) {
    const s = stubFetch(async () => json(status, { error: "nope" }));
    try {
      await assert.rejects(api.getConnection(), (e) => e.status === status);
      assert.deepEqual(s.seen, [], `status ${status}`);
    } finally { s.restore(); }
  }
});

test("a pinged request that hangs is released by the caller's signal", async () => {
  const s = stubFetch((url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
  }));
  try {
    await assert.rejects(api.pingConnection(AbortSignal.timeout(30)));
    assert.deepEqual(s.seen, []);
  } finally { s.restore(); }
});
