import { entities, relationships, bus, emit } from "../Core/store.js";
import { linkProblem, joinChoices, joinBadge, joinSelection, joinFromSelection, isLegacyLeft } from "./relation-rules.js";
import { toast, makeButton, openDialog, closeDialog } from "../Core/ui.js";

// Relationships (P5): logical, typed links the user draws between the join keys checked on two
// entities (decision D5 — ClickHouse neither creates nor validates them). Creation is
// click-to-click on the connector handles (accessible; no drag geometry needed): click A's key
// handle, then B's, pick a cardinality. Links render as an SVG overlay with shape-coded
// endpoints (readable without colour) and a cardinality badge; clicking one edits/deletes it.
const SVG_NS = "http://www.w3.org/2000/svg";
const CARDINALITIES = ["1:1", "1:N", "N:1", "N:M"];

let seq = 0;
let pending = null;   // { entityId, column, handle } — the first-picked endpoint
let selectedId = null;
let canvas, svg;

export function initRelations() {
  canvas = document.getElementById("model-view");
  if (!canvas) return;

  svg = svgEl("svg", { class: "rel-svg" });
  canvas.insertBefore(svg, canvas.firstChild); // behind the entity cards

  bus.addEventListener("joinkey:changed", (e) => onJoinKeyChanged(e.detail));
  bus.addEventListener("entity:moved", () => render());
  bus.addEventListener("entity:loaded", () => render()); // a restored link waits for its key rows
  bus.addEventListener("entity:removed", (e) => onEntityRemoved(e.detail.entityId));
  bus.addEventListener("view:changed", () => { clearPending(); selectedId = null; render(); });
  canvas.addEventListener("scroll", render);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { clearPending(); select(null); }
  });
}

// --- connector handles on checked join-key rows -------------------------------
function onJoinKeyChanged({ entityId, column, checked }) {
  const entity = entities.get(entityId);
  if (!entity) return;
  const row = entity.el.querySelector(`.col-row[data-column="${cssEscape(column)}"]`);
  if (!row) return;

  if (checked) {
    if (!row.querySelector(".rel-connector")) row.append(makeConnector(entityId, column));
  } else {
    row.querySelector(".rel-connector")?.remove();
    // A key that is no longer a join key can't anchor a link — drop any that used it.
    for (const rel of relationships.values()) {
      if (endpointMatches(rel.from, entityId, column) || endpointMatches(rel.to, entityId, column))
        relationships.delete(rel.id);
    }
    if (pending && pending.entityId === entityId && pending.column === column) clearPending();
    render();
  }
}

function makeConnector(entityId, column) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "rel-connector";
  handle.setAttribute("aria-label", `Relate join key ${column}`);
  handle.title = "Click, then click another entity's join key to relate";
  handle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onConnectorClick(entityId, column, handle);
  });
  return handle;
}

function onConnectorClick(entityId, column, handle) {
  if (!pending) {
    pending = { entityId, column, handle };
    handle.classList.add("is-linking");
    toast("Pick a join key on another entity to relate.", "info");
    return;
  }
  const end = (id, col) => { const e = entities.get(id); return { cat: e?.columns?.find((c) => c.name === col)?.category, label: `${e?.table}.${col}` }; };
  const p = end(pending.entityId, pending.column), q = end(entityId, column);
  const problem = linkProblem({ relationships: relationships.values(), from: { entityId: pending.entityId, column: pending.column },
    to: { entityId, column }, fromCategory: p.cat, toCategory: q.cat, fromLabel: p.label, toLabel: q.label });
  if (problem) { clearPending(); toast(problem, "danger"); return; }
  const from = { entityId: pending.entityId, column: pending.column };
  const to = { entityId, column };
  clearPending();
  openCardinalityDialog({
    current: "1:N",
    tables: [entities.get(from.entityId)?.table ?? "first table", entities.get(to.entityId)?.table ?? "second table"],
    onPick: (cardinality, sel) => createRelationship(from, to, cardinality, joinFromSelection(sel)),
  });
}

function clearPending() {
  pending?.handle.classList.remove("is-linking");
  pending = null;
}

// --- relationship lifecycle ---------------------------------------------------
function createRelationship(from, to, cardinality, { joinType, joinFixed } = { joinType: "inner", joinFixed: true }) {
  const id = `rel#${++seq}`;
  relationships.set(id, { id, from, to, cardinality, joinType, joinFixed });
  emit("rel:changed", { id });
  select(id);
  render();
}

