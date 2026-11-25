import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_SLOTS, nextGroupSlot, groupMembers, stripItems, displayTabs, neighbourAfterClose, groupKey, cleanGroupSlot, cleanGroupCollapsed, fitTabWidth,
} from "../../src/DashboardBuilder/Features/Tabs/tab-groups-model.js";

const ws = (id) => ({ id, kind: "worksheet", name: id });
const db = (id, sheetIds = [], extra = {}) => ({ id, kind: "dashboard", name: id, widgets: sheetIds.map((s, i) => ({ id: `w${i}`, kind: "sheet", sheetId: s, x: 0, y: i, w: 1, h: 1 })), ...extra });
const story = (id) => ({ id, kind: "story", name: id, steps: [] });
const ids = (list) => list.map((t) => t.id);

test("membership: a dashboard with a sheet widget groups it", () => {
  const tabs = [ws("a"), ws("b"), db("D", ["b"])];
  const g = groupMembers(tabs);
  assert.deepEqual([...g.keys()], ["D"]);
  assert.deepEqual(ids(g.get("D")), ["D", "b"]);
});

test("a text-only dashboard, a dangling sheetId, a story and a loose worksheet stay ungrouped", () => {
  const textOnly = { ...db("T"), widgets: [{ id: "w", kind: "text", heading: "h", body: "b", x: 0, y: 0, w: 1, h: 1 }] };
  const tabs = [ws("loose"), textOnly, db("Dangling", ["gone"]), story("S")];
  assert.equal(groupMembers(tabs).size, 0);
  assert.deepEqual(stripItems(tabs, null).map((i) => i.kind), ["tab", "tab", "tab", "tab"]);
});

test("a worksheet on two dashboards joins the first in stored order, and moves on when that dashboard closes", () => {
  const tabs = [ws("a"), db("D1", ["a"]), db("D2", ["a"])];
  const g = groupMembers(tabs);
  assert.deepEqual(ids(g.get("D1")), ["D1", "a"]);
  assert.equal(g.has("D2"), false); // its only worksheet went to D1, so D2 has nothing left to group
  const afterClose = groupMembers([ws("a"), db("D2", ["a"])]);
  assert.deepEqual(ids(afterClose.get("D2")), ["D2", "a"]);
});

test("stripItems puts the group at the dashboard's slot, dashboard first, worksheets in stored order, and removes them from their own slots", () => {
  const tabs = [ws("a"), ws("loose"), ws("b"), db("D", ["b", "a"]), story("S")];
  const items = stripItems(tabs, null);
  assert.deepEqual(items.map((i) => (i.kind === "tab" ? i.tab.id : `group:${i.dashboard.id}`)), ["loose", "group:D", "S"]);
  assert.deepEqual(ids(items[1].members), ["D", "a", "b"]);
  assert.deepEqual(ids(displayTabs(tabs)), ["loose", "D", "a", "b", "S"]);
});

test("collapsed group: the dashboard stays as the header, worksheets are hidden but the active one; switching away hides it again", () => {
  const tabs = [ws("a"), ws("b"), db("D", ["a", "b"], { collapsed: true })];
  const none = stripItems(tabs, null)[0];
  assert.equal(none.collapsed, true);
  assert.deepEqual([ids(none.shown), none.hidden], [["D"], 2]);
  const withActive = stripItems(tabs, "b")[0];
  assert.deepEqual([ids(withActive.shown), withActive.hidden], [["D", "b"], 1]);
  assert.deepEqual([ids(stripItems(tabs, "D")[0].shown), stripItems(tabs, "D")[0].hidden], [["D"], 2]);
  assert.deepEqual(ids(stripItems(tabs, "elsewhere")[0].shown), ["D"]);
  const open = stripItems([ws("a"), db("D", ["a"])], null)[0];
  assert.deepEqual([open.collapsed, ids(open.shown), open.hidden], [false, ["D", "a"], 0]);
});

