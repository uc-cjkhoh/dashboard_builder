// T03-29 — the field pane's "Hierarchies" group: a chip per named hierarchy. A chip is dragged onto a
// worksheet's Drill tool (HIERARCHY_MIME) or applied with its plus button; both set the sheet's drill levels.
import { icon } from "../Core/icons.js";
import { makeButton } from "../Core/ui.js";
import { hierarchyStatus } from "./hierarchy-model.js";
import { LIMITS } from "../Core/validate.js";
import { fieldGroup } from "./field-group.js";

export const HIERARCHY_MIME = "application/x-ch-hierarchy";

/** ctx: { hierarchies, columnsByTable (Map "db.table" → Set), canApply (a worksheet is open), onApply(id), onManage(startNew) } */
export function hierarchyGroup({ hierarchies, columnsByTable, canApply, onApply, onManage }) {
  const group = fieldGroup("hier-group", "hierarchies", "Hierarchies", "hier-group-title");
  const head = group.querySelector("summary");
  const row = el("div", "hier-group__actions");
  const make = makeButton("", "btn calc-group__new");
  make.append(icon("plus", { size: 14 }), document.createTextNode("New hierarchy"));
  make.disabled = hierarchies.length >= LIMITS.hierarchies;
  make.title = make.disabled ? `A workbook can have at most ${LIMITS.hierarchies} hierarchies.` : "Name an ordered list of same-table fields to drill through";
  make.addEventListener("click", () => onManage(true));
  const manage = makeButton("Hierarchies…", "btn calc-group__new");
  manage.title = "Rename, re-order or delete hierarchies";
  manage.addEventListener("click", () => onManage(false));
  row.append(make, manage);
  const list = el("div", "ws-fieldset hier-group__list");
  list.setAttribute("role", "list"); list.setAttribute("aria-labelledby", head.id);
  for (const h of hierarchies) list.append(chip(h, hierarchyStatus(h, columnsByTable), canApply, onApply));
  group.append(row, list);
  return group;
}

function chip(h, status, canApply, onApply) {
  const c = el("div", "ws-field hier-field");
  c.setAttribute("role", "listitem");
  c.dataset.search = h.name.toLowerCase();
  c.dataset.hierarchy = h.id;
  const path = h.levels.map((l) => l.column).join(" › ");
  const t = icon("drill", { size: 14 }); t.classList.add("hier-field__type");
  c.append(t, el("span", "ws-field__name", h.name));
  if (!status.ok) {
    c.classList.add("hier-field--bad");
    c.title = `${h.name} · ${path} — ${status.tableMissing ? "its table isn't in the Data Model" : `missing: ${status.missing.join(", ")}`}`;
    const badge = el("span", "calc-chip calc-chip--danger");
    badge.append(icon("warning", { size: 13 }), document.createTextNode(status.tableMissing ? "No table" : "Missing field"));
    c.append(badge);
    return c;
  }
  c.title = `${h.name} · ${h.levels[0].table} · ${path}`;
  c.append(el("span", "calc-chip calc-chip--dim", `${h.levels.length} levels`));
  c.draggable = true;
  c.addEventListener("dragstart", (e) => { e.dataTransfer.setData(HIERARCHY_MIME, JSON.stringify({ id: h.id })); e.dataTransfer.effectAllowed = "copy"; });
  const add = el("button", "ws-field__add");
  add.type = "button";
  add.append(icon("plus", { size: 14 }));
  add.setAttribute("aria-label", `Use ${h.name} as the Drill levels`);
  add.title = canApply ? "Set this worksheet's Drill levels" : "Open a worksheet to use it";
  add.disabled = !canApply;
  add.addEventListener("click", () => onApply(h.id));
  c.append(add);
  return c;
}

function el(tag, cls, t) { const e = document.createElement(tag); if (cls) e.className = cls; if (t !== undefined) e.textContent = t; return e; }
