// Pure rules for the schema tree (no DOM): search over databases and their tables, the per-database row cap, bounded parallel
// loading, and which databases start open. tests/js/tree-model.test.mjs.
export const ROW_LIMIT = 200;   // tables drawn per database before "Show all"
export const LOAD_PARALLEL = 4; // databases listed at once when a search needs them

/** Search the tree. `nodes` are `{ db, tables }` (`tables` null while a database's tables are not loaded). An empty query keeps every node.
 *  A database whose own name matches shows all its tables; otherwise only the tables that match, and a database with none drops out. */
export function filterTree(nodes, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return nodes.map((n) => ({ ...n, nameMatch: false }));
  const out = [];
  for (const n of nodes) {
    const nameMatch = n.db.toLowerCase().includes(q);
    const hits = (n.tables ?? []).filter((t) => t.toLowerCase().includes(q));
    if (nameMatch) out.push({ db: n.db, tables: n.tables, nameMatch });
    else if (hits.length) out.push({ db: n.db, tables: hits, nameMatch });
  }
  return out;
}

/** The rows to draw for one database and how many are held back (`showAll` or a short list holds back none). */
export function capRows(list, showAll, limit = ROW_LIMIT) {
  if (showAll || list.length <= limit) return { rows: list, hidden: 0 };
  return { rows: list.slice(0, limit), hidden: list.length - limit };
}

/** Run `fn` over `items`, at most `limit` at a time; resolves when all are done. `fn` handles its own errors. */
export async function runLimited(items, limit, fn) {
  const queue = [...items];
  const worker = async () => { while (queue.length) await fn(queue.shift()); };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), queue.length) }, worker));
}

/** The databases (and whether the System group) that start open: the remembered set for this server, plus any database that already has
 *  a card on the canvas. A server with no memory opens its first user database so the tree is never a wall of closed folders. */
export function initialOpen({ remembered, user, system, placed = [] }) {
  const all = new Set([...user, ...system]);
  const placedHere = [...new Set(placed)].filter((d) => all.has(d));
  const open = new Set(remembered ? remembered.open.filter((d) => all.has(d)) : []);
  for (const d of placedHere) open.add(d);
  if (!remembered && open.size === 0 && user.length) open.add(user[0]);
  const sys = new Set(system);
  const systemOpen = system.length > 0 && (Boolean(remembered?.system) || placedHere.some((d) => sys.has(d)));
  return { open: [...open], system: systemOpen };
}
