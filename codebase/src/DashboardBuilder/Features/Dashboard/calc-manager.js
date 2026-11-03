// The "Calculated fields" dialog, opened from the sidebar's calculator icon on a worksheet tab: every calculation as a row (the field chip, so its
// type, "add to shelf" plus and context menu all work) with an Edit button, and New calculated field in the footer. It redraws while open
// whenever the calculations change, so an edit, duplicate or delete made from the row is seen at once. All text is set with textContent.
import { bus } from "../Core/store.js";
import { icon } from "../Core/icons.js";
import { makeButton, openDialog, closeDialog } from "../Core/ui.js";

/** ctx: { state() → { items, canAdd }, chip(item) → element, onNew(), onEdit(item), limit } */
export function openCalcManager(ctx) {
  const dlg = el("dialog", "dialog params-dialog calc-manager");
  const head = el("div", "dialog__head");
  const title = el("h2", null, "Calculated fields"); title.id = "calc-manager-title";
  dlg.setAttribute("aria-labelledby", title.id);
  head.append(title);
  const body = el("div", "dialog__body");
  const foot = el("div", "dialog__foot");
  const add = makeButton("", "btn");
  add.append(icon("plus", { size: 14 }), document.createTextNode("New calculated field"));
  const done = makeButton("Done", "btn btn--primary");
  foot.append(add, done);
  dlg.append(head, body, foot);

  const render = () => {
    const { items, canAdd } = ctx.state();
    body.replaceChildren();
    if (!items.length) body.append(el("p", "bookmark-note", "No calculated fields yet. A calculated field is a formula you use like any other field."));
    else {
      const list = el("ul", "calc-manager__list");
      for (const item of items) {
        const li = el("li", "calc-manager__row");
        const edit = makeButton("Edit", "btn");
        edit.setAttribute("aria-label", `Edit ${item.calc.name}`);
        edit.addEventListener("click", () => ctx.onEdit(item));
        li.append(ctx.chip(item), edit);
        list.append(li);
      }
      body.append(list);
    }
    add.disabled = !canAdd;
    add.title = canAdd ? "Write a formula and use it like a field" : `A workbook can have at most ${ctx.limit} calculated fields.`;
  };

  const finish = () => { bus.removeEventListener("calculations:changed", render); closeDialog(dlg); };
  add.addEventListener("click", () => ctx.onNew());
  done.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  bus.addEventListener("calculations:changed", render);
  render();
  document.body.append(dlg);
  openDialog(dlg);
}

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; }
