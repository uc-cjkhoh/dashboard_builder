import { test } from "node:test";
import assert from "node:assert/strict";
import {
  overlaps, inBounds, firstFreeSpot, cleanWidgets, placeNew, checkPlacement, removeSheetWidgets, dashboardsUsing, defaultTabName,
  savedWidgets, DEFAULT_SIZE, explainRefusal,
} from "../../src/DashboardBuilder/Features/Board/board-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

const sw = (sheet, x, y, w = 6, h = 4) => ({ kind: "sheet", sheet, x, y, w, h });
const tw = (x, y, w = 12, h = 1, heading = "H", body = "") => ({ kind: "text", heading, body, x, y, w, h });
const clean = (raw, wsCount = 3) => { const issues = []; return { out: cleanWidgets(raw, { worksheetCount: wsCount, where: 'Dashboard "D"' }, issues), issues }; };

test("limits are the spec's numbers", () => {
  assert.equal(LIMITS.tabs, 50);
  assert.equal(LIMITS.widgets, 12);
  assert.equal(LIMITS.gridCols, 12);
  assert.equal(LIMITS.widgetMinW, 2);
  assert.equal(LIMITS.widgetMinH, 2);
  assert.equal(LIMITS.widgetMaxH, 24);
  assert.equal(LIMITS.textMinH, 1);
  assert.equal(LIMITS.boardRows, 96);
  assert.equal(LIMITS.widgetHeading, 80);
  assert.equal(LIMITS.widgetBody, 2000);
  assert.equal(LIMITS.dashboards, undefined);
});

test("overlaps: touching edges do not overlap, shared cells do", () => {
  assert.equal(overlaps({ x: 0, y: 0, w: 6, h: 4 }, { x: 6, y: 0, w: 6, h: 4 }), false);
  assert.equal(overlaps({ x: 0, y: 0, w: 6, h: 4 }, { x: 0, y: 4, w: 6, h: 4 }), false);
  assert.equal(overlaps({ x: 0, y: 0, w: 6, h: 4 }, { x: 5, y: 3, w: 6, h: 4 }), true);
  assert.equal(overlaps({ x: 2, y: 2, w: 2, h: 2 }, { x: 0, y: 0, w: 12, h: 12 }), true);
});

test("inBounds: columns 0..12, rows 0..96", () => {
  assert.equal(inBounds({ x: 6, y: 0, w: 6, h: 4 }), true);
  assert.equal(inBounds({ x: 7, y: 0, w: 6, h: 4 }), false);
  assert.equal(inBounds({ x: -1, y: 0, w: 6, h: 4 }), false);
  assert.equal(inBounds({ x: 0, y: 92, w: 6, h: 4 }), true);
  assert.equal(inBounds({ x: 0, y: 93, w: 6, h: 4 }), false);
});

test("firstFreeSpot scans rows top to bottom, left to right", () => {
  assert.deepEqual(firstFreeSpot([], 6, 4), { x: 0, y: 0 });
  assert.deepEqual(firstFreeSpot([{ x: 0, y: 0, w: 6, h: 4 }], 6, 4), { x: 6, y: 0 });
  assert.deepEqual(firstFreeSpot([{ x: 0, y: 0, w: 6, h: 4 }, { x: 6, y: 0, w: 6, h: 4 }], 6, 4), { x: 0, y: 4 });
  // a gap two cells wide in row 0 fits a 2-wide widget but not a 3-wide one
  const gap = [{ x: 0, y: 0, w: 4, h: 4 }, { x: 6, y: 0, w: 6, h: 4 }];
  assert.deepEqual(firstFreeSpot(gap, 2, 2), { x: 4, y: 0 });
  assert.deepEqual(firstFreeSpot(gap, 3, 2), { x: 0, y: 4 });
  // a short hole under a tall neighbour is used when it fits
  const hole = [{ x: 0, y: 0, w: 6, h: 2 }, { x: 6, y: 0, w: 6, h: 8 }];
  assert.deepEqual(firstFreeSpot(hole, 6, 2), { x: 0, y: 2 });
  assert.deepEqual(firstFreeSpot(hole, 6, 3), { x: 0, y: 2 });
  assert.deepEqual(firstFreeSpot(hole, 6, 7), { x: 0, y: 2 });
});

