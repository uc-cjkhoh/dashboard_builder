import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTree, groupCost, MAX_GROUP_MEMBERS, checkGroupSpec, cleanGroupSpec, groupCalcName, groupsFromAssignments, assignmentsOf, GROUP_CATEGORY_REFUSAL, groupCategoryProblem, GROUP_TYPE_REFUSAL }
  from "../../src/DashboardBuilder/Features/Calc/group-model.js";
import { check, CALC_LIMITS } from "../../src/DashboardBuilder/Features/Calc/calc-types.js";
import { compileCalculation, catalogFromEntities } from "../../src/DashboardBuilder/Features/Calc/calc-resolve.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { LIMITS } from "../../src/DashboardBuilder/Features/Core/validate.js";

// T02-30 groups: members -> named groups, compiled to the calculation engine's tree (CASE, one WHEN per group, OR of bound equals).
const FIELD = { db: "d", table: "t", column: "region" };
const spec = (groups, field = FIELD) => ({ field, groups });
const g = (name, ...members) => ({ name, members });
const categoryOf = (db, table, column) => (db === "d" && table === "t" && column === "region" ? "text" : null);
const count = (n) => (n === null || typeof n !== "object" ? 1
  : n.k === "case" ? 1 + n.whens.reduce((a, w) => a + count(w.c) + count(w.t), 0) + (n.else ? count(n.else) : 0)
  : n.k === "logic" || n.k === "cmp" ? 1 + count(n.l) + count(n.r) : 1);
const depthOf = (n) => (n === null || typeof n !== "object" ? 1
  : n.k === "case" ? 1 + Math.max(...n.whens.flatMap((w) => [depthOf(w.c), depthOf(w.t)]), n.else ? depthOf(n.else) : 0)
  : n.k === "logic" || n.k === "cmp" ? 1 + Math.max(depthOf(n.l), depthOf(n.r)) : 1);

