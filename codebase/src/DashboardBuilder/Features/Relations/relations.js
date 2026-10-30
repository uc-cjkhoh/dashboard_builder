import { entities, relationships, bus, emit } from "../Core/store.js";
import { linkIssue, pinOrder, matchingColumns, keysCompatible, kindLabel, unlinkedCards, joinChoices, joinBadge, joinSelection, joinFromSelection, isLegacyLeft } from "./relation-rules.js";
import { toast, makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { api } from "../Core/api.js";
import { previewRequest } from "./join-preview-model.js";
import { buildJoinCheck } from "./join-check.js";
import { linkSides, linkRoute, roundedPath } from "./link-route.js";
import { openTypeWarning } from "./type-warning.js";
import { COLUMN_MIME, encodeColumnDrag, parseColumnDrag, dropDecision } from "./link-drag.js";

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
let hoverId = null;   // the link under the pointer
let canvas, svg, labels;  // svg: the lines, under the cards; labels: the cardinality badges, over them

export function initRelations() {
  canvas = document.getElementById("model-view");
  if (!canvas) return;

  svg = svgEl("svg", { class: "rel-svg" });
  canvas.insertBefore(svg, canvas.firstChild); // behind the entity cards: a link to a far card slips under the ones between
  labels = svgEl("svg", { class: "rel-svg rel-svg--labels" });
  canvas.append(labels); // over the cards, so a badge wider than the gutter is never clipped

  bus.addEventListener("joinkey:changed", (e) => onJoinKeyChanged(e.detail));
  bus.addEventListener("entity:moved", () => render());
  bus.addEventListener("entity:loaded", (e) => { markDraggable(e.detail.entityId); render(); }); // a restored link waits for its key rows
  bus.addEventListener("entity:removed", (e) => onEntityRemoved(e.detail.entityId));
  bus.addEventListener("view:changed", () => { clearPending(); selectedId = null; render(); });
  canvas.addEventListener("scroll", render);
  initColumnDrag();
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

// --- drag a column row onto another card's row to relate them -------------------
// Pointer-free HTML5 DnD with its own MIME type. The click-to-click connectors above stay the keyboard path.
let dragFrom = null; // { entityId, column } while a row is dragged

function markDraggable(entityId) {
  if (entities.get(entityId)?.source) return; // a union / unpivot takes no relationship
  for (const row of entities.get(entityId)?.el.querySelectorAll(".col-row") ?? []) row.draggable = true;
}

function endOf(entityId, column) {
  const e = entities.get(entityId);
  const c = e?.columns?.find((x) => x.name === column);
  return e && c && !e.source ? { entityId, column, category: c.category, type: c.type, table: e.table } : null;
}

function rowEnd(row) {
  const card = row?.closest(".entity");
  return card && row.dataset.column ? endOf(card.dataset.entityId, row.dataset.column) : null;
}

function clearDropMarks() {
  for (const el of canvas.querySelectorAll(".col-row--drop-ok, .col-row--drop-no, .col-row--drag-source")) el.classList.remove("col-row--drop-ok", "col-row--drop-no", "col-row--drag-source");
}

function initColumnDrag() {
  canvas.addEventListener("dragstart", (e) => {
    const row = e.target instanceof Element ? e.target.closest(".col-row") : null;
    if (!row || !e.dataTransfer) return;
    const card = row.closest(".entity");
    dragFrom = { entityId: card.dataset.entityId, column: row.dataset.column };
    e.dataTransfer.setData(COLUMN_MIME, encodeColumnDrag(dragFrom.entityId, dragFrom.column));
    e.dataTransfer.effectAllowed = "link";
    row.classList.add("col-row--drag-source");
  });
  canvas.addEventListener("dragover", (e) => {
    if (!dragFrom || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes(COLUMN_MIME)) return;
    const row = e.target instanceof Element ? e.target.closest(".col-row") : null;
    for (const el of canvas.querySelectorAll(".col-row--drop-ok, .col-row--drop-no")) if (el !== row) el.classList.remove("col-row--drop-ok", "col-row--drop-no");
    if (!row) return; // not over a row: no drop here
    const { ok } = dropDecision({ relationships: relationships.values(), from: endOf(dragFrom.entityId, dragFrom.column), to: rowEnd(row) });
    row.classList.toggle("col-row--drop-ok", ok);
    row.classList.toggle("col-row--drop-no", !ok);
    if (ok) { e.preventDefault(); e.dataTransfer.dropEffect = "link"; } else e.dataTransfer.dropEffect = "none";
  });
  canvas.addEventListener("drop", (e) => {
    const from = e.dataTransfer && Array.from(e.dataTransfer.types).includes(COLUMN_MIME) ? parseColumnDrag(e.dataTransfer.getData(COLUMN_MIME)) : null;
    const row = e.target instanceof Element ? e.target.closest(".col-row") : null;
    dragFrom = null; clearDropMarks();
    if (!from || !row) return;
    e.preventDefault();
    if (entities.get(row.closest(".entity")?.dataset.entityId)?.source) { toast("A union or unpivot can't be related to a table yet.", "danger"); return; }
    const a = endOf(from.entityId, from.column), b = rowEnd(row);
    if (!a || !b) return;
    const { ok, problem, kind } = dropDecision({ relationships: relationships.values(), from: a, to: b });
    if (!ok) { refuse(problem, kind, a, b); return; }
    openCardinalityDialog({
      current: "1:N",
      tables: [a.table, b.table],
      check: joinCheckFor(from, { entityId: b.entityId, column: b.column }),
      onPick: (cardinality, sel) => {
        // Both rows become join keys (the checkbox's own change handler keeps card, handle and model in step).
        for (const end of [a, b]) tickKey(end.entityId, end.column);
        createRelationship(from, { entityId: b.entityId, column: b.column }, cardinality, joinFromSelection(sel));
      },
    });
  });
  canvas.addEventListener("dragend", () => { dragFrom = null; clearDropMarks(); });
}

/** A refused link: a type mismatch gets a modal (both columns, their types, columns that would fit); anything else a toast. */
function refuse(problem, kind, a, b) {
  if (kind !== "type") { if (problem) toast(problem, "danger"); return; }
  const used = [...relationships.values()].flatMap((r) => [r.from, r.to]).filter((e) => e.entityId === b.entityId).map((e) => e.column);
  const names = matchingColumns(entities.get(b.entityId)?.columns ?? [], a.category, used);
  const joinable = keysCompatible(a.category, a.category); // a compound / other column has no kind to match
  openTypeWarning({ from: a, to: b, suggestions: joinable ? { table: b.table, kind: kindLabel(a.category), names } : null });
}

function tickKey(entityId, column) {
  const key = entities.get(entityId)?.el.querySelector(`.col-row[data-column="${cssEscape(column)}"] .col-row__key`);
  if (key && !key.checked) { key.checked = true; key.dispatchEvent(new Event("change")); }
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
  const a = endOf(pending.entityId, pending.column), b = endOf(entityId, column);
  const issue = a && b && linkIssue({ relationships: relationships.values(), from: { entityId: a.entityId, column: a.column },
    to: { entityId: b.entityId, column: b.column }, fromCategory: a.category, toCategory: b.category,
    fromLabel: `${a.table}.${a.column}`, toLabel: `${b.table}.${b.column}` });
  if (issue) { clearPending(); refuse(issue.message, issue.kind, a, b); return; }
  const from = { entityId: pending.entityId, column: pending.column };
  const to = { entityId, column };
  clearPending();
  openCardinalityDialog({
    current: "1:N",
    tables: [entities.get(from.entityId)?.table ?? "first table", entities.get(to.entityId)?.table ?? "second table"],
    check: joinCheckFor(from, to),
    onPick: (cardinality, sel) => createRelationship(from, to, cardinality, joinFromSelection(sel)),
  });
}

/** What the dialog's "Check this join" needs: the request to send and the names to word the result with. */
function joinCheckFor(from, to, declared) {
  const a = entities.get(from.entityId), b = entities.get(to.entityId);
  if (!a || !b) return null;
  return {
    run: (signal) => api.joinPreview(previewRequest(a, from.column, b, to.column), { signal }),
    names: { fromTable: a.table, toTable: b.table, fromColumn: from.column, toColumn: to.column, declared },
  };
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
  labels.replaceChildren();
  const crect = canvas.getBoundingClientRect();
  for (const layer of [svg, labels]) {
    layer.setAttribute("width", String(canvas.scrollWidth));
    layer.setAttribute("height", String(canvas.scrollHeight));
  }

  const placed = []; // badge boxes already laid out; a badge that would cover one steps down
  const used = new Map(); // links already run through each gutter, so they take different lanes there
  for (const rel of relationships.values()) {
    const a = entities.get(rel.from.entityId);
    const b = entities.get(rel.to.entityId);
    if (!a || !b) continue;

    const [sa, sb] = linkSides(cardSpan(a, crect), cardSpan(b, crect));
    const p1 = anchor(a, rel.from.column, sa, crect);
    const p2 = anchor(b, rel.to.column, sb, crect);
    if (!p1 || !p2) continue;

    const [fromKind, toKind] = markerKinds(rel.cardinality);
    const edge = Math.round(sa === sb ? (sa > 0 ? Math.max(p1.x, p2.x) : Math.min(p1.x, p2.x)) : Math.min(p1.x, p2.x));
    const n = used.get(edge) ?? 0;
    used.set(edge, n + 1);
    const { line, label } = drawLink(rel, p1, sa, p2, sb, fromKind, toKind, [0, 1, -1][n % 3], placed);
    svg.append(line);
    labels.append(label);
  }
  syncKeyStrips();
  markUnlinked();
  markLinkedRows();
}

// A column in a relationship is pinned to its card's key strip, above the scrolling list: the link's end is then always on a visible row.
// Rows keep their place in the list order (data-index) when they leave the strip.
function syncKeyStrips() {
  const linked = new Set();
  for (const r of relationships.values()) for (const end of [r.from, r.to]) linked.add(`${end.entityId}\u0000${end.column}`);
  for (const entity of entities.values()) {
    const strip = entity.el.querySelector(".entity__keys"), list = entity.el.querySelector(".entity__cols");
    if (!strip || !list) continue;
    for (const row of [...entity.el.querySelectorAll(".col-row")]) {
      const pinned = linked.has(`${entity.id}\u0000${row.dataset.column}`);
      if (pinned && row.parentElement !== strip) strip.append(row);
      else if (!pinned && row.parentElement === strip) {
        const next = [...list.children].find((r) => Number(r.dataset.index) > Number(row.dataset.index));
        list.insertBefore(row, next ?? null);
      }
    }
    entity.el.classList.toggle("entity--has-keys", strip.children.length > 0);
    orderStrip(entity, strip);
  }
}

// Pinned rows follow their partner, not the column order: sorted by the partner card's position, then by relationship, so the links
// between two cards run in parallel instead of crossing (a card with partners above and below lists the upper partner's keys first).
function orderStrip(entity, strip) {
  if (strip.children.length < 2) return;
  const info = new Map(); // column -> { partnerTop, seq }
  let seq = 0;
  for (const r of relationships.values()) {
    seq++;
    for (const [mine, theirs] of [[r.from, r.to], [r.to, r.from]])
      if (mine.entityId === entity.id) info.set(mine.column, { partnerTop: entities.get(theirs.entityId)?.el.offsetTop ?? 0, seq });
  }
  const rows = [...strip.children];
  const want = pinOrder(rows.map((row) => ({ column: row.dataset.column, ...(info.get(row.dataset.column) ?? { partnerTop: 0, seq: 0 }) })));
  if (want.every((c, i) => c === rows[i].dataset.column)) return; // already in order: leave the DOM alone
  for (const c of want) strip.append(rows.find((row) => row.dataset.column === c));
}

// Every table card belongs to a relationship; one that doesn't says so (text + dashed outline, never colour alone).
function markUnlinked() {
  const lone = new Set(unlinkedCards([...entities.values()].map((e) => ({ id: e.id, source: Boolean(e.source) })), relationships.values()));
  for (const entity of entities.values()) {
    const flag = lone.has(entity.id);
    entity.el.classList.toggle("entity--unlinked", flag);
    const need = entity.el.querySelector(".entity__need");
    if (need) need.hidden = !flag;
  }
}

function drawLink(rel, p1, s1, p2, s2, fromKind, toKind, lane, placed) {
  const cls = `rel-link${rel.id === selectedId ? " rel-link--selected" : ""}`;
  const line = svgEl("g", { class: cls, "data-rel": rel.id });
  const { points, label: spot } = linkRoute(p1, s1, p2, s2, lane);
  const d = roundedPath(points);
  line.append(svgEl("path", { class: "rel-link__hit", d }), svgEl("path", { class: "rel-link__line", d }),
    endMarker(p1, { x: s1, y: 0 }, fromKind), endMarker(p2, { x: s2, y: 0 }, toKind));
  const label = svgEl("g", { class: `${cls} rel-link--label`, "data-rel": rel.id });
  const text = joinBadge(rel.cardinality, rel.joinType), w = badgeWidth(text);
  while (placed.some((b) => Math.abs(b.x - spot.x) < (b.w + w) / 2 && Math.abs(b.y - spot.y) < BADGE_H)) spot.y += BADGE_H + 2;
  placed.push({ x: spot.x, y: spot.y, w });
  label.append(badge(text, w, spot));

  for (const g of [line, label]) { // the line and its badge sit in two layers but act as one link
    g.addEventListener("click", (e) => { e.stopPropagation(); editRelationship(rel); });
    g.addEventListener("pointerenter", () => { hoverId = rel.id; markLinkedRows(); });
    g.addEventListener("pointerleave", () => { hoverId = null; markLinkedRows(); });
  }
  return { line, label };
}

// The two key rows a hovered or selected link joins read as one pair: both take the accent wash.
function markLinkedRows() {
  for (const el of canvas.querySelectorAll(".col-row--linked, .rel-link--hover")) el.classList.remove("col-row--linked", "rel-link--hover");
  if (hoverId) for (const el of canvas.querySelectorAll(`.rel-link[data-rel="${hoverId}"]`)) el.classList.add("rel-link--hover");
  for (const id of new Set([selectedId, hoverId])) {
    const rel = id && relationships.get(id);
    if (!rel) continue;
    for (const end of [rel.from, rel.to])
      entities.get(end.entityId)?.el.querySelector(`.col-row[data-column="${cssEscape(end.column)}"]`)?.classList.add("col-row--linked");
  }
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

const BADGE_H = 24;
// P31: an outer join says so on the badge ("1:N · left", "· right", "· full") — words, not a colour.
const badgeWidth = (text) => (text.length <= 3 ? 34 : text.length > 10 ? 70 : 64);

function badge(text, w, mid) {
  const g = svgEl("g", { class: "rel-badge" });
  g.append(
    svgEl("rect", { x: mid.x - w / 2, y: mid.y - BADGE_H / 2, width: w, height: BADGE_H, rx: 8 }),
    svgEl("text", { x: mid.x, y: mid.y, "text-anchor": "middle", "dominant-baseline": "central" }, text),
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
    check: joinCheckFor(rel.from, rel.to, rel.cardinality),
    onPick: (cardinality, sel) => { rel.cardinality = cardinality; Object.assign(rel, joinFromSelection(sel)); emit("rel:changed", { id: rel.id }); render(); },
    onDelete: () => { relationships.delete(rel.id); emit("rel:changed", { id: rel.id }); select(null); render(); },
  });
}

function select(id) {
  selectedId = id;
  render();
}

// --- cardinality dialog -------------------------------------------------------
function openCardinalityDialog({ current = "1:N", joinType = "inner", tables = ["first table", "second table"], legacy = false, check = null, onPick, onDelete }) {
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
  if (check) body.append(buildJoinCheck(dlg, check));
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

function cardSpan(entity, crect) {
  const r = entity.el.getBoundingClientRect();
  return { left: r.left - crect.left + canvas.scrollLeft, right: r.right - crect.left + canvas.scrollLeft };
}

// Anchor a link on the card edge `side` (+1 right, -1 left), at the key row's vertical centre.
function anchor(entity, column, side, crect) {
  const r = entity.el.getBoundingClientRect();
  const top = r.top - crect.top + canvas.scrollTop;
  const bottom = r.bottom - crect.top + canvas.scrollTop;

  let y = top + 24;
  const row = entity.el.querySelector(`.col-row[data-column="${cssEscape(column)}"]`);
  if (row) {
    const rr = row.getBoundingClientRect();
    y = clamp(rr.top + rr.height / 2 - crect.top + canvas.scrollTop, top + 8, bottom - 8);
  }
  const { left, right } = cardSpan(entity, crect);
  return { x: side > 0 ? right : left, y };
}

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
