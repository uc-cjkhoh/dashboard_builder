// The "Group…" dialog (T02-30): name the groups of a text field and put its members into them. It saves a group calculation
// (calc-workbook / group-model.js: { id, name, formula: "", group }) — the same store, pills and query path as any calculated
// field. DOM only; every rule is in group-model.js. Members and names are shown with textContent / input values only.
import { calculations, addCalculation, updateCalculation } from "../Core/store.js";
import { LIMITS } from "../Core/validate.js";
import { makeButton, openDialog, closeDialog, toast } from "../Core/ui.js";
import { checkName } from "./calc-workbook.js";
import { checkGroupSpec, groupCalcName, assignmentsOf, groupsFromAssignments, maxMembersFor } from "./group-model.js";

let seq = 0;
const el = (tag, cls, t) => { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; };
export const SHOWN = 200; // members listed (the distinct-values endpoint is asked for one more)

/**
 * `field` = { db, table, column } the grouped column; `fieldName` its display name; `calcId` the group calculation being edited (or null);
 * `load()` resolves the column's distinct members (bounded; NULL is skipped — it can't be grouped and stays empty).
 */
export function openGroupDialog({ field, fieldName, calcId = null, load }) {
  const existing = calcId ? calculations.find((c) => c.id === calcId) : null;
  if (calcId && !existing?.group) return;
  const n = ++seq;
  const groups = []; // [{ id, name }] in order
  let nextId = 1;
  const assign = new Map(); // member -> group id
  const newGroup = (name) => { const g = { id: nextId++, name: name ?? `Group ${nextId - 1}` }; groups.push(g); return g; };
  if (existing) {
    const byName = assignmentsOf(existing.group.groups);
    for (const g of existing.group.groups) newGroup(g.name);
    for (const [m, gname] of byName) assign.set(m, groups.find((g) => g.name === gname).id);
  } else newGroup("Group 1");
  let otherOn = !!existing?.group.other, otherText = existing?.group.other ?? "Other";

  const dlg = el("dialog", "dialog grp-dialog");
  const title = el("h3", "dialog__title", existing ? `Edit groups · ${fieldName}` : `Group · ${fieldName}`);
  title.id = `grp-title-${n}`;
  dlg.setAttribute("aria-labelledby", title.id);
  const body = el("div", "dialog__body grp-dialog__body");
  const hint = el("p", "grp-hint", "Members you put in a group are shown, counted and charted under the group's name. A member in no group keeps its own value, or the label below. The empty (NULL) value stays empty. Grouping is done by the database, so every member is matched exactly.");

  const nameField = el("div", "field");
  const nameLabel = el("label", null, "Name of the group field"); nameLabel.htmlFor = `grp-name-${n}`;
  const name = el("input", "input"); name.id = nameLabel.htmlFor; name.type = "text"; name.autocomplete = "off"; name.maxLength = LIMITS.calcName;
  name.value = existing?.name ?? groupCalcName(field.column, calculations);
  const nameMsg = el("div", "grp-error"); nameMsg.id = `grp-nmsg-${n}`; nameMsg.setAttribute("role", "alert");
  name.setAttribute("aria-describedby", nameMsg.id);
  nameField.append(nameLabel, name, nameMsg);

  const groupsField = el("div", "field");
  const groupsHead = el("div", "label", "Groups"); groupsHead.id = `grp-gh-${n}`;
  const groupList = el("div", "grp-groups"); groupList.setAttribute("role", "group"); groupList.setAttribute("aria-labelledby", groupsHead.id);
  const addBtn = makeButton("Add group", "btn grp-add");
  groupsField.append(groupsHead, groupList, addBtn);

  const otherField = el("div", "field grp-other");
  const otherCheck = el("input"); otherCheck.type = "checkbox"; otherCheck.id = `grp-oc-${n}`; otherCheck.checked = otherOn;
  const otherCheckLabel = el("label", null, "Label ungrouped members"); otherCheckLabel.htmlFor = otherCheck.id;
  const otherInput = el("input", "input"); otherInput.type = "text"; otherInput.autocomplete = "off"; otherInput.maxLength = LIMITS.groupName;
  otherInput.value = otherText; otherInput.disabled = !otherOn; otherInput.setAttribute("aria-label", "Label for ungrouped members");
  otherField.append(otherCheck, otherCheckLabel, otherInput);

  const membersField = el("div", "field");
  const membersHead = el("div", "label", "Members"); membersHead.id = `grp-mh-${n}`;
  const note = el("p", "grp-note", "Loading the field's members…"); note.setAttribute("aria-live", "polite");
  const memberList = el("div", "grp-members"); memberList.setAttribute("role", "group"); memberList.setAttribute("aria-labelledby", membersHead.id);
  membersField.append(membersHead, note, memberList);

  const status = el("p", "grp-status"); status.setAttribute("aria-live", "polite");
  const msg = el("div", "grp-error"); msg.setAttribute("role", "alert");
  body.append(hint, nameField, groupsField, otherField, membersField, status, msg);
  const foot = el("div", "dialog__foot");
  const cancel = makeButton("Cancel", "btn"), save = makeButton("Save", "btn btn--primary");
  save.disabled = true;
  foot.append(cancel, save);
  dlg.append(title, body, foot);

  const NONE = "";
  let selects = []; // [{ member, select }]
  const spec = () => {
    const pairs = [...assign].map(([m, id]) => [m, id]);
    const named = groupsFromAssignments(pairs, groups.map((g) => g.id)).map((g) => ({ name: groups.find((x) => x.id === g.name).name.trim(), members: g.members }));
    const out = { field: { db: field.db, table: field.table, column: field.column }, groups: named };
    if (otherOn && otherText.trim()) out.other = otherText;
    return out;
  };
  const refresh = () => {
    const s = spec();
    const used = s.groups.reduce((a, g) => a + g.members.length, 0);
    status.textContent = `${used} of ${maxMembersFor(s)} members grouped · ${s.groups.length} group${s.groups.length === 1 ? "" : "s"}${used > maxMembersFor(s) ? " — over the limit" : ""}`;
    const dup = groups.find((g, i) => groups.some((o, j) => j < i && o.name.trim().toLowerCase() === g.name.trim().toLowerCase()));
    const blank = groups.find((g) => !g.name.trim() && [...assign.values()].includes(g.id));
    const r = dup ? { ok: false, error: `A group named '${dup.name.trim()}' already exists.` } : blank ? { ok: false, error: "Give every group a name." } : checkGroupSpec(s, selects.map((x) => x.member));
    const noLabel = otherOn && !otherText.trim();
    const nm = checkName(name.value, calculations, existing?.id);
    nameMsg.textContent = nm.ok ? "" : nm.error;
    if (nm.ok) name.removeAttribute("aria-invalid"); else name.setAttribute("aria-invalid", "true");
    msg.textContent = noLabel ? "Give the ungrouped members a label." : !r.ok && (used > 0 || dup || blank || otherOn) ? r.error : "";
    save.disabled = !(r.ok && nm.ok) || noLabel;
  };
  const fillSelects = () => {
    for (const { member, select } of selects) {
      const cur = assign.get(member);
      select.replaceChildren(new Option("(not grouped)", NONE, false, cur === undefined));
      for (const g of groups) select.add(new Option(g.name.trim() || "(unnamed group)", String(g.id), false, g.id === cur));
    }
  };
  const drawGroups = () => {
    groupList.replaceChildren();
    for (const g of groups) {
      const row = el("div", "grp-group");
      const input = el("input", "input grp-group__name"); input.type = "text"; input.autocomplete = "off"; input.maxLength = LIMITS.groupName; input.value = g.name;
      input.setAttribute("aria-label", `Name of group ${groups.indexOf(g) + 1}`);
      input.addEventListener("input", () => { g.name = input.value; fillSelects(); refresh(); });
      const rm = makeButton("Remove", "btn btn--ghost grp-group__remove");
      rm.setAttribute("aria-label", `Remove group ${g.name || groups.indexOf(g) + 1}`);
      rm.disabled = groups.length === 1;
      rm.addEventListener("click", () => {
        groups.splice(groups.indexOf(g), 1);
        for (const [m, id] of [...assign]) if (id === g.id) assign.delete(m);
        drawGroups(); fillSelects(); refresh();
        groupList.querySelector("input")?.focus();
      });
      row.append(input, rm);
      groupList.append(row);
    }
    addBtn.disabled = groups.length >= LIMITS.groups;
  };
  addBtn.addEventListener("click", () => {
    newGroup(); drawGroups(); fillSelects(); refresh();
    const inputs = groupList.querySelectorAll("input"); inputs[inputs.length - 1].focus(); inputs[inputs.length - 1].select();
  });
  name.addEventListener("input", refresh);
  otherCheck.addEventListener("change", () => { otherOn = otherCheck.checked; otherInput.disabled = !otherOn; refresh(); });
  otherInput.addEventListener("input", () => { otherText = otherInput.value; refresh(); });

  const fillMembers = (values) => {
    const seen = new Set();
    const members = [];
    for (const v of values.slice(0, SHOWN)) if (v != null && !seen.has(String(v))) { seen.add(String(v)); members.push(String(v)); }
    for (const m of assign.keys()) if (!seen.has(m)) { seen.add(m); members.push(m); } // grouped members the list no longer holds
    selects = members.map((member, i) => {
      const row = el("div", "grp-member");
      const lab = el("label", "grp-member__value", member); lab.title = member;
      const select = el("select", "select select--light grp-member__select"); select.id = `grp-m-${n}-${i}`; lab.htmlFor = select.id;
      select.addEventListener("change", () => { if (select.value === NONE) assign.delete(member); else assign.set(member, Number(select.value)); refresh(); });
      row.append(lab, select);
      memberList.append(row);
      return { member, select };
    });
    fillSelects();
    note.textContent = members.length ? (values.length > SHOWN ? `Showing the first ${SHOWN} members — more exist.` : "") : "This field has no members to group.";
    refresh();
  };

  const finish = () => closeDialog(dlg);
  cancel.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  save.addEventListener("click", () => {
    refresh();
    if (save.disabled) return;
    const group = spec();
    const nm = name.value.trim();
    if (existing) updateCalculation(existing.id, { name: nm, group });
    else if (calculations.length >= LIMITS.calculations) { toast(`A workbook can have at most ${LIMITS.calculations} calculated fields.`, "info"); return; }
    else addCalculation({ name: nm, formula: "", group });
    finish();
    toast(`Saved group field “${nm}”.`, "ok");
  });

  drawGroups();
  refresh();
  document.body.append(dlg);
  openDialog(dlg);
  Promise.resolve().then(load).then((v) => fillMembers(v ?? []))
    .catch(() => { note.textContent = "Couldn't load this field's members."; });
  name.focus();
}