test("one WHEN per group; each condition an OR of equalities to bound string literals; ELSE the raw field", () => {
  const t = groupTree(spec([g("Nordics", "SE", "NO"), g("Benelux", "NL")]));
  assert.equal(t.k, "case");
  assert.equal(t.whens.length, 2);
  assert.deepEqual(t.whens[1], { c: { k: "cmp", op: "=", l: { k: "field", db: "d", table: "t", column: "region" }, r: { k: "str", v: "NL" } }, t: { k: "str", v: "Benelux" } });
  assert.equal(t.whens[0].c.k, "logic");
  assert.equal(t.whens[0].c.op, "or");
  assert.deepEqual(t.else, { k: "field", db: "d", table: "t", column: "region" });
});
test("the tree type-checks as text against the engine, and its node cost matches groupCost", () => {
  const s = spec([g("A", "a1", "a2", "a3"), g("B", "b1"), g("C", "c1", "c2")]);
  const t = groupTree(s);
  const info = check(t, categoryOf);
  assert.equal(info.error, undefined);
  assert.equal(info.type, "text");
  assert.equal(info.isAggregate, false);
  assert.deepEqual(info.tables, ["d.t"]);
  assert.equal(count(t), groupCost(s));
});
test("members with quotes, brackets, backslashes and SQL-ish text are plain str values (bound by the server, never text)", () => {
  const nasty = ["a'b", "x\"y", "[t.c]", "\\", "'; DROP TABLE t; --", "%", "", "é"];
  const t = groupTree(spec([g("N", ...nasty)]));
  assert.equal(check(t, categoryOf).error, undefined);
  const lits = JSON.stringify(t).match(/"k":"str","v":"((?:[^"\\]|\\.)*)"/g);
  assert.equal(lits.length, nasty.length + 1);
  assert.equal(JSON.stringify(t).includes("DROP TABLE t"), true, "only inside a str literal");
});
test("a hostile member name such as __proto__ or constructor is just a string", () => {
  const t = groupTree(spec([g("P", "__proto__", "constructor")]));
  assert.equal(check(t, categoryOf).error, undefined);
});
test("the OR chain is balanced: a group of the maximum size stays within depth 12", () => {
  const members = Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) => `m${i}`);
  const s = spec([g("All", ...members)]);
  const t = groupTree(s);
  assert.ok(depthOf(t) <= CALC_LIMITS.depth, `depth ${depthOf(t)}`);
  assert.equal(check(t, categoryOf).error, undefined);
});
test("the node budget: 49 members fit, 50 do not (the engine allows 200 nodes)", () => {
  assert.equal(MAX_GROUP_MEMBERS, 49);
  assert.equal(groupCost(spec([g("A", ...Array.from({ length: 49 }, (_, i) => `m${i}`))])), 198);
  assert.equal(count(groupTree(spec([g("A", ...Array.from({ length: 49 }, (_, i) => `m${i}`))]))), 198);
  const over = spec([g("A", ...Array.from({ length: 50 }, (_, i) => `m${i}`))]);
  assert.equal(groupCost(over), 202);
  assert.ok(check(groupTree(over), categoryOf).error, "the engine itself would refuse it");
});
test("checkGroupSpec: names, members, uniqueness and the node budget, each with a plain message", () => {
  assert.equal(checkGroupSpec(spec([g("A", "x")])).ok, true);
  const bad = (groups) => checkGroupSpec(spec(groups));
  assert.match(bad([]).error, /at least one group/i);
  assert.match(bad([g("", "x")]).error, /name/i);
  assert.match(bad([g("A", "x"), g("a", "y")]).error, /already/i);
  assert.match(bad([g("A")]).error, /at least one member/i);
  assert.match(bad([g("A", "x"), g("B", "x")]).error, /more than one group/i);
  assert.match(bad([g("x".repeat(81), "m")]).error, /at most 80/);
  assert.match(bad([g("A", "m".repeat(101))]).error, /longer than 100/);
  assert.match(bad(Array.from({ length: 51 }, (_, i) => g(`G${i}`, `m${i}`))).error, /At most 50 groups/);
  const tooMany = bad([g("A", ...Array.from({ length: 30 }, (_, i) => `a${i}`)), g("B", ...Array.from({ length: 20 }, (_, i) => `b${i}`))]);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /49 members/);
  assert.match(tooMany.error, /50/);
  assert.equal(checkGroupSpec({ field: null, groups: [g("A", "x")] }).ok, false);
});
test("only a text field can be grouped; the others get a plain message", () => {
  assert.equal(groupCategoryProblem("text"), null);
  for (const c of ["numeric", "temporal", "boolean", "other"]) assert.equal(groupCategoryProblem(c), GROUP_CATEGORY_REFUSAL);
  assert.match(GROUP_CATEGORY_REFUSAL, /text/i);
});
test("a group calculation compiles through the ordinary calculation seam (ast, text, row-level, dimension)", () => {
  const catalog = catalogFromEntities([{ db: "d", table: "t", columns: [{ name: "region", category: "text" }] }]);
  const calc = { id: "calc1", name: "Region (groups)", formula: "", group: spec([g("Nordics", "SE", "NO")]) };
  const r = compileCalculation(calc, [calc], catalog);
  assert.equal(r.error, undefined);
  assert.equal(r.info.type, "text");
  assert.equal(r.role, "dimension");
  assert.equal(r.ast.k, "case");
  const gone = compileCalculation(calc, [calc], catalogFromEntities([]));
  assert.match(gone.error.message, /region/);
  const copy = structuredClone(calc); copy.group.groups[0].members.push("SE"); // a duplicate member is two equal comparisons: harmless
  assert.equal(compileCalculation(copy, [copy], catalog).error, undefined);
});
test("another calculation can refer to a group calculation by name", () => {
  const catalog = catalogFromEntities([{ db: "d", table: "t", columns: [{ name: "region", category: "text" }] }]);
  const grp = { id: "calc1", name: "Zones", formula: "", group: spec([g("N", "SE")]) };
  const user = { id: "calc2", name: "Is north", formula: "[Zones] = 'N'" };
  const r = compileCalculation(user, [grp, user], catalog);
  assert.equal(r.error, undefined);
  assert.equal(r.info.type, "boolean");
});
test("cleanGroupSpec (a saved workbook): validated, bad shapes dropped with an issue", () => {
  const issues = [];
  const ok = cleanGroupSpec({ field: FIELD, groups: [g("A", "x", "y")] }, "calc1", issues);
  assert.deepEqual(ok, { field: FIELD, groups: [{ name: "A", members: ["x", "y"] }] });
  assert.equal(cleanGroupSpec(undefined, "c", issues), null);
  assert.equal(cleanGroupSpec({ field: { db: "d" }, groups: [g("A", "x")] }, "c", issues), null);
  assert.equal(cleanGroupSpec({ field: FIELD, groups: [g("A", "x"), g("B", "x")] }, "c", issues), null);
  assert.equal(cleanGroupSpec({ field: FIELD, groups: [g("A", 5)] }, "c", issues), null);
  assert.equal(cleanGroupSpec("x", "c", issues), null);
  assert.ok(issues.length >= 4);
  // extra properties never survive; members are copied as strings
  const x = cleanGroupSpec({ field: { ...FIELD, evil: 1 }, groups: [{ name: "A", members: ["x"], evil: 1 }], evil: 1 }, "c", []);
  assert.deepEqual(x, { field: FIELD, groups: [{ name: "A", members: ["x"] }] });
});
test("groupCalcName: the default pill name 'Region (groups)', unique and free of . [ ]", () => {
  assert.equal(groupCalcName("region", []), "region (groups)");
  assert.equal(groupCalcName("region", [{ id: "c", name: "region (groups)" }]), "region (groups) 2");
  assert.equal(groupCalcName("a.b[c]", []), "a b c (groups)");
});
test("assignments <-> groups: the dialog's member -> group-name table", () => {
  const groups = [g("A", "x", "y"), g("B", "z")];
  const a = assignmentsOf(groups);
  assert.equal(a.get("x"), "A"); assert.equal(a.get("z"), "B");
  assert.deepEqual(groupsFromAssignments([["x", "A"], ["y", "A"], ["z", "B"], ["w", ""]], ["A", "B", "Empty"]), [g("A", "x", "y"), g("B", "z")], "empty groups and unassigned members drop out");
  assert.deepEqual(groupsFromAssignments([["x", "B"], ["y", "A"]], ["A", "B"]), [g("A", "y"), g("B", "x")], "group order follows the name list");
});
test("workbook round trip: a group calculation saves its group and no formula text, and loads back", () => {
  const calcs = [{ id: "calc1", name: "Zones", formula: "", group: spec([g("N", "SE", "NO")]) }, { id: "calc2", name: "Plain", formula: "1 + 1" }];
  const text = JSON.stringify(serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs: [], active: null, theme: { accent: "crimson", palette: "default" }, calculations: calcs, nextCalcId: 3 }));
  const wb = parseWorkbook(text);
  assert.deepEqual(wb.calculations.find((c) => c.id === "calc1"), { id: "calc1", name: "Zones", formula: "", group: spec([g("N", "SE", "NO")]) });
  assert.deepEqual(wb.calculations.find((c) => c.id === "calc2"), { id: "calc2", name: "Plain", formula: "1 + 1" });
});
test("workbook open: a corrupt group on a calculation skips that calculation with an issue; a plain one is untouched", () => {
  const raw = (calcs) => parseWorkbook(JSON.stringify(serializeWorkbook({ entities: new Map(), relationships: new Map(), tabs: [], active: null, calculations: calcs })));
  const wb = raw([{ id: "calc1", name: "Zones", formula: "", group: { field: FIELD, groups: [g("A", "x"), g("B", "x")] } }, { id: "calc2", name: "Ok", formula: "1" }]);
  assert.deepEqual(wb.calculations.map((c) => c.id), ["calc2"]);
  assert.ok(wb.issues.some((i) => /Zones/.test(i)));
  assert.equal(LIMITS.groups, 50);
  assert.equal(LIMITS.groupMembers, 500);
});

