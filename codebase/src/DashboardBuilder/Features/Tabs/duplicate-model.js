// Pure logic for "Duplicate" on a worksheet tab: the copy's name, the limit check, and the sheet copy.

const SUFFIX = /( copy)( \d+)?$/;

/** A unique "<name> copy" / "<name> copy N" within `max` characters; a copy of a copy re-uses the base name. */
export function copyName(name, existing, max) {
  const taken = new Set(existing);
  const base = name.replace(SUFFIX, "") || name;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " copy" : ` copy ${n}`;
    const candidate = base.slice(0, Math.max(1, max - suffix.length)).trimEnd() + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The tab limit (LIMITS.tabs covers worksheets and dashboards). */
export function canDuplicate(count, limit) {
  return count < limit ? { ok: true } : { ok: false, error: `A workbook holds at most ${limit} tabs.` };
}

/** Deep copy of a sheet with the transient state reset: no selection, drill back at the top, pages at the first member (members reload). */
export function copySheet(sheet) {
  const c = structuredClone(sheet);
  c.selection = null;
  if (c.drill) { c.drill.depth = 0; c.drill.path = []; }
  if (c.pages) { c.pages.index = 0; delete c.pages.members; delete c.pages.loadError; delete c.pages.more; }
  return c;
}
