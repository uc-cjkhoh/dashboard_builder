// Pure rules for the schema tree (no DOM): which databases are system ones, and which databases a server's tree has open.
// tests/js/schema-model.test.mjs. The memory holds only database names per host/port/user — no secrets.
const SYSTEM = new Set(["system", "information_schema"]);
export const MAX_REMEMBERED = 20; // servers kept
export const MAX_OPEN = 50;       // open databases kept per server

export function splitDatabases(list) {
  const user = [], system = [];
  for (const db of list) (SYSTEM.has(String(db).toLowerCase()) ? system : user).push(db);
  return { user, system };
}

export const dbMemoryKey = (v) => `${v.host}|${v.port}|${v.user}`;

const cleanState = (s) => ({
  open: [...new Set((Array.isArray(s?.open) ? s.open : []).filter((n) => typeof n === "string" && n !== ""))].slice(-MAX_OPEN),
  system: s?.system === true,
});

/** Stored memory → `{ "host|port|user": { open: [names], system: boolean } }`, cleaned and bounded. */
export const sanitizeOpenMemory = (m) => (m && typeof m === "object" && !Array.isArray(m)
  ? Object.fromEntries(Object.entries(m).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v)).map(([k, v]) => [k, cleanState(v)]).slice(-MAX_REMEMBERED))
  : {});

export function rememberOpen(m, view, state) {
  const next = { ...sanitizeOpenMemory(m) };
  const key = dbMemoryKey(view);
  delete next[key]; // newest last, so the oldest servers fall off first
  next[key] = cleanState(state);
  return sanitizeOpenMemory(next);
}

/** The open set remembered for this server, or null when it has none (a first visit). */
export function recallOpen(m, view) {
  return sanitizeOpenMemory(m)[dbMemoryKey(view)] ?? null;
}
