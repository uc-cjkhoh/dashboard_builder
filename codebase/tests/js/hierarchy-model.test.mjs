import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHierarchyName, checkLevels, checkHierarchy, cleanHierarchies, drillFromHierarchy, CAST_REFUSAL }
  from "../../src/DashboardBuilder/Features/Dashboard/hierarchy-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { refusal, REFUSAL } from "../../src/DashboardBuilder/Features/Calc/calc-pill.js";

// T03-29 named hierarchies: workbook-level ordered same-table level lists a sheet's Drill can be set from.
const L = (column, table = "t", db = "d") => ({ db, table, column });
const H = (name, ...cols) => ({ id: "hier1", name, levels: cols.map((c) => L(c)) });

test("limits: 20 hierarchies, name 60, levels share the drill cap", () => {
  assert.equal(LIMITS.hierarchies, 20);
  assert.equal(LIMITS.hierarchyName, 60);
  assert.equal(LIMITS.drillLevels, 6);
});

test("name: required, <= 60, unique case-insensitively (ignoring itself)", () => {
  const list = [H("Time", "y", "m")];
  assert.equal(checkHierarchyName("  ", list).ok, false);
  assert.equal(checkHierarchyName("x".repeat(61), list).ok, false);
  assert.equal(checkHierarchyName("x".repeat(60), list).ok, true);
  assert.equal(checkHierarchyName("TIME", list).error, "Another hierarchy has that name.");
  assert.equal(checkHierarchyName("TIME", list, "hier1").ok, true);
  assert.equal(checkHierarchyName(" Geo ", list).value, "Geo");
});

test("levels: 2..6, one table, no repeats, no calc pills, no casts", () => {
  assert.equal(checkLevels([L("a")]).ok, false);
  assert.equal(checkLevels([L("a"), L("b"), L("c"), L("d"), L("e"), L("f"), L("g")]).error, "A hierarchy can have at most 6 levels.");
  assert.equal(checkLevels([L("a"), L("b", "other")]).error, "Hierarchy levels must all come from one table.");
  assert.equal(checkLevels([L("a"), L("a")]).error, "A level can't repeat.");
  assert.equal(checkLevels([L("a"), { calc: "calc1", db: "", table: "", column: "x" }]).error, REFUSAL);
  assert.equal(checkLevels([L("a"), L("b")], { castOf: (f) => (f.column === "b" ? "text" : undefined) }).error, CAST_REFUSAL);
  const ok = checkLevels([{ ...L("a"), category: "text", extra: 1 }, L("b")]);
  assert.deepEqual(ok.value, [L("a"), L("b")]); // only db/table/column are kept
});

test("the E12 refusal covers the hierarchy entry", () => assert.equal(refusal({ calc: "calc1" }, "hierarchy"), REFUSAL));

test("checkHierarchy: name + levels, capped at 20", () => {
  const r = checkHierarchy({ name: "T", levels: [L("a"), L("b")] }, []);
  assert.deepEqual(r.value, { name: "T", levels: [L("a"), L("b")] });
  const full = Array.from({ length: 20 }, (_, i) => ({ id: `hier${i + 1}`, name: `n${i}`, levels: [L("a"), L("b")] }));
  assert.equal(checkHierarchy({ name: "new", levels: [L("a"), L("b")] }, full).error, "A workbook can have at most 20 hierarchies.");
  assert.equal(checkHierarchy({ name: "n0", levels: [L("a"), L("b")] }, full, "hier1").ok, true); // editing never hits the cap
});

test("clean: absent -> [] with no issue; not a list -> issue", () => {
  const issues = [];
  assert.deepEqual(cleanHierarchies(undefined, issues), []);
  assert.deepEqual(cleanHierarchies(null, issues), []);
  assert.deepEqual(issues, []);
  assert.deepEqual(cleanHierarchies({}, issues), []);
  assert.equal(issues.length, 1);
});

test("clean: bad entries are dropped with an issue each; good ones are kept verbatim", () => {
  const issues = [];
  const out = cleanHierarchies([
    { id: "hier1", name: "Time", levels: [L("y"), L("m")] },
    null, 7,
    { id: "bad id", name: "X", levels: [L("a"), L("b")] },
    { id: "hier2", name: "time", levels: [L("a"), L("b")] },            // duplicate name
    { id: "hier3", name: "One", levels: [L("a")] },                      // too few levels
    { id: "hier4", name: "Mixed", levels: [L("a"), L("b", "other")] },   // second level other table: dropped, then too few
    { id: "hier1", name: "SameId", levels: [L("a"), L("b")] },           // duplicate id
    { id: "hier5", name: "", levels: [L("a"), L("b")] },
  ], issues);
  assert.deepEqual(out, [{ id: "hier1", name: "Time", levels: [L("y"), L("m")] }]);
  assert.ok(issues.length >= 7);
});

