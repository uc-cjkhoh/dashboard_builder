// Dashboard groups on the tab strip — pure, no DOM. A dashboard that owns worksheets forms a group: the dashboard tab, then
// its worksheets, drawn together under one coloured underline. Nothing here changes `store.tabs` or the saved tab order; it
// only derives what the strip shows, so a widget edit never rewrites the workbook's order.

/** Colour slots a group can take: --chart-cat-1 … 7 (slot 8 is left unused). */
export const GROUP_SLOTS = 7;

/** The slot for a new dashboard: the lowest one with the fewest uses among `used` (so the first seven are distinct, then they repeat evenly). */
export function nextGroupSlot(used) {
  const counts = new Array(GROUP_SLOTS + 1).fill(0);
  for (const s of used) if (Number.isInteger(s) && s >= 1 && s <= GROUP_SLOTS) counts[s] += 1;
  let best = 1;
  for (let s = 2; s <= GROUP_SLOTS; s++) if (counts[s] < counts[best]) best = s;
  return best;
}

/** dashboard id → [the dashboard, ...the worksheets it owns, in stored order]. A worksheet belongs to the first dashboard (stored order) whose
 *  widgets show it; a dashboard that owns no worksheet is not in the map (it stays an ordinary tab). */
export function groupMembers(tabs) {
  const groups = new Map(), claimed = new Set();
  for (const d of tabs) {
    if (d.kind !== "dashboard") continue;
    const shows = new Set(d.widgets.filter((w) => w.kind === "sheet").map((w) => w.sheetId));
    const owned = tabs.filter((t) => t.kind === "worksheet" && shows.has(t.id) && !claimed.has(t.id));
    if (!owned.length) continue;
    for (const t of owned) claimed.add(t.id);
    groups.set(d.id, [d, ...owned]);
  }
  return groups;
}

/** What the strip draws, in order: `{ kind: "tab", tab }` or `{ kind: "group", dashboard, members, shown, hidden, collapsed }`.
 *  A group sits at its dashboard's stored slot; its worksheets leave their own. The dashboard tab heads the group and is always drawn;
 *  a collapsed group hides its worksheets except the active one (collapsing never changes the view); `hidden` counts the members not drawn. */
export function stripItems(tabs, activeId) {
  const groups = groupMembers(tabs);
  const owned = new Set([...groups.values()].flatMap((m) => m.slice(1).map((t) => t.id)));
  const items = [];
  for (const tab of tabs) {
    if (owned.has(tab.id)) continue;
    const members = groups.get(tab.id);
    if (!members) { items.push({ kind: "tab", tab }); continue; }
    const collapsed = tab.collapsed === true;
    const shown = collapsed ? members.filter((m, i) => i === 0 || m.id === activeId) : members; // the dashboard is the group's header: always drawn
    items.push({ kind: "group", dashboard: tab, members, shown, hidden: members.length - shown.length, collapsed });
  }
  return items;
}

/** Every tab in display order (collapse ignored). */
export const displayTabs = (tabs) => stripItems(tabs, null).flatMap((i) => (i.kind === "tab" ? [i.tab] : i.members));

/** The tab to activate when `id` closes: its right neighbour as displayed, else the left one, else null (the Data Source). */
export function neighbourAfterClose(tabs, id) {
  const list = displayTabs(tabs);
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  return list[i + 1]?.id ?? list[i - 1]?.id ?? null;
}

/** Equal while the groups look the same: membership, order, dashboard names, colours and collapsed flags (not widget geometry). */
export function groupKey(tabs) {
  return JSON.stringify(stripItems(tabs, null).map((i) => (i.kind === "tab" ? i.tab.id
    : [i.dashboard.id, i.dashboard.name, i.dashboard.groupSlot ?? 0, i.collapsed, i.members.map((m) => m.id)])));
}

/** A saved `groupSlot`: an integer 1..7, else dropped with a note (`undefined` = not saved, no note). */
export function cleanGroupSlot(v, where, issues) {
  if (v === undefined) return undefined;
  if (Number.isInteger(v) && v >= 1 && v <= GROUP_SLOTS) return v;
  issues.push(`${where}: its group colour was invalid — reset.`);
  return undefined;
}

/** A saved `collapsed`: `true` is kept; `false` / absent mean open; anything else is dropped with a note. */
export function cleanGroupCollapsed(v, where, issues) {
  if (v === undefined || v === false) return undefined;
  if (v === true) return true;
  issues.push(`${where}: its collapsed flag was invalid — reset.`);
  return undefined;
}

/** The widest one inactive tab may be so that all of `naturals` (their widths, in px, with nothing capped) fit in `room`, shorter tabs keeping their own
 *  width and the longer ones sharing what is left. `null` while everything already fits; never below `floor` (the list scrolls then). */
export function fitTabWidth(naturals, room, floor) {
  if (naturals.reduce((a, b) => a + b, 0) <= room) return null;
  const sorted = [...naturals].sort((a, b) => a - b);
  let left = room;
  for (let i = 0; i < sorted.length; i++) {
    const share = left / (sorted.length - i);
    if (sorted[i] > share) return Math.max(floor, share);
    left -= sorted[i];
  }
  return null;
}