test("firstFreeSpot returns null when nothing fits under the row limit, and the last row works", () => {
  const full = [{ x: 0, y: 0, w: 12, h: 96 }];
  assert.equal(firstFreeSpot(full, 2, 2), null);
  const almost = [{ x: 0, y: 0, w: 12, h: 94 }];
  assert.deepEqual(firstFreeSpot(almost, 12, 2), { x: 0, y: 94 });
  assert.equal(firstFreeSpot(almost, 12, 3), null);
  assert.equal(firstFreeSpot([], 13, 2), null);
});

test("placeNew: default sizes, first free spot, counts and full-canvas errors", () => {
  assert.deepEqual(DEFAULT_SIZE, { sheet: { w: 6, h: 4 }, text: { w: 12, h: 2 }, image: { w: 6, h: 4 }, spacer: { w: 2, h: 1 } });
  assert.deepEqual(placeNew([], "sheet"), { ok: true, x: 0, y: 0, w: 6, h: 4 });
  assert.deepEqual(placeNew([{ x: 0, y: 0, w: 6, h: 4 }], "sheet"), { ok: true, x: 6, y: 0, w: 6, h: 4 });
  assert.deepEqual(placeNew([{ x: 0, y: 0, w: 6, h: 4 }], "text"), { ok: true, x: 0, y: 4, w: 12, h: 2 });
  const twelve = Array.from({ length: 12 }, (_, i) => ({ x: (i % 2) * 6, y: Math.floor(i / 2) * 4, w: 6, h: 4 }));
  const r = placeNew(twelve, "sheet");
  assert.equal(r.ok, false);
  assert.match(r.error, /12 widgets/);
  const tall = [{ x: 0, y: 0, w: 12, h: 24 }, { x: 0, y: 24, w: 12, h: 24 }, { x: 0, y: 48, w: 12, h: 24 }, { x: 0, y: 72, w: 12, h: 22 }];
  const full = placeNew(tall, "sheet");
  assert.equal(full.ok, false);
  assert.match(full.error, /full/);
});

test("checkPlacement: size, grid and overlap rules (the widget itself is ignored)", () => {
  const others = [{ id: "w#1", kind: "sheet", sheetId: "ws#1", x: 0, y: 0, w: 6, h: 4 }];
  assert.equal(checkPlacement(others, { id: "w#2", kind: "sheet", x: 6, y: 0, w: 6, h: 4 }).ok, true);
  assert.equal(checkPlacement(others, { id: "w#2", kind: "sheet", x: 5, y: 0, w: 6, h: 4 }).ok, false);
  assert.equal(checkPlacement(others, { id: "w#1", kind: "sheet", x: 0, y: 0, w: 12, h: 4 }).ok, true); // itself
  assert.equal(checkPlacement([], { id: "w#2", kind: "sheet", x: 0, y: 0, w: 1, h: 4 }).ok, false);   // too narrow
  assert.equal(checkPlacement([], { id: "w#2", kind: "sheet", x: 0, y: 0, w: 6, h: 1 }).ok, false);   // sheet min h 2
  assert.equal(checkPlacement([], { id: "w#2", kind: "text", x: 0, y: 0, w: 6, h: 1 }).ok, true);     // text min h 1
  assert.equal(checkPlacement([], { id: "w#2", kind: "sheet", x: 0, y: 0, w: 6, h: 25 }).ok, false);
  assert.equal(checkPlacement([], { id: "w#2", kind: "sheet", x: 0, y: 90, w: 6, h: 8 }).ok, false);
  assert.equal(checkPlacement([], { id: "w#2", kind: "sheet", x: 0.5, y: 0, w: 6, h: 4 }).ok, false);
});

