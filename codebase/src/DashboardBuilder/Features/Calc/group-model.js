// Groups — pure, DOM-free (tests/js/group-model.test.mjs). A group field puts the members of ONE text field into
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

/** The kind of a group field's column: undefined = text (compared as is); "number" / "boolean" = compared as TEXT(field), so members stay exact text. */
const kindOf = (spec) => (spec?.kind === "number" || spec?.kind === "boolean" ? spec.kind : undefined);
// Node costs: the CASE and its ELSE (2), a member 4 (field, literal, `=`, and the OR or the group's THEN name), the remainder WHEN 4
// (not, isnull, field, str). A number / true-false field wraps every use of the field in TEXT(): +1 per member, for the ELSE, and for the remainder WHEN.
const nodeCosts = (spec) => { const t = kindOf(spec) ? 1 : 0; return { base: 2 + t, member: 4 + t, other: OTHER_COST }; };
const countNodes = (n) => (n === null || typeof n !== "object" ? 1 : 1 + Object.values(n).reduce((a, v) => a + (Array.isArray(v) ? v.reduce((b, x) => b + (x && typeof x === "object" && ("c" in x || "t" in x) ? countNodes(x.c) + countNodes(x.t) : countNodes(x)), 0) : v && typeof v === "object" ? countNodes(v) : 0), 0));
/** The node cost of a group field (a true/false field counts its generated tree). */
export const groupCost = (spec) => { if (kindOf(spec) === "boolean") return countNodes(groupTree(spec)); const c = nodeCosts(spec); return c.base + c.member * (spec?.groups ?? []).reduce((n, g) => n + g.members.length, 0) + (otherLabel(spec) ? c.other : 0); };
/** The remainder label ("Other") of a spec, trimmed — "" when ungrouped members keep their own value. */
export const otherLabel = (spec) => (typeof spec?.other === "string" ? spec.other.trim() : "");
const OTHER_COST = 4;
/** The most members one text group field can hold under the engine's node limit. */
export const MAX_GROUP_MEMBERS = Math.floor((CALC_LIMITS.nodes - 2) / 4);
/** The most members this spec can hold: one fewer with a remainder label (its WHEN costs a member's worth of nodes); 39 (38) for a number or true/false field. */
export const maxMembersFor = (spec) => { if (kindOf(spec) === "boolean") return 2; const c = nodeCosts(spec); return Math.floor((CALC_LIMITS.nodes - c.base - (otherLabel(spec) ? c.other : 0)) / c.member); };

export const GROUP_CATEGORY_REFUSAL = "Groups work on text, whole-number and true/false fields. Date fields can't be grouped yet.";
export const GROUP_FLOAT_REFUSAL = "Groups work on whole-number fields, not decimal or floating-point ones (their text form can differ between the list and the database).";
export const GROUP_TYPE_REFUSAL = "Groups work on text columns, not UUID, IP address or enum columns.";
// ClickHouse has no common type between these and the text branches of the group CASE (pinned by tests/live/group-smoke.mjs).
const NOT_PLAIN_TEXT = /UUID|IPv4|IPv6|Enum/;
const IS_FRACTIONAL = /Float|Decimal/; // the member list shows Decimal(10,2) as 1.50 but ClickHouse's toString gives 1.5 (pinned by tests/live/group-smoke.mjs)
/** "text" | "number" | "boolean" for a column of this (original) category and ClickHouse `type` that can be grouped, else null. Floats and decimals are out: the member list's text and ClickHouse's toString can differ. */
export const groupKind = (category, type = "") => (category === "text" ? (NOT_PLAIN_TEXT.test(String(type)) ? null : "text") : category === "numeric" ? (IS_FRACTIONAL.test(String(type)) ? null : "number") : category === "boolean" ? "boolean" : null);
/** Why a column of this (original) category and ClickHouse `type` can't be grouped, or null. */
export const groupCategoryProblem = (category, type = "") => (groupKind(category, type) ? null : category === "text" ? GROUP_TYPE_REFUSAL : category === "numeric" ? GROUP_FLOAT_REFUSAL : GROUP_CATEGORY_REFUSAL);
const MEMBER_FORM = { number: /^(0|-?[1-9]\d*)$/, boolean: /^(true|false)$/ };

const fieldNode = (f) => ({ k: "field", db: f.db, table: f.table, column: f.column });
// The field as the CASE reads it: itself for text, TEXT(field) for a number field (the engine compares text only). TEXT() refuses a
// true/false value, so a true/false field is tested as the condition itself (`field` for true, `NOT field` for false) and read back
// by a small CASE; NULL fails both tests, so it stays NULL.
const boolText = (f) => ({ k: "case", whens: [{ c: fieldNode(f), t: { k: "str", v: "true" } }, { c: { k: "not", arg: fieldNode(f) }, t: { k: "str", v: "false" } }] });
const valueNode = (spec) => (kindOf(spec) === "boolean" ? boolText(spec.field) : kindOf(spec) ? { k: "fn", fn: "text", args: [fieldNode(spec.field)] } : fieldNode(spec.field));
const equals = (spec, m) => (kindOf(spec) === "boolean" ? (m === "true" ? fieldNode(spec.field) : { k: "not", arg: fieldNode(spec.field) }) : { k: "cmp", op: "=", l: valueNode(spec), r: { k: "str", v: m } });
// A balanced OR keeps the tree shallow (the engine allows depth 12; a left-leaning chain of 49 would not fit).
function anyOf(conds) {
  if (conds.length === 1) return conds[0];
  const mid = conds.length >> 1;
  return { k: "logic", op: "or", l: anyOf(conds.slice(0, mid)), r: anyOf(conds.slice(mid)) };
}

