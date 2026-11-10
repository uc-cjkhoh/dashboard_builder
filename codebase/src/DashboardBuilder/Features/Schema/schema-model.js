// Pure rules for the schema browser (no DOM): which databases are system ones, and the last database picked per server.
// tests/js/schema-model.test.mjs. The memory holds only a database name per host/port/user — no secrets.
const SYSTEM = new Set(["system", "information_schema"]);
export const MAX_REMEMBERED = 20;

export function splitDatabases(list) {
  const user = [], system = [];
  for (const db of list) (SYSTEM.has(String(db).toLowerCase()) ? system : user).push(db);
  return { user, system };
}

export const dbMemoryKey = (v) => `${v.host}|${v.port}|${v.user}`;

export const sanitizeDbMemory = (m) => (m && typeof m === "object" && !Array.isArray(m)
  ? Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "string" && v !== "").slice(-MAX_REMEMBERED))
  : {});

export function rememberDb(m, view, db) {
  const next = { ...sanitizeDbMemory(m) };
  const key = dbMemoryKey(view);
  delete next[key]; // newest last, so the oldest entries fall off first
  next[key] = db;
  return sanitizeDbMemory(next);
}

/** The remembered database for this server if it is still in `dbs`, else "". */
export function recallDb(m, view, dbs) {
  const db = sanitizeDbMemory(m)[dbMemoryKey(view)];
  return db && dbs.includes(db) ? db : "";
}