test("cleanWidgets keeps a well-formed board unchanged, with no issues", () => {
  const raw = [sw(0, 0, 0), sw(1, 6, 0), tw(0, 4, 12, 2, "Title", "Body text")];
  const { out, issues } = clean(raw);
  assert.deepEqual(out, raw);
  assert.deepEqual(issues, []);
});

test("cleanWidgets: absent or null is an empty board; a non-list is reported", () => {
  assert.deepEqual(clean(undefined).out, []);
  assert.deepEqual(clean(null).issues, []);
  const r = clean("x");
  assert.deepEqual(r.out, []);
  assert.equal(r.issues.length, 1);
});

test("cleanWidgets drops a widget whose worksheet index is missing, and reports it", () => {
  const { out, issues } = clean([sw(0, 0, 0), sw(7, 6, 0), sw(-1, 0, 4), sw("a", 0, 8), sw(undefined, 0, 12)], 3);
  assert.equal(out.length, 1);
  assert.equal(out[0].sheet, 0);
  assert.ok(issues.some((i) => /worksheet/.test(i)));
});

test("cleanWidgets drops non-objects and unknown kinds", () => {
  const { out, issues } = clean([5, null, { kind: "image", x: 0, y: 0, w: 4, h: 4 }, "x", sw(0, 0, 0)]);
  assert.equal(out.length, 1);
  assert.ok(issues.length >= 2);
});

test("cleanWidgets clamps size to 2..12 x 2..24 (text height 1..24)", () => {
  const { out, issues } = clean([sw(0, 0, 0, 1, 1), sw(0, 0, 2, 20, 40), tw(0, 30, 1, 0), tw(0, 40, 6, 99)]);
  assert.deepEqual(out.map((w) => [w.w, w.h]), [[2, 2], [12, 24], [2, 1], [6, 24]]);
  assert.ok(issues.length >= 1);
});

test("cleanWidgets clamps position into the 12 x 96 grid", () => {
  const { out } = clean([sw(0, 10, 0, 6, 4), sw(0, -3, 50, 6, 4), sw(0, 0, 200, 6, 4)]);
  assert.deepEqual(out.map((w) => [w.x, w.y]), [[6, 0], [0, 50], [0, 92]]);
});

test("cleanWidgets rounds fractional and repairs non-numeric geometry", () => {
  const { out, issues } = clean([{ kind: "sheet", sheet: 0, x: 1.4, y: "a", w: null, h: NaN }]);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].x, out[0].y, out[0].w, out[0].h], [1, 0, 6, 4]);
  assert.ok(issues.length >= 1);
});

test("cleanWidgets moves an overlapping widget to the first free spot", () => {
  const { out, issues } = clean([sw(0, 0, 0), sw(1, 3, 1), sw(2, 0, 0)]);
  assert.deepEqual(out.map((w) => [w.sheet, w.x, w.y]), [[0, 0, 0], [1, 6, 0], [2, 0, 4]]);
  assert.ok(issues.some((i) => /overlap/.test(i)));
});

test("cleanWidgets drops a widget that overlaps with no room left", () => {
  const filler = [{ kind: "text", heading: "", body: "", x: 0, y: 0, w: 12, h: 24 }, tw(0, 24, 12, 24), tw(0, 48, 12, 24), tw(0, 72, 12, 24)];
  const { out, issues } = clean([...filler, sw(0, 0, 0)]);
  assert.equal(out.length, 4);
  assert.ok(issues.some((i) => /no room/.test(i)));
});

test("cleanWidgets keeps the first 12 and reports the rest", () => {
  const raw = Array.from({ length: 15 }, (_, i) => sw(0, (i % 2) * 6, Math.floor(i / 2) * 4));
  const { out, issues } = clean(raw);
  assert.equal(out.length, 12);
  assert.ok(issues.some((i) => /12 widgets/.test(i)));
  // an invalid entry among the first 12 does not use up a slot
  const withBad = [sw(9, 0, 0), ...Array.from({ length: 12 }, (_, i) => sw(0, (i % 2) * 6, 4 + Math.floor(i / 2) * 4))];
  assert.equal(clean(withBad).out.length, 12);
});