/** The calculation tree of a (checked) group spec. */
export const groupTree = (spec) => {
  const whens = spec.groups.map((g) => ({ c: anyOf(g.members.map((m) => equals(spec, m))), t: { k: "str", v: g.name } }));
  // The remainder label: every non-NULL member no group took (the groups' WHENs come first); NULL fails the test and stays NULL via ELSE.
  const other = otherLabel(spec);
  if (other) whens.push({ c: { k: "not", arg: { k: "isnull", arg: fieldNode(spec.field) } }, t: { k: "str", v: other } });
  return { k: "case", whens, else: valueNode(spec) };
};

const total = (groups) => groups.reduce((n, g) => n + g.members.length, 0);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/** { ok } or { ok: false, error } — the rules every group spec obeys (the dialog, and a saved workbook through cleanGroupSpec). */
export function checkGroupSpec(spec, knownMembers = []) {
  const f = spec?.field;
  if (!f || typeof f.db !== "string" || typeof f.table !== "string" || typeof f.column !== "string" || !f.db || !f.table || !f.column) return { ok: false, error: "A group field needs a field to group." };
  if (spec.kind !== undefined && !kindOf(spec)) return { ok: false, error: "A group field is on a text, number or true/false field." };
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
      if (kindOf(spec) && !MEMBER_FORM[kindOf(spec)].test(m)) return { ok: false, error: `'${m.slice(0, 20)}' is not a ${kindOf(spec) === "number" ? "number" : "true or false"} member.` };
      if (m.length > LIMITS.memberKey) return { ok: false, error: `The member '${m.slice(0, 20)}…' is longer than ${LIMITS.memberKey} characters and can't be grouped.` };
      if (owner.has(m) && owner.get(m) !== g) return { ok: false, error: `'${m}' is in more than one group.` };
      owner.set(m, g);
    }
  }
  // A group name equal to a member that stays ungrouped would merge that member's rows into the group's bar.
  for (const g of groups) {
    const clash = knownMembers.find((m) => m === g.name.trim() && !owner.has(m));
    if (clash !== undefined) return { ok: false, error: `The group name '${g.name.trim()}' is also a member of this field outside the group — rename the group, or put that member in it.` };
  }
  if (spec.other !== undefined && typeof spec.other !== "string") return { ok: false, error: "The label for ungrouped members must be text." };
  const other = otherLabel(spec);
  if (other.length > LIMITS.groupName) return { ok: false, error: `The label for ungrouped members must be at most ${LIMITS.groupName} characters.` };
  if (other && groups.some((g) => sameName(g.name.trim(), other))) return { ok: false, error: `'${other}' is already a group name — give the ungrouped members another label.` };
  if (other && knownMembers.some((m) => m === other && !owner.has(m))) return { ok: false, error: `The label '${other}' is also a member of this field outside the groups — give the ungrouped members another label, or put that member in a group.` };
  const n = total(groups);
  if (n > LIMITS.groupMembers) return { ok: false, error: `At most ${LIMITS.groupMembers} members per group field.` };
  if (n > maxMembersFor(spec)) return { ok: false, error: `This group field has ${n} members. The calculation engine takes at most ${maxMembersFor(spec)} members across all groups (its ${CALC_LIMITS.nodes}-node limit) — put the largest group's members back, or make a second group field.` };
  return { ok: true };
}

/** A saved group spec, checked and rebuilt from its known parts only — or null (with an issue naming the calculation). */
export function cleanGroupSpec(raw, where, issues) {
  const fail = (why) => { issues.push(`Skipped calculation ${where}: its group definition was invalid (${why}).`); return null; };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("not an object");
  const f = raw.field;
  if (!f || typeof f !== "object") return fail("no field");
  const spec = { field: { db: f.db, table: f.table, column: f.column }, groups: [] };
  if (raw.kind !== undefined) spec.kind = raw.kind;
  if (!Array.isArray(raw.groups)) return fail("no groups");
  for (const g of raw.groups) {
    if (!g || typeof g !== "object" || !Array.isArray(g.members)) return fail("a group has no members");
    spec.groups.push({ name: typeof g.name === "string" ? g.name.trim() : g.name, members: g.members });
  }
  if (raw.other !== undefined) {
    if (typeof raw.other !== "string") return fail("the label for ungrouped members is not text");
    if (raw.other.trim()) spec.other = raw.other.trim();
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
