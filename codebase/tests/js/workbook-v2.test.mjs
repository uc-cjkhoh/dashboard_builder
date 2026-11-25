import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  serializeWorkbook, parseWorkbook, migrateV1, storageKey, legacyStorageKey, WORKBOOK_FORMAT, WORKBOOK_VERSION,
} from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");
const json = (v) => JSON.parse(JSON.stringify(v)); // undefined-free, like a saved file
const v2 = (patch) => JSON.stringify({ format: WORKBOOK_FORMAT, version: 2, entities: [], relationships: [], worksheets: [], dashboards: [], ...patch });
const ws = (name, sheet = {}) => ({ name, sheet });
const widget = (sheet, x, y, w = 6, h = 4) => ({ kind: "sheet", sheet, x, y, w, h });

/** What Workbook/workbook.js does when it opens a parsed workbook: ids and tab order. */
function toStore(wb) {
  const tabs = [];
  const wsIds = wb.worksheets.map((_, i) => `ws#${i + 1}`);
  for (const t of wb.tabs) {
    if (t.kind === "worksheet") tabs.push({ id: wsIds[t.index], kind: "worksheet", name: wb.worksheets[t.index].name, sheet: wb.worksheets[t.index].sheet });
    else {
      const d = wb.dashboards[t.index];
      tabs.push({ id: `db#${t.index + 1}`, kind: "dashboard", name: d.name,
        widgets: d.widgets.map((w, i) => (w.kind === "sheet" ? { id: `w#${i}`, kind: "sheet", sheetId: wsIds[w.sheet], x: w.x, y: w.y, w: w.w, h: w.h } : { id: `w#${i}`, ...w })) });
    }
  }
  const id = (kind, index) => (index === undefined ? null : kind === "worksheet" ? wsIds[index] : `db#${index + 1}`);
  const active = wb.active ? { kind: wb.active.kind, id: id(wb.active.kind, wb.active.index) } : { kind: "model" };
  return {
    entities: new Map(wb.entities.map((e) => [e.id, { ...e, joinKeys: new Set(e.joinKeys) }])),
    relationships: new Map(wb.relationships.map((r, i) => [i, r])),
    tabs, active, theme: wb.theme, sharedFilters: wb.sharedFilters, fieldMeta: new Map(Object.entries(wb.fields)), parameters: wb.parameters,
    calculations: wb.calculations, nextCalcId: wb.nextCalcId,
  };
}
const roundTrip = (wb) => parseWorkbook(JSON.stringify(serializeWorkbook(toStore(wb))));

// --- v1 golden fixtures -------------------------------------------------------------------------------------
for (const name of ["full", "minimal"]) {
  test(`v1 golden (${name}): opens with identical content and zero issues`, () => {
    const expected = JSON.parse(fixture(`workbook-v1-${name}.expected.json`)); // what the v1 reader produced
    const wb = parseWorkbook(fixture(`workbook-v1-${name}.json`));
    assert.deepEqual(wb.issues, []);
    assert.deepEqual(json(wb.worksheets), expected.dashboards, "worksheets are the v1 dashboards, in order");
    assert.deepEqual(wb.dashboards, []);
    assert.deepEqual(wb.tabs, expected.dashboards.map((_, index) => ({ kind: "worksheet", index })));
    assert.deepEqual(wb.active, expected.active === null ? null : { kind: "worksheet", index: expected.active });
    for (const k of ["entities", "relationships", "theme", "sharedFilters", "fields", "parameters", "calculations", "nextCalcId"]) {
      assert.deepEqual(wb[k] === undefined ? undefined : json(wb[k]), expected[k], k);
    }
  });

  test(`v1 golden (${name}): v1 -> v2 -> serialize -> parse is stable`, () => {
    const first = parseWorkbook(fixture(`workbook-v1-${name}.json`));
    const file = serializeWorkbook(toStore(first));
    assert.equal(file.version, 2);
    assert.equal(file.dashboards.length, 0);
    const again = parseWorkbook(JSON.stringify(file));
    assert.deepEqual(again.issues, []);
    assert.deepEqual(json(again), json(first));
  });
}

