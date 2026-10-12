// Pure table search (no DOM).
export function matchTables(names, query) {
  const q = String(query ?? "").trim().toLowerCase();
  return q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
}