/** Recreate a saved relationship (workbook open). Drawn once both endpoints' key rows exist. */
export function restoreRelationship(from, to, cardinality, joinType = "inner", joinFixed = false) {
  const id = `rel#${++seq}`;
  relationships.set(id, { id, from, to, cardinality, joinType, joinFixed });
  emit("rel:changed", { id });
  render();
}

function onEntityRemoved(entityId) {
  if (pending?.entityId === entityId) clearPending(); // a half-made link to a removed card is void
  for (const rel of relationships.values()) {
    if (rel.from.entityId === entityId || rel.to.entityId === entityId) relationships.delete(rel.id);
  }
  render();
}

// --- SVG rendering ------------------------------------------------------------
function render() {
  if (!svg) return;
  svg.replaceChildren();
  const crect = canvas.getBoundingClientRect();
  svg.setAttribute("width", String(canvas.scrollWidth));
  svg.setAttribute("height", String(canvas.scrollHeight));

  for (const rel of relationships.values()) {
    const a = entities.get(rel.from.entityId);
    const b = entities.get(rel.to.entityId);
    if (!a || !b) continue;

    const ca = cardCenterX(a, crect);
    const cb = cardCenterX(b, crect);
    const p1 = anchor(a, rel.from.column, cb, crect);
    const p2 = anchor(b, rel.to.column, ca, crect);
    if (!p1 || !p2) continue;

    const [fromKind, toKind] = markerKinds(rel.cardinality);
    svg.append(drawLink(rel, p1, p2, fromKind, toKind));
  }
}

function drawLink(rel, p1, p2, fromKind, toKind) {
  const g = svgEl("g", { class: `rel-link${rel.id === selectedId ? " rel-link--selected" : ""}` });

  const hit = svgEl("path", { class: "rel-link__hit", d: `M${p1.x},${p1.y} L${p2.x},${p2.y}` });
  const line = svgEl("path", { class: "rel-link__line", d: `M${p1.x},${p1.y} L${p2.x},${p2.y}` });

  const ux = unit(p1, p2);
  const vx = unit(p2, p1);
  g.append(hit, line,
    endMarker(p1, ux, fromKind),
    endMarker(p2, vx, toKind),
    badge(rel, midpoint(p1, p2)));

  g.addEventListener("click", (e) => { e.stopPropagation(); editRelationship(rel); });
  return g;
}

function endMarker(p, u, kind) {
  const g = svgEl("g", { class: `rel-end rel-end--${kind}` });
  const px = -u.y, py = u.x; // perpendicular
  if (kind === "one") {
    const d = 12, w = 7;
    const bx = p.x + u.x * d, by = p.y + u.y * d;
    g.append(svgEl("line", { x1: bx + px * w, y1: by + py * w, x2: bx - px * w, y2: by - py * w }));
  } else { // many — a crow's foot
    const d = 15, w = 7;
    const bx = p.x + u.x * d, by = p.y + u.y * d;
    g.append(
      svgEl("line", { x1: p.x, y1: p.y, x2: bx + px * w, y2: by + py * w }),
      svgEl("line", { x1: p.x, y1: p.y, x2: bx, y2: by }),
      svgEl("line", { x1: p.x, y1: p.y, x2: bx - px * w, y2: by - py * w }),
    );
  }
  return g;
}

function badge(rel, mid) {
  const g = svgEl("g", { class: "rel-badge" });
  // P31: an outer join says so on the badge ("1:N · left", "· right", "· full") — words, not a colour.
  const label = joinBadge(rel.cardinality, rel.joinType);
  const w = label === rel.cardinality ? 34 : label.length > 10 ? 70 : 64, h = 18;
  g.append(
    svgEl("rect", { x: mid.x - w / 2, y: mid.y - h / 2, width: w, height: h, rx: 5 }),
    svgEl("text", { x: mid.x, y: mid.y, "text-anchor": "middle", "dominant-baseline": "central" }, label),
  );
  return g;
}

