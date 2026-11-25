// Pure connection-health rules (no DOM). The sidebar dot shows what a probe last proved, never what was true at connect time.
//   ok       — the last probe reached ClickHouse
//   checking — a probe failed once (or is in flight after a failure); not yet called lost
//   lost     — LOST_AFTER probes in a row failed
// A probe that finds the session itself gone is not "lost": the server forgot the connection, so the UI returns to the form.
export const LOST_AFTER = 2;
export const PING_EVERY_MS = 30_000;
// A probe that gets no answer is a failed probe, not a pending one forever. Longer than the server's own SELECT 1 limit
// (ClickHouseGateway.HttpTimeoutSeconds = 15) so its answer normally arrives first; shorter than the interval so probes never overlap.
export const PING_TIMEOUT_MS = 20_000;

export const initialHealth = () => ({ state: "ok", failures: 0 });

/** probe: "ok" | "unreachable" (network error, or ClickHouse refused SELECT 1). Returns the next { state, failures }. */
export function nextHealth(prev, probe) {
  if (probe === "ok") return initialHealth();
  const failures = (prev?.failures ?? 0) + 1;
  return { state: failures >= LOST_AFTER ? "lost" : "checking", failures };
}

/** Maps a /api/connection/ping body to "ok" | "unreachable" | "gone". */
export function readProbe(body) {
  if (!body || body.connected === false) return "gone";
  return body.reachable === false ? "unreachable" : "ok";
}

export const HEALTH_TEXT = { ok: "Connected", checking: "Checking connection", lost: "Connection lost" };
