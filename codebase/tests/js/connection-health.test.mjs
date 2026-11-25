import test from "node:test";
import assert from "node:assert/strict";
import { nextHealth, initialHealth, readProbe, LOST_AFTER, PING_EVERY_MS, PING_TIMEOUT_MS } from "../../src/DashboardBuilder/Features/Connection/connection-health.js";

test("a good probe is ok and clears failures", () => {
  assert.deepEqual(nextHealth({ state: "lost", failures: 5 }, "ok"), initialHealth());
});
test("one failure is checking, not lost", () => {
  assert.deepEqual(nextHealth(initialHealth(), "unreachable"), { state: "checking", failures: 1 });
});
test(`${LOST_AFTER} failures in a row is lost, and stays lost`, () => {
  let h = initialHealth();
  for (let i = 0; i < LOST_AFTER; i++) h = nextHealth(h, "unreachable");
  assert.equal(h.state, "lost");
  assert.equal(nextHealth(h, "unreachable").state, "lost");
});
test("readProbe tells gone, unreachable and ok apart", () => {
  assert.equal(readProbe({ connected: false }), "gone");
  assert.equal(readProbe(null), "gone");
  assert.equal(readProbe({ connected: true, reachable: false }), "unreachable");
  assert.equal(readProbe({ connected: true, reachable: true }), "ok");
});

test("a probe is given up on after the server's own 15 s probe, and before the next probe starts", () => {
  assert.ok(PING_TIMEOUT_MS >= 15_000, "must outlast the gateway's SELECT 1 timeout so its answer normally arrives first");
  assert.ok(PING_TIMEOUT_MS < PING_EVERY_MS, "probes must never overlap");
});