test("neighbourAfterClose: right, else left, else null, in display order", () => {
  const tabs = [ws("a"), ws("x"), db("D", ["a"]), ws("y")]; // display: x, D, a, y
  assert.equal(neighbourAfterClose(tabs, "x"), "D");
  assert.equal(neighbourAfterClose(tabs, "D"), "a"); // stored neighbour would be y
  assert.equal(neighbourAfterClose(tabs, "y"), "a"); // last: the left one
  assert.equal(neighbourAfterClose([ws("only")], "only"), null);
  assert.equal(neighbourAfterClose(tabs, "missing"), null);
});

test("nextGroupSlot: 1 for none, lowest unused, evenly repeating, never 8", () => {
  assert.equal(GROUP_SLOTS, 7);
  assert.equal(nextGroupSlot([]), 1);
  assert.equal(nextGroupSlot([1, 2]), 3);
  assert.equal(nextGroupSlot([2, 3]), 1);
  const used = [];
  for (let i = 0; i < 8; i++) used.push(nextGroupSlot(used));
  assert.deepEqual(used, [1, 2, 3, 4, 5, 6, 7, 1]);
  assert.ok(nextGroupSlot([...used, ...used, ...used]) <= 7);
  assert.equal(nextGroupSlot([undefined, 1]), 2);
});

test("groupKey changes on rename, membership, slot and collapsed, not on widget geometry", () => {
  const base = () => [ws("a"), db("D", ["a"], { groupSlot: 1 })];
  const k = groupKey(base());
  assert.equal(groupKey(base()), k);
  const moved = base(); moved[1].widgets[0].x = 9; moved[1].widgets[0].w = 5;
  assert.equal(groupKey(moved), k);
  const renamed = base(); renamed[1].name = "Other";
  const dropped = base(); dropped[1].widgets = [];
  const reslot = base(); reslot[1].groupSlot = 2;
  const collapsed = base(); collapsed[1].collapsed = true;
  for (const t of [renamed, dropped, reslot, collapsed]) assert.notEqual(groupKey(t), k);
});

test("cleanGroupSlot keeps 1..7 and drops anything else with one issue", () => {
  const issues = [];
  assert.equal(cleanGroupSlot(3, "D", issues), 3);
  assert.equal(cleanGroupSlot(undefined, "D", issues), undefined);
  assert.equal(issues.length, 0);
  for (const bad of [0, 8, 2.5, "3", null, -1]) assert.equal(cleanGroupSlot(bad, "D", issues), undefined);
  assert.equal(issues.length, 6);
});

test("cleanGroupCollapsed keeps true, drops false silently and anything else with an issue", () => {
  const issues = [];
  assert.equal(cleanGroupCollapsed(true, "D", issues), true);
  assert.equal(cleanGroupCollapsed(false, "D", issues), undefined);
  assert.equal(cleanGroupCollapsed(undefined, "D", issues), undefined);
  assert.equal(issues.length, 0);
  assert.equal(cleanGroupCollapsed("yes", "D", issues), undefined);
  assert.equal(issues.length, 1);
});

test("fitTabWidth: null while everything fits; otherwise the largest shared cap that fits the room (short tabs keep their width)", () => {
  assert.equal(fitTabWidth([], 100, 36), null);
  assert.equal(fitTabWidth([100, 100, 100], 300, 36), null);
  assert.equal(fitTabWidth([100, 100, 100], 400, 36), null);
  assert.equal(fitTabWidth([100, 100, 300], 400, 36), 200); // 100 + 100 + 200
  assert.equal(fitTabWidth([300, 100, 300], 500, 36), 200); // 200 + 100 + 200: the short one is untouched
  assert.equal(fitTabWidth([150, 150, 150, 150], 400, 36), 100);
});

test("fitTabWidth never goes below the floor (the list then scrolls)", () => {
  assert.equal(fitTabWidth([200, 200, 200], 50, 36), 36);
  assert.equal(fitTabWidth([200, 200], -10, 36), 36);
});
