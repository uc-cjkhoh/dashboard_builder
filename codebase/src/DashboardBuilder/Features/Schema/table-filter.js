// Pure table search (no DOM).
export function matchTables(names, query) {
  const q = String(query ?? "").trim().toLowerCase();
  return q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
}

/** Arrow-key move in the table list: the next index for `key` from `i` among `n` visible chips, or null for a key it ignores.
 *  Up / Down step (held at the ends), Home / End jump. */
export function listStep(i, key, n) {
  if (!(n > 0)) return null;
  const at = Number.isInteger(i) && i >= 0 && i < n ? i : 0;
  if (key === "ArrowDown") return Math.min(n - 1, at + 1);
  if (key === "ArrowUp") return Math.max(0, at - 1);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}