test("cleanWidgets truncates heading to 80 and body to 2000, and treats non-text as empty", () => {
  const { out, issues } = clean([tw(0, 0, 12, 1, "h".repeat(100), "b".repeat(2500)), { kind: "text", heading: 5, body: {}, x: 0, y: 4, w: 12, h: 1 }]);
  assert.equal(out[0].heading.length, 80);
  assert.equal(out[0].body.length, 2000);
  assert.equal(out[1].heading, "");
  assert.equal(out[1].body, "");
  assert.ok(issues.length >= 1);
});

test("cleanWidgets output carries only the saved fields", () => {
  const { out } = clean([{ kind: "sheet", sheet: 1, x: 0, y: 0, w: 6, h: 4, id: "w#1", sheetId: "ws#9", junk: true }, { kind: "text", heading: "A", body: "B", x: 0, y: 4, w: 12, h: 1, extra: 1 }]);
  assert.deepEqual(Object.keys(out[0]).sort(), ["h", "kind", "sheet", "w", "x", "y"]);
  assert.deepEqual(Object.keys(out[1]).sort(), ["body", "h", "heading", "kind", "w", "x", "y"]);
});

test("savedWidgets maps sheetId to the worksheet index and drops widgets of unknown worksheets", () => {
  const widgets = [
    { id: "w#1", kind: "sheet", sheetId: "ws#5", x: 0, y: 0, w: 6, h: 4 },
    { id: "w#2", kind: "sheet", sheetId: "ws#gone", x: 6, y: 0, w: 6, h: 4 },
    { id: "w#3", kind: "text", heading: "T", body: "B", x: 0, y: 4, w: 12, h: 1 },
  ];
  assert.deepEqual(savedWidgets(widgets, new Map([["ws#5", 2]])), [sw(2, 0, 0), tw(0, 4, 12, 1, "T", "B")]);
});

test("removeSheetWidgets and dashboardsUsing", () => {
  const tabs = [
    { id: "ws#1", kind: "worksheet", name: "A", sheet: {} },
    { id: "db#1", kind: "dashboard", name: "Sales", widgets: [{ id: "w#1", kind: "sheet", sheetId: "ws#1", x: 0, y: 0, w: 6, h: 4 }, { id: "w#2", kind: "text", heading: "", body: "", x: 0, y: 4, w: 12, h: 1 }] },
    { id: "db#2", kind: "dashboard", name: "Ops", widgets: [{ id: "w#3", kind: "sheet", sheetId: "ws#1", x: 0, y: 0, w: 6, h: 4 }] },
    { id: "db#3", kind: "dashboard", name: "Empty", widgets: [] },
  ];
  assert.deepEqual(dashboardsUsing(tabs, "ws#1").map((d) => d.name), ["Sales", "Ops"]);
  assert.deepEqual(dashboardsUsing(tabs, "ws#2"), []);
  assert.deepEqual(removeSheetWidgets(tabs[1].widgets, "ws#1").map((w) => w.id), ["w#2"]);
  assert.equal(removeSheetWidgets(tabs[3].widgets, "ws#1"), tabs[3].widgets);
});

test("defaultTabName numbers each kind from the first unused number", () => {
  assert.equal(defaultTabName("worksheet", []), "Worksheet 1");
  assert.equal(defaultTabName("worksheet", ["Worksheet 1", "Worksheet 2"]), "Worksheet 3");
  assert.equal(defaultTabName("worksheet", ["Worksheet 2"]), "Worksheet 1");
  assert.equal(defaultTabName("dashboard", ["Worksheet 1", "Dashboard 1"]), "Dashboard 2");
  assert.equal(defaultTabName("dashboard", ["Worksheet 1"]), "Dashboard 1");
});