test("v1 golden (full): the fixture's specifics survive", () => {
  const wb = parseWorkbook(fixture("workbook-v1-full.json"));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Revenue", "Trend", "Customers", "Status mix"]);
  assert.deepEqual(wb.active, { kind: "worksheet", index: 2 });
  assert.equal(wb.worksheets[0].sheet.title, "Revenue by region");
  assert.equal(wb.theme.accent, "teal");
  assert.equal(wb.calculations[0].name, "Margin");
  assert.equal(wb.nextCalcId, 2);
});

test("migrateV1 maps dashboards to worksheets, and active, and leaves malformed parts for the reader", () => {
  const m = migrateV1({ format: WORKBOOK_FORMAT, version: 1, dashboards: [ws("A"), ws("B")], active: 1 });
  assert.equal(m.version, 2);
  assert.deepEqual(m.worksheets.map((w) => w.name), ["A", "B"]);
  assert.equal(m.dashboards, undefined);
  assert.deepEqual(m.active, { kind: "worksheet", index: 1 });
  assert.equal(migrateV1({ version: 1, active: null }).active, null);
  assert.equal(migrateV1({ version: 1, active: "x" }).active, "x");
  assert.equal(migrateV1({ version: 1, dashboards: 5 }).worksheets, 5);
});

test("a v1 file with garbage reports it (as worksheets) instead of opening silently", () => {
  const wb = parseWorkbook(JSON.stringify({ format: WORKBOOK_FORMAT, version: 1, dashboards: [5, { name: "A", sheet: {} }], active: 9 }));
  assert.equal(wb.worksheets.length, 1);
  assert.ok(wb.issues.some((i) => /not a worksheet/.test(i)));
  assert.ok(wb.issues.some((i) => /active tab/.test(i)));
  assert.equal(wb.active, null);
});

// --- v2 -----------------------------------------------------------------------------------------------------
test("version is 2 and files from a newer build are refused", () => {
  assert.equal(WORKBOOK_VERSION, 2);
  assert.throws(() => parseWorkbook(JSON.stringify({ format: WORKBOOK_FORMAT, version: 3 })), /newer version/);
  assert.throws(() => parseWorkbook(JSON.stringify({ format: WORKBOOK_FORMAT, version: 0 })), /version number/);
});

test("serialize: worksheets, dashboards, strip order, and active", () => {
  const sheet = emptySheet();
  const tabs = [
    { id: "ws#1", kind: "worksheet", name: "Sales", sheet },
    { id: "db#1", kind: "dashboard", name: "Board", widgets: [
      { id: "w#1", kind: "sheet", sheetId: "ws#2", x: 6, y: 0, w: 6, h: 4 },
      { id: "w#2", kind: "text", heading: "Hi", body: "there", x: 0, y: 4, w: 12, h: 1 },
      { id: "w#3", kind: "sheet", sheetId: "ws#gone", x: 0, y: 5, w: 6, h: 4 },
    ] },
    { id: "ws#2", kind: "worksheet", name: "Ops", sheet },
  ];
  const f = serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs, active: { kind: "dashboard", id: "db#1" } });
  assert.equal(f.version, 2);
  assert.deepEqual(f.worksheets.map((w) => w.name), ["Sales", "Ops"]);
  assert.deepEqual(f.dashboards, [{ name: "Board", widgets: [
    { kind: "sheet", sheet: 1, x: 6, y: 0, w: 6, h: 4 },
    { kind: "text", heading: "Hi", body: "there", x: 0, y: 4, w: 12, h: 1 },
  ] }]);
  assert.deepEqual(f.tabs, [{ kind: "worksheet", index: 0 }, { kind: "dashboard", index: 0 }, { kind: "worksheet", index: 1 }]);
  assert.deepEqual(f.active, { kind: "dashboard", index: 0 });
  const model = serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs, active: { kind: "model" } });
  assert.equal(model.active, null);
  assert.equal(serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs: [], active: { kind: "model" } }).tabs.length, 0);
});

