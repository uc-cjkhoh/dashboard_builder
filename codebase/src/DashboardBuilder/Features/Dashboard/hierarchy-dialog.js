// "Hierarchies…" dialog: list, create, rename/re-level and delete the workbook's named hierarchies.
// Name + an ordered level picker over one table's columns; Up / Down buttons reorder (keyboard-operable).
// All text is set with textContent; the checks live in hierarchy-model.js.
import { hierarchies, addHierarchy, updateHierarchy, removeHierarchy } from "../Core/store.js";
import { LIMITS } from "../Core/validate.js";
import { checkHierarchy } from "./hierarchy-model.js";
import { placesOnDblClick } from "./placement-model.js";
import { makeButton, openDialog, closeDialog, toast, confirmDialog } from "../Core/ui.js";

/** ctx: { tables: [{ db, table }], columnsFor(db, table) → Promise<[{ name }]>, castOf(f), startNew?: boolean, canApply?: boolean, onApply?(id) } */
export function openHierarchiesDialog(ctx) {
  const dlg = el("dialog", "dialog params-dialog hier-dialog");
  const head = el("div", "dialog__head");
  const title = el("h2", null, "Hierarchies"); title.id = "hier-title";
  dlg.setAttribute("aria-labelledby", title.id);
  head.append(title);
  const body = el("div", "dialog__body");
  const foot = el("div", "dialog__foot");
  const add = makeButton("+ New hierarchy", "btn");
  const done = makeButton("Done", "btn btn--primary");
  foot.append(add, done);
  dlg.append(head, body, foot);
  let editing = ctx.startNew ? "new" : null; // the id being edited, or "new"

  const render = () => {
    body.replaceChildren();
    if (!hierarchies.length && editing !== "new")
      body.append(el("p", "bookmark-note", "No hierarchies yet. A hierarchy is a named, ordered list of fields from one table (year → quarter → month). Press Use to set a worksheet's drill levels in one step; the worksheet keeps its own copy of the levels."));
    const list = el("ul", "bookmark-list");
    for (const h of hierarchies) {
      if (editing === h.id) { list.append(editor(h)); continue; }
      const li = el("li", "bookmark");
      const info = el("div", "bookmark__info");
      info.append(el("span", "bookmark__name", h.name), el("span", "bookmark__meta", `${h.levels[0].table} · ${h.levels.map((l) => l.column).join(" › ")}`));
      const use = makeButton("Use", "btn"); use.setAttribute("aria-label", `Use ${h.name} as this worksheet's Drill levels`);
      use.title = ctx.canApply ? "Set this worksheet's Drill levels" : "Open a worksheet to use it"; use.disabled = !ctx.canApply || !ctx.onApply;
      use.addEventListener("click", () => { ctx.onApply(h.id); finish(); });
      const edit = makeButton("Edit", "btn"); edit.setAttribute("aria-label", `Edit hierarchy ${h.name}`);
      edit.addEventListener("click", () => { editing = h.id; render(); });
      const del = makeButton("Delete", "btn"); del.setAttribute("aria-label", `Delete hierarchy ${h.name}`);
      del.addEventListener("click", async () => {
        if (!(await confirmDialog(`Delete the hierarchy “${h.name}”? Worksheets that already use it keep their drill levels.`, { danger: true, confirmText: "Delete" }))) return;
        removeHierarchy(h.id); render();
      });
      // Double-click a row = Use (the Use button is the keyboard path).
      li.addEventListener("dblclick", (e) => { if (placesOnDblClick(e.target) && !use.disabled) { ctx.onApply(h.id); finish(); } });
      li.append(info, use, edit, del);
      list.append(li);
    }
    if (editing === "new") list.append(editor(null));
    if (list.children.length) body.append(list);
    add.disabled = editing !== null || hierarchies.length >= LIMITS.hierarchies;
    add.title = hierarchies.length >= LIMITS.hierarchies ? `A workbook can have at most ${LIMITS.hierarchies} hierarchies.` : "";
  };

  function editor(h) {
    const li = el("li", "bookmark params-edit");
    const form = el("div", "params-form");
    const name = el("input", "input"); name.value = h?.name ?? ""; name.maxLength = LIMITS.hierarchyName;
    const tables = ctx.tables.some((t) => h && t.db === h.levels[0].db && t.table === h.levels[0].table) || !h ? ctx.tables : [{ db: h.levels[0].db, table: h.levels[0].table }, ...ctx.tables];
    const tableSel = el("select", "select"); tableSel.setAttribute("aria-label", "Table");
    tables.forEach((t, i) => tableSel.add(new Option(`${t.db}.${t.table}`, String(i), false, h ? t.db === h.levels[0].db && t.table === h.levels[0].table : i === 0)));
    let levels = h ? h.levels.map((l) => ({ ...l })) : [];
    const levelList = el("ol", "hier-levels"); levelList.setAttribute("aria-label", "Levels, top to bottom");
    const pick = el("select", "select"); pick.setAttribute("aria-label", "Column to add as the next level");
    const addLevel = makeButton("Add level", "btn");
    const err = el("p", "field-error"); err.hidden = true; err.setAttribute("role", "alert");
    const curTable = () => tables[Number(tableSel.value)];
    let columns = [];

    const drawLevels = (focus) => {
      levelList.replaceChildren();
      levels.forEach((l, i) => {
        const row = el("li", "hier-level");
        row.append(el("span", "hier-level__n", `${i + 1}.`), el("span", "hier-level__name", l.column));
        const btn = (label, aria, on, disabled) => { const b = makeButton(label, "btn"); b.setAttribute("aria-label", aria); b.disabled = disabled; b.dataset.act = label; b.addEventListener("click", on); return b; };
        row.append(
          btn("Up", `Move level ${i + 1} (${l.column}) up`, () => { [levels[i - 1], levels[i]] = [levels[i], levels[i - 1]]; drawLevels({ i: i - 1, act: "Up" }); }, i === 0),
          btn("Down", `Move level ${i + 1} (${l.column}) down`, () => { [levels[i + 1], levels[i]] = [levels[i], levels[i + 1]]; drawLevels({ i: i + 1, act: "Down" }); }, i === levels.length - 1),
          btn("Remove", `Remove level ${i + 1} (${l.column})`, () => { levels.splice(i, 1); drawLevels({ i: Math.min(i, levels.length - 1), act: "Remove" }); }, false));
        levelList.append(row);
      });
      if (!levels.length) levelList.append(el("li", "hier-levels__empty", "No levels yet — add at least 2."));
      const used = new Set(levels.map((l) => l.column));
      pick.replaceChildren();
      for (const c of columns) if (!used.has(c.name) && !ctx.castOf({ ...curTable(), column: c.name })) pick.add(new Option(c.name, c.name));
      addLevel.disabled = !pick.options.length || levels.length >= LIMITS.drillLevels;
      if (focus) { // keep the keyboard on the control that was just used (or its neighbour once it has gone)
        const rows = [...levelList.querySelectorAll(".hier-level")];
        const target = rows[focus.i]?.querySelector(`button[data-act="${focus.act}"]:not(:disabled)`) ?? rows[focus.i]?.querySelector("button:not(:disabled)") ?? pick;
        target.focus();
      }
    };
    const loadColumns = async () => {
      const t = curTable();
      columns = t ? await ctx.columnsFor(t.db, t.table) : [];
      drawLevels();
    };
    tableSel.addEventListener("change", () => { levels = []; loadColumns(); });
    addLevel.addEventListener("click", () => {
      if (!pick.value) return;
      const t = curTable();
      levels.push({ db: t.db, table: t.table, column: pick.value });
      drawLevels({ i: levels.length - 1, act: "Up" });
    });

    const save = makeButton("Save", "btn btn--primary"), cancel = makeButton("Cancel", "btn");
    cancel.addEventListener("click", () => { editing = null; render(); });
    save.addEventListener("click", () => {
      const r = checkHierarchy({ name: name.value, levels }, hierarchies, h?.id ?? null, { castOf: ctx.castOf });
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      if (h) updateHierarchy(h.id, r.value); else addHierarchy(r.value);
      editing = null; render();
      toast(`Saved hierarchy “${r.value.name}”.`, "ok");
    });
    form.append(labelled("Name", name), labelled("Table", tableSel));
    const levelsBox = el("div", "hier-levelbox");
    const addRow = el("div", "hier-add"); addRow.append(labelled("Add a level", pick), addLevel);
    levelsBox.append(el("span", "params-field__label", "Levels (top to bottom)"), levelList, addRow);
    const actions = el("div", "params-actions"); actions.append(save, cancel);
    li.append(form, levelsBox, err, actions);
    loadColumns();
    queueMicrotask(() => name.focus());
    return li;
  }

  add.addEventListener("click", () => { editing = "new"; render(); });
  const finish = () => closeDialog(dlg);
  done.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  render();
  document.body.append(dlg);
  openDialog(dlg);
}

function labelled(label, control) {
  const wrap = el("label", "form-field params-field");
  wrap.append(el("span", "params-field__label", label), control);
  return wrap;
}
function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; }