test("non-integer cells are refused as 'snap to whole grid cells' by checkPlacement and explainRefusal", () => {
  for (const bad of [{ x: 0.5, y: 0, w: 4, h: 3 }, { x: 0, y: 1.2, w: 4, h: 3 }, { x: 0, y: 0, w: 4.5, h: 3 }, { x: 0, y: 0, w: 4, h: NaN }]) {
    const c = { id: "a", kind: "sheet", ...bad };
    assert.deepEqual(checkPlacement([], c), { ok: false, error: "Widgets snap to whole grid cells." });
    assert.equal(explainRefusal([], c, "move"), "Can't move: widgets snap to whole grid cells.");
  }
});

// --- image and spacer widgets (T08-15, T08-16) ---
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const iw = (x, y, w = 6, h = 4, alt = "Logo", src = PNG) => ({ kind: "image", alt, src, x, y, w, h });
const pw = (x, y, w = 2, h = 1) => ({ kind: "spacer", x, y, w, h });

test("default sizes: image 6 x 4, spacer 2 x 1", () => {
  assert.deepEqual(DEFAULT_SIZE.image, { w: 6, h: 4 });
  assert.deepEqual(DEFAULT_SIZE.spacer, { w: 2, h: 1 });
});

test("placeNew: a fifth image is refused, a spacer is placed", () => {
  const four = [0, 1, 2, 3].map((i) => ({ id: `w${i}`, ...iw(0, i * 4, 2, 2) }));
  const r = placeNew(four, "image");
  assert.equal(r.ok, false);
  assert.match(r.error, /at most 4 images/);
  assert.equal(placeNew(four, "spacer").ok, true);
});

test("a spacer may be one row tall; an image needs two", () => {
  assert.equal(checkPlacement([], { kind: "spacer", x: 0, y: 0, w: 2, h: 1 }).ok, true);
  assert.equal(checkPlacement([], { kind: "image", x: 0, y: 0, w: 2, h: 1 }).ok, false);
  assert.match(explainRefusal([], { kind: "image", x: 0, y: 0, w: 2, h: 1 }, "resize"), /image widget is at least 2 rows/);
  assert.match(explainRefusal([], { kind: "spacer", x: 0, y: 0, w: 1, h: 1 }, "resize"), /at least 2 columns/);
});

test("cleanWidgets keeps valid image and spacer widgets", () => {
  const { out, issues } = clean([iw(0, 0), pw(6, 0)]);
  assert.deepEqual(out, [iw(0, 0), pw(6, 0)]);
  assert.deepEqual(issues, []);
});

test("cleanWidgets drops an image whose source is not a raster data URL (https, svg, script) and reports it", () => {
  for (const src of ["https://example.com/a.png", "data:image/svg+xml;base64,AAAA", "javascript:alert(1)", 5, null]) {
    const { out, issues } = clean([iw(0, 0, 6, 4, "x", src)]);
    assert.deepEqual(out, []);
    assert.match(issues[0], /image/);
  }
});

test("cleanWidgets truncates alt text and caps images at 4", () => {
  const { out, issues } = clean([iw(0, 0, 2, 2, "a".repeat(200))]);
  assert.equal(out[0].alt.length, LIMITS.imageAlt);
  assert.match(issues[0], /alt text was cut/);
  const five = [0, 1, 2, 3, 4].map((i) => iw(0, i * 2, 2, 2));
  const r = clean(five);
  assert.equal(r.out.length, 4);
  assert.match(r.issues.join(" "), /only the first 4 images/);
});

test("a spacer carries nothing but its rectangle; stray fields are dropped", () => {
  const { out } = clean([{ ...pw(0, 0), src: PNG, body: "x" }]);
  assert.deepEqual(out, [pw(0, 0)]);
});

test("savedWidgets round-trips image and spacer widgets", () => {
  const live = [{ id: "w#1", ...iw(0, 0) }, { id: "w#2", ...pw(6, 0) }];
  assert.deepEqual(savedWidgets(live, new Map()), [iw(0, 0), pw(6, 0)]);
});