test("a mixed workbook round-trips: order, widgets, active dashboard", () => {
  const file = v2({
    worksheets: [ws("Sales"), ws("Ops")],
    dashboards: [{ name: "Overview", widgets: [widget(1, 0, 0), widget(0, 6, 0), { kind: "text", heading: "Notes", body: "b", x: 0, y: 4, w: 12, h: 2 }] }, { name: "Empty", widgets: [] }],
    tabs: [{ kind: "dashboard", index: 0 }, { kind: "worksheet", index: 0 }, { kind: "dashboard", index: 1 }, { kind: "worksheet", index: 1 }],
    active: { kind: "dashboard", index: 1 },
  });
  const wb = parseWorkbook(file);
  assert.deepEqual(wb.issues, []);
  assert.deepEqual(wb.tabs.map((t) => `${t.kind}${t.index}`), ["dashboard0", "worksheet0", "dashboard1", "worksheet1"]);
  assert.deepEqual(wb.active, { kind: "dashboard", index: 1 });
  assert.deepEqual(wb.dashboards[0].widgets[0], widget(1, 0, 0));
  const again = roundTrip(wb);
  assert.deepEqual(again.issues, []);
  assert.deepEqual(json(again), json(wb));
});

test("a dashboard may show the same worksheet twice and several dashboards may share one", () => {
  const wb = parseWorkbook(v2({ worksheets: [ws("A")], dashboards: [{ name: "D1", widgets: [widget(0, 0, 0), widget(0, 6, 0)] }, { name: "D2", widgets: [widget(0, 0, 0)] }] }));
  assert.deepEqual(wb.issues, []);
  assert.equal(wb.dashboards[0].widgets.length, 2);
});

test("tab order: bad entries are skipped, unlisted tabs are appended, all reported", () => {
  const wb = parseWorkbook(v2({ worksheets: [ws("A"), ws("B")], dashboards: [{ name: "D", widgets: [] }],
    tabs: [{ kind: "worksheet", index: 1 }, { kind: "worksheet", index: 1 }, { kind: "dashboard", index: 9 }, { kind: "x", index: 0 }, null] }));
  assert.deepEqual(wb.tabs, [{ kind: "worksheet", index: 0 }, { kind: "worksheet", index: 1 }, { kind: "dashboard", index: 0 }]); // B first in the file's order => the cleaned list is in strip order
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["B", "A"]);
  assert.ok(wb.issues.some((i) => /points at nothing/.test(i)));
  assert.ok(wb.issues.some((i) => /missing from the tab order/.test(i)));
});

test("no tabs list (hand-made file): worksheets then dashboards, no issue; a non-list is reported", () => {
  const wb = parseWorkbook(v2({ worksheets: [ws("A")], dashboards: [{ name: "D", widgets: [] }] }));
  assert.deepEqual(wb.issues, []);
  assert.deepEqual(wb.tabs, [{ kind: "worksheet", index: 0 }, { kind: "dashboard", index: 0 }]);
  assert.ok(parseWorkbook(v2({ worksheets: [ws("A")], tabs: "x" })).issues.some((i) => /tab order/.test(i)));
});

