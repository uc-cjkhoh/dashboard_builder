// Groups (T02-30) — pure, DOM-free (tests/js/group-model.test.mjs). A group field puts the members of ONE text field into
// named groups: { field: { db, table, column }, groups: [{ name, members: [raw…] }] }. It is stored on a calculation
// ({ id, name, formula: "", group }) and compiled HERE straight into the calculation engine's expression tree, so the
// grouping happens in ClickHouse and the server needs no new code:
//   CASE WHEN <member = 'a' OR member = 'b' …> THEN 'Group 1' … ELSE <the raw value> END
// Every member is a `str` node (a bound parameter on the server, never SQL text). A member that matches no group keeps
// its own value (ELSE the field itself); a NULL member compares as unknown, so it also falls to ELSE and stays NULL.
// The engine allows 200 nodes per tree: a comparison is 3 nodes + 1 OR, a group's name 1, so a tree costs 2 + 4 per member,
// and a field can hold MAX_GROUP_MEMBERS = 49 members across all its groups. checkGroupSpec refuses more at edit time.
import { LIMITS } from "../Core/validate.js";
import { CALC_LIMITS } from "./calc-types.js";

/** The node cost of a group field: the CASE and its ELSE (2), then per member 4 (field, literal, `=`, and the OR or the group's THEN name). */
export const groupCost = (spec) => 2 + 4 * (spec?.groups ?? []).reduce((n, g) => n + g.members.length, 0);
/** The most members one group field can hold under the engine's node limit. */
export const MAX_GROUP_MEMBERS = Math.floor((CALC_LIMITS.nodes - 2) / 4);

export const GROUP_CATEGORY_REFUSAL = "Groups work on text fields only. Number, date and true/false fields can't be grouped yet.";
/** Why a column of this (original) category can't be grouped, or null. */
export const groupCategoryProblem = (category) => (category === "text" ? null : GROUP_CATEGORY_REFUSAL);

const fieldNode = (f) => ({ k: "field", db: f.db, table: f.table, column: f.column });
const equals = (f, m) => ({ k: "cmp", op: "=", l: fieldNode(f), r: { k: "str", v: m } });
// A balanced OR keeps the tree shallow (the engine allows depth 12; a left-leaning chain of 49 would not fit).
function anyOf(conds) {
  if (conds.length === 1) return conds[0];
  const mid = conds.length >> 1;
  return { k: "logic", op: "or", l: anyOf(conds.slice(0, mid)), r: anyOf(conds.slice(mid)) };
}

/** The calculation tree of a (checked) group spec. */
export const groupTree = (spec) => ({
  k: "case",
  whens: spec.groups.map((g) => ({ c: anyOf(g.members.map((m) => equals(spec.field, m))), t: { k: "str", v: g.name } })),
  else: fieldNode(spec.field),
});

const total = (groups) => groups.reduce((n, g) => n + g.members.length, 0);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/** { ok } or { ok: false, error } — the rules every group spec obeys (the dialog, and a saved workbook through cleanGroupSpec). */
export function checkGroupSpec(spec) {
  const f = spec?.field;
  if (!f || typeof f.db !== "string" || typeof f.table !== "string" || typeof f.column !== "string" || !f.db || !f.table || !f.column) return { ok: false, error: "A group field needs a field to group." };
  const groups = spec.groups;
  if (!Array.isArray(groups) || groups.length === 0) return { ok: false, error: "Make at least one group, with at least one member." };
  if (groups.length > LIMITS.groups) return { ok: false, error: `At most ${LIMITS.groups} groups per group field.` };
  const owner = new Map();
  for (const g of groups) {
    if (typeof g?.name !== "string" || !g.name.trim()) return { ok: false, error: "Give every group a name." };
    if (g.name.trim().length > LIMITS.groupName) return { ok: false, error: `A group name must be at most ${LIMITS.groupName} characters.` };
    if (groups.some((o) => o !== g && sameName(o.name.trim(), g.name.trim()))) return { ok: false, error: `A group named '${g.name.trim()}' already exists.` };
    if (!Array.isArray(g.members) || g.members.length === 0) return { ok: false, error: `Group '${g.name.trim()}' needs at least one member.` };
    for (const m of g.members) {
      if (typeof m !== "string") return { ok: false, error: "A group member must be text." };
      if (m.length > LIMITS.memberKey) return { ok: false, error: `A group member can be at most ${LIMITS.memberKey} characters.` };
      if (owner.has(m) && owner.get(m) !== g) return { ok: false, error: `'${m}' is in more than one group.` };
      owner.set(m, g);
    }
  }
  const n = total(groups);
  if (n > LIMITS.groupMembers) return { ok: false, error: `At most ${LIMITS.groupMembers} members per group field.` };
  if (n > MAX_GROUP_MEMBERS) return { ok: false, error: `This group field has ${n} members. The calculation engine takes at most ${MAX_GROUP_MEMBERS} members across all groups (its ${CALC_LIMITS.nodes}-node limit) — put the largest group's members back, or make a second group field.` };
  return { ok: true };
}

/** A saved group spec, checked and rebuilt from its known parts only — or null (with an issue naming the calculation). */
export function cleanGroupSpec(raw, where, issues) {
  const fail = (why) => { issues.push(`Skipped calculation ${where}: its group definition was invalid (${why}).`); return null; };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("not an object");
  const f = raw.field;
  if (!f || typeof f !== "object") return fail("no field");
  const spec = { field: { db: f.db, table: f.table, column: f.column }, groups: [] };
  if (!Array.isArray(raw.groups)) return fail("no groups");
  for (const g of raw.groups) {
    if (!g || typeof g !== "object" || !Array.isArray(g.members)) return fail("a group has no members");
    spec.groups.push({ name: typeof g.name === "string" ? g.name.trim() : g.name, members: g.members });
  }
  const r = checkGroupSpec(spec);
  return r.ok ? spec : fail(r.error);
}

/** The default calculation name for a field: "region (groups)", numbered when taken; never holds . [ ] (a calculation name can't). */
export function groupCalcName(column, calcs) {
  const base = `${String(column).replace(/[.[\]]+/g, " ").trim() || "field"} (groups)`;
  const taken = (n) => calcs.some((c) => c.name.toLowerCase() === n.toLowerCase());
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
  return base;
}

/** member -> group name, for the dialog's member table. */
export function assignmentsOf(groups) {
  const out = new Map();
  for (const g of groups ?? []) for (const m of g.members) out.set(m, g.name);
  return out;
}
/** The groups the dialog's table makes: `pairs` = [member, group name | ""], `names` the group names in order; empty groups drop out. */
export function groupsFromAssignments(pairs, names) {
  const by = new Map(names.map((n) => [n, []]));
  for (const [m, n] of pairs) if (n && by.has(n)) by.get(n).push(m);
  return names.filter((n) => by.get(n).length).map((n) => ({ name: n, members: by.get(n) }));
}