// --- edit / delete ------------------------------------------------------------
function editRelationship(rel) {
  select(rel.id);
  openCardinalityDialog({
    current: rel.cardinality,
    joinType: joinSelection(rel.joinType, rel.joinFixed),
    legacy: isLegacyLeft(rel.joinType, rel.joinFixed),
    tables: [entities.get(rel.from.entityId)?.table ?? "first table", entities.get(rel.to.entityId)?.table ?? "second table"],
    onPick: (cardinality, sel) => { rel.cardinality = cardinality; Object.assign(rel, joinFromSelection(sel)); emit("rel:changed", { id: rel.id }); render(); },
    onDelete: () => { relationships.delete(rel.id); emit("rel:changed", { id: rel.id }); select(null); render(); },
  });
}

function select(id) {
  selectedId = id;
  render();
}

// --- cardinality dialog -------------------------------------------------------
function openCardinalityDialog({ current = "1:N", joinType = "inner", tables = ["first table", "second table"], legacy = false, onPick, onDelete }) {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog dialog--sm";

  const head = document.createElement("div");
  head.className = "dialog__head";
  head.textContent = "Relationship: join and cardinality";

  const body = document.createElement("div");
  body.className = "dialog__body";
  // P31 / T02-12: how the two tables join — only matching rows, or keep every row of the first table (left),
  // the second (right) or both (full). The link runs first → second. Pick it first; picking a cardinality saves both.
  let join = joinType;
  const joinRow = document.createElement("fieldset");
  joinRow.className = "join-choice";
  const legend = document.createElement("legend");
  legend.textContent = "Join";
  joinRow.append(legend);
  for (const { value: v, text } of joinChoices(tables[0], tables[1], legacy)) {
    const lab = document.createElement("label");
    lab.className = "form-check";
    const r = document.createElement("input");
    r.type = "radio"; r.name = "join-type"; r.value = v; r.checked = v === join;
    r.addEventListener("change", () => { if (r.checked) join = v; });
    lab.append(r, document.createTextNode(` ${text}`));
    joinRow.append(lab);
  }
  body.append(joinRow);
  const choices = document.createElement("div");
  choices.className = "card-choices";
  for (const c of CARDINALITIES) {
    const b = makeButton(c, `card-choice${c === current ? " is-active" : ""}`);
    b.addEventListener("click", () => { closeDialog(dlg); onPick(c, join); });
    choices.append(b);
  }
  body.append(choices);

  const foot = document.createElement("div");
  foot.className = "dialog__foot";
  if (onDelete) {
    const del = makeButton("Delete", "btn btn--danger");
    del.addEventListener("click", () => { closeDialog(dlg); onDelete(); });
    foot.append(del);
  }
  const cancel = makeButton("Cancel", "btn");
  cancel.addEventListener("click", () => closeDialog(dlg));
  foot.append(cancel);

  dlg.append(head, body, foot);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDialog(dlg); });
  document.body.append(dlg);
  openDialog(dlg);
}

// --- geometry helpers ---------------------------------------------------------
// "1:N" from A→B → A side "one", B side "many".
function markerKinds(cardinality) {
  const [a, b] = cardinality.split(":");
  return [a === "1" ? "one" : "many", b === "1" ? "one" : "many"];
}

function cardCenterX(entity, crect) {
  const r = entity.el.getBoundingClientRect();
  return (r.left + r.right) / 2 - crect.left + canvas.scrollLeft;
}

// Anchor a link on the card edge facing the other card, at the key row's vertical centre.
function anchor(entity, column, otherCenterX, crect) {
  const r = entity.el.getBoundingClientRect();
  const left = r.left - crect.left + canvas.scrollLeft;
  const right = r.right - crect.left + canvas.scrollLeft;
  const top = r.top - crect.top + canvas.scrollTop;
  const bottom = r.bottom - crect.top + canvas.scrollTop;

  let y = top + 18;
  const row = entity.el.querySelector(`.col-row[data-column="${cssEscape(column)}"]`);
  if (row) {
    const rr = row.getBoundingClientRect();
    y = clamp(rr.top + rr.height / 2 - crect.top + canvas.scrollTop, top + 8, bottom - 8);
  }
  const useRight = otherCenterX >= (left + right) / 2;
  return { x: useRight ? right : left, y };
}

function unit(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function endpointMatches(ep, entityId, column) {
  return ep.entityId === entityId && ep.column === column;
}

// --- tiny SVG DOM helper ------------------------------------------------------
function svgEl(name, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