test("tabs past 50 are dropped and reported; widgets of cut worksheets are handled", () => {
  const worksheets = Array.from({ length: 49 }, (_, i) => ws(`W${i}`));
  const wsLast = ws("Cut"); // index 49, 51st tab once the two dashboards are listed first
  const wb = parseWorkbook(v2({
    worksheets: [...worksheets, wsLast],
    dashboards: [{ name: "D", widgets: [widget(0, 0, 0), widget(49, 6, 0)] }, { name: "D2", widgets: [] }],
    tabs: [{ kind: "dashboard", index: 0 }, ...worksheets.map((_, i) => ({ kind: "worksheet", index: i })), { kind: "dashboard", index: 1 }, { kind: "worksheet", index: 49 }],
    active: { kind: "worksheet", index: 49 },
  }));
  assert.equal(wb.tabs.length, LIMITS.tabs);
  assert.equal(wb.worksheets.length, 49);
  assert.equal(wb.dashboards.length, 1);
  assert.equal(wb.dashboards[0].widgets.length, 1);
  assert.equal(wb.active, null);
  assert.ok(wb.issues.some((i) => /first 50 tabs/.test(i)));
  assert.ok(wb.issues.some((i) => /worksheet is missing/.test(i)));
  assert.ok(wb.issues.some((i) => /active tab/.test(i)));
});

test("exactly 50 tabs of mixed kinds open without issue", () => {
  const wb = parseWorkbook(v2({ worksheets: Array.from({ length: 30 }, (_, i) => ws(`W${i}`)), dashboards: Array.from({ length: 20 }, (_, i) => ({ name: `D${i}`, widgets: [] })) }));
  assert.equal(wb.tabs.length, 50);
  assert.deepEqual(wb.issues, []);
});

test("import validation repairs dashboard widgets and reports it", () => {
  const wb = parseWorkbook(v2({ worksheets: [ws("A")], dashboards: [{ name: "D", widgets: [
    widget(0, 0, 0), widget(0, 2, 1), widget(5, 0, 8), { kind: "sheet", sheet: 0, x: 0, y: 200, w: 40, h: 1 },
  ] }] }));
  const w = wb.dashboards[0].widgets;
  assert.equal(w.length, 3);
  assert.deepEqual([w[1].x, w[1].y], [6, 0]); // overlap moved to the first free spot
  assert.deepEqual([w[2].w, w[2].h], [12, 2]); // clamped
  assert.ok(w[2].y + w[2].h <= 96);
  assert.ok(wb.issues.some((i) => /Dashboard "D"/.test(i) && /overlap/.test(i)));
  assert.ok(wb.issues.some((i) => /worksheet is missing/.test(i)));
});