test("clean: calc levels removed, repeats removed, extra levels cut to 6, extra hierarchies cut to 20", () => {
  const issues = [];
  const out = cleanHierarchies([
    { id: "hier1", name: "A", levels: [L("a"), { calc: "calc1", db: "", table: "", column: "c" }, L("b"), L("a"), L("c")] },
    { id: "hier2", name: "B", levels: ["a", "b", "c", "d", "e", "f", "g", "h"].map((c) => L(c)) },
  ], issues);
  assert.deepEqual(out[0].levels.map((l) => l.column), ["a", "b", "c"]);
  assert.equal(out[1].levels.length, 6);
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `hier${i + 1}`, name: `n${i}`, levels: [L("a"), L("b")] }));
  assert.equal(cleanHierarchies(many, []).length, 20);
});

test("clean: dangling table (not in the workbook's tables) drops the hierarchy with an issue", () => {
  const issues = [];
  const tables = new Set(["d.t"]);
  const out = cleanHierarchies([
    { id: "hier1", name: "Ok", levels: [L("a"), L("b")] },
    { id: "hier2", name: "Gone", levels: [L("a", "zzz"), L("b", "zzz")] },
  ], issues, { tables });
  assert.deepEqual(out.map((h) => h.name), ["Ok"]);
  assert.ok(issues.some((m) => m.includes("Gone")));
});

test("clean: hostile keys and non-string parts never leak", () => {
  const raw = JSON.parse('[{"id":"hier1","name":"__proto__","__proto__":{"polluted":1},"levels":[{"db":"d","table":"t","column":"a","__proto__":{"x":1}},{"db":"d","table":"t","column":"b","constructor":"x"}]},{"id":"hier2","name":"N","levels":[{"db":1,"table":"t","column":"a"},{"db":"d","table":"t","column":"b"},{"db":"d","table":"t","column":"c"}]}]');
  const issues = [];
  const out = cleanHierarchies(raw, issues);
  assert.equal({}.polluted, undefined);
  assert.equal(out[0].name, "__proto__");
  assert.deepEqual(Object.keys(out[0]), ["id", "name", "levels"]);
  assert.deepEqual(Object.keys(out[0].levels[0]), ["db", "table", "column"]);
  assert.equal(out[1].levels.length, 2); // the numeric db level is dropped
});

test("drillFromHierarchy builds the same structure as hand-dropped levels (depth 0, empty path, category)", () => {
  const h = H("T", "y", "m");
  const cols = [{ name: "y", category: "temporal" }, { name: "m", category: "text" }];
  const r = drillFromHierarchy(h, cols, () => undefined);
  assert.deepEqual(r.drill, { levels: [{ db: "d", table: "t", column: "y", category: "temporal" }, { db: "d", table: "t", column: "m", category: "text" }], depth: 0, path: [] });
  assert.equal(drillFromHierarchy(h, [cols[0]], () => undefined).ok, false);                    // dangling column
  assert.equal(drillFromHierarchy(h, cols, (f) => (f.column === "m" ? "number" : undefined)).error, CAST_REFUSAL); // cast added later
  // a copy: editing the hierarchy later never changes the drill
  h.levels[0].column = "zz";
  assert.equal(r.drill.levels[0].column, "y");
});

test("workbook round trip: absent field -> [] and no issue; present -> kept; empty -> omitted", () => {
  const base = { entities: [{ id: "e1", db: "d", table: "t", x: 0, y: 0, joinKeys: [] }], relationships: [], tabs: [], active: null };
  const none = serializeWorkbook(base);
  assert.equal("hierarchies" in none, false);
  const old = parseWorkbook(JSON.stringify(none));
  assert.deepEqual(old.hierarchies, []);
  assert.deepEqual(old.issues, []);
  const withH = serializeWorkbook({ ...base, hierarchies: [H("Time", "y", "m")] });
  const back = parseWorkbook(JSON.stringify(withH));
  assert.deepEqual(back.hierarchies, [H("Time", "y", "m")]);
  assert.equal(withH.version, 2);
  const bad = parseWorkbook(JSON.stringify({ ...withH, hierarchies: [{ id: "hier1", name: "Q", levels: [L("a", "nope"), L("b", "nope")] }] }));
  assert.deepEqual(bad.hierarchies, []);
  assert.ok(bad.issues.length >= 1);
});