test("groupCategoryProblem also takes the ClickHouse type: UUID / IPv4 / IPv6 / enum columns are refused, String-likes are not", () => {
  for (const t of ["String", "Nullable(String)", "LowCardinality(String)", "FixedString(3)", ""]) assert.equal(groupCategoryProblem("text", t), null, t);
  for (const t of ["UUID", "Nullable(UUID)", "IPv4", "IPv6", "Enum8('a' = 1)", "Nullable(Enum16('x' = 1))"]) assert.equal(groupCategoryProblem("text", t), GROUP_TYPE_REFUSAL, t);
  assert.match(GROUP_TYPE_REFUSAL, /not UUID, IP address or enum/);
  assert.equal(groupCategoryProblem("numeric", "Int32"), GROUP_CATEGORY_REFUSAL);
});
test("a group name equal to a member that stays ungrouped is refused; equal to a grouped member is fine", () => {
  const spec2 = spec([g("EU", "APAC")]);
  const r = checkGroupSpec(spec2, ["APAC", "EU", "US"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /group name 'EU' is also a member/);
  assert.equal(checkGroupSpec(spec([g("EU", "EU", "APAC")]), ["APAC", "EU", "US"]).ok, true);
  assert.equal(checkGroupSpec(spec([g("Other", "APAC")]), ["APAC", "EU"]).ok, true);
  assert.equal(checkGroupSpec(spec2).ok, true, "without the field's member list there is nothing to compare");
});
test("a member over 100 characters is named in the error", () => {
  assert.match(checkGroupSpec(spec([g("A", "m".repeat(120))])).error, /'mmmmmmmmmmmmmmmmmmmm…' is longer than 100/);
});