test("a dashboard with no name or a non-text name is reset and reported; a non-list of dashboards is reported", () => {
  const wb = parseWorkbook(v2({ dashboards: [{ widgets: [] }, { name: 3, widgets: [] }] }));
  assert.deepEqual(wb.dashboards.map((d) => d.name), ["Dashboard", "Dashboard"]);
  assert.equal(wb.issues.length, 2);
  assert.ok(parseWorkbook(v2({ dashboards: 5 })).issues.some((i) => /dashboards weren't a list/.test(i)));
  assert.ok(parseWorkbook(v2({ worksheets: {} })).issues.some((i) => /worksheets weren't a list/.test(i)));
});

test("storage keys: v2 now, v1 for the fallback read", () => {
  const view = { connected: true, host: "h", port: 8123, user: "u" };
  assert.equal(storageKey(view), "dashboardbuilder.workbook.v2|h|8123|u");
  assert.equal(legacyStorageKey(view), "dashboardbuilder.workbook.v1|h|8123|u");
  assert.equal(storageKey({ connected: false }), null);
  assert.equal(legacyStorageKey({ connected: false }), null);
});

test("parameters in formulas: formula text and step size round-trip, version unchanged; a reference line keeps / loses its parameter", () => {
  const param = { id: "prm1", name: "Rate", type: "number", allowed: { kind: "range", min: 0, max: 1, step: 0.05 }, value: 0.2 };
  const sheet = { analytics: { ref: { kind: "constant", value: 3, param: "prm1" } } };
  const gone = { analytics: { ref: { kind: "constant", value: 3, param: "prm7" } } };
  const file = v2({ parameters: [param], calculations: [{ id: "calc1", name: "Taxed", formula: "SUM([orders.amount]) * [@Rate]" }], worksheets: [ws("A", sheet), ws("B", gone)] });
  const wb = parseWorkbook(file);
  assert.equal(wb.calculations[0].formula, "SUM([orders.amount]) * [@Rate]");
  assert.equal(wb.parameters[0].allowed.step, 0.05);
  assert.equal(wb.worksheets[0].sheet.analytics.ref.param, "prm1");
  assert.equal(wb.worksheets[1].sheet.analytics.ref.param, undefined);
  assert.ok(wb.issues.some((i) => /reference line's parameter is missing/.test(i)));
  const out = serializeWorkbook(toStore(wb));
  assert.equal(out.version, 2);
  assert.equal(out.calculations[0].formula, "SUM([orders.amount]) * [@Rate]");
});

// --- dashboard groups on the tab strip: groupSlot + collapsed (optional dashboard fields; no version bump) ----------
const dbTab = (name, extra = {}) => ({ id: `db#${name}`, kind: "dashboard", name, widgets: [], size: null, notes: "", ...extra });
const saveTabs = (tabs) => json(serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs, active: null }));

test("serialize writes groupSlot and collapsed only when set", () => {
  const out = saveTabs([dbTab("A", { groupSlot: 3, collapsed: true }), dbTab("B", { groupSlot: 2, collapsed: false }), dbTab("C")]);
  assert.equal(out.version, WORKBOOK_VERSION);
  assert.deepEqual([out.dashboards[0].groupSlot, out.dashboards[0].collapsed], [3, true]);
  assert.equal(out.dashboards[1].groupSlot, 2);
  assert.equal("collapsed" in out.dashboards[1], false);
  assert.equal("groupSlot" in out.dashboards[2] || "collapsed" in out.dashboards[2], false);
});

test("groupSlot and collapsed round-trip with no issue", () => {
  const wb = parseWorkbook(JSON.stringify(saveTabs([dbTab("A", { groupSlot: 5, collapsed: true }), dbTab("B", { groupSlot: 1 })])));
  assert.deepEqual(wb.dashboards.map((d) => [d.groupSlot, d.collapsed]), [[5, true], [1, undefined]]);
  assert.deepEqual(wb.issues, []);
});

test("a file saved without the fields opens, and the fields are absent", () => {
  const wb = parseWorkbook(v2({ dashboards: [{ name: "D", widgets: [] }] }));
  assert.deepEqual([wb.dashboards[0].groupSlot, wb.dashboards[0].collapsed], [undefined, undefined]);
  assert.deepEqual(wb.issues, []);
});

test("a bad groupSlot (0, 8, 2.5, \"3\") is dropped with an issue each and the file still opens", () => {
  const wb = parseWorkbook(v2({ dashboards: [0, 8, 2.5, "3"].map((s, i) => ({ name: `D${i}`, widgets: [], groupSlot: s })) }));
  assert.equal(wb.dashboards.length, 4);
  assert.ok(wb.dashboards.every((d) => d.groupSlot === undefined));
  assert.equal(wb.issues.filter((m) => m.includes("group colour")).length, 4);
});

test("collapsed: \"yes\" is dropped with an issue; false is read as open", () => {
  const wb = parseWorkbook(v2({ dashboards: [{ name: "A", widgets: [], collapsed: "yes" }, { name: "B", widgets: [], collapsed: false }] }));
  assert.deepEqual(wb.dashboards.map((d) => d.collapsed), [undefined, undefined]);
  assert.equal(wb.issues.filter((m) => m.includes("collapsed")).length, 1);
});

test("duplicate slots are kept (more than seven dashboards must repeat colours)", () => {
  const wb = parseWorkbook(v2({ dashboards: [{ name: "A", widgets: [], groupSlot: 2 }, { name: "B", widgets: [], groupSlot: 2 }] }));
  assert.deepEqual(wb.dashboards.map((d) => d.groupSlot), [2, 2]);
  assert.deepEqual(wb.issues, []);
});
