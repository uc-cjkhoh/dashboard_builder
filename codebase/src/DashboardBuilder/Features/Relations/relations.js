import { entities, relationships, bus, emit, isModelActive } from "../Core/store.js";
import { relEnds, linkIssue, pinOrder, matchingColumns, keysCompatible, kindLabel, unlinkedCards, joinChoices, joinBadge, joinSelection, joinFromSelection, isLegacyLeft } from "./relation-rules.js";
import { toast, makeButton, openDialog, closeDialog } from "../Core/ui.js";
import { api } from "../Core/api.js";
import { previewRequest } from "./join-preview-model.js";
import { buildJoinCheck } from "./join-check.js";
import { buildKeyPairs } from "./key-pairs-ui.js";
import { compoundName, suggestTarget } from "./key-pairs.js";
import { linkSides, linkRoute, roundedPath } from "./link-route.js";
import { openTypeWarning } from "./type-warning.js";
import { COLUMN_MIME, encodeColumnDrag, parseColumnDrag, dropDecision } from "./link-drag.js";
import { describeRelationship } from "./relation-describe.js";
import { linkKeyAction, stepIndex, cardIndex, linkHint, rowLabel } from "./link-keys.js";

// Relationships: logical, typed links the user draws between a column of one entity and a column of
// another (decision D5 — ClickHouse neither creates nor validates them). Creation is drag-and-drop only:
// drag a column row onto a row of another card, pick a cardinality. Links render as an SVG overlay with shape-coded
// endpoints (readable without colour) and a cardinality badge; clicking one edits/deletes it.
const SVG_NS = "http://www.w3.org/2000/svg";
const CARDINALITIES = ["1:1", "1:N", "N:1", "N:M"];

let seq = 0;
let selectedId = null;
let hoverId = null;   // the link under the pointer
let canvas, svg, labels, guide, keyHint, notes;  // svg: the lines, under the cards; labels: the cardinality badges, over them

export function initRelations() {
  canvas = document.getElementById("model-view");
  if (!canvas) return;

  svg = svgEl("svg", { class: "rel-svg" });
  canvas.insertBefore(svg, canvas.firstChild); // behind the entity cards: a link to a far card slips under the ones between
  labels = svgEl("svg", { class: "rel-svg rel-svg--labels" });
  canvas.append(labels); // over the cards, so a badge wider than the gutter is never clipped
  guide = document.createElement("p");
  guide.className = "rel-guide";
  guide.hidden = true;
  guide.textContent = "Drag a column onto a column in another table to relate them.";
  canvas.parentElement.append(guide); // over the Data Source, centred at its foot
  keyHint = document.createElement("p");
  keyHint.className = "rel-guide rel-keyhint";
  keyHint.setAttribute("role", "status"); // always rendered so a screen reader announces text put into it; empty = visually hidden
  canvas.parentElement.append(keyHint); // the keyboard pick's instruction line, same spot as the guide
  notes = document.createElement("details");
  notes.className = "rel-notes";
  notes.open = true;
  notes.hidden = true;
  canvas.parentElement.append(notes); // the "Relationships" card: each link in plain words (renderNotes)
  const help = document.createElement("p");
  help.id = "rel-key-help";
  help.className = "sr-only";
  help.textContent = "Press Enter to pick this column, then Enter on a column in another table to relate them. Up and Down arrows, Home and End move within the table; [ and ] switch table.";
  canvas.parentElement.append(help);

  bus.addEventListener("entity:moved", () => render());
  bus.addEventListener("entity:loaded", (e) => { markDraggable(e.detail.entityId); render(); }); // a restored link waits for its key rows
  bus.addEventListener("entity:removed", (e) => { cancelKeyPick(); onEntityRemoved(e.detail.entityId); });
  bus.addEventListener("view:changed", () => { cancelKeyPick(); selectedId = null; render(); });
  canvas.addEventListener("scroll", render);
  initColumnDrag();
  initColumnKeys();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { cancelKeyPick(); select(null); }
  });
}

// --- drag a column row onto another card's row to relate them -------------------
// HTML5 DnD with its own MIME type — the only way to create a relationship.
let dragFrom = null; // { entityId, column } while a row is dragged

function markDraggable(entityId) {
  if (entities.get(entityId)?.source) return; // a union / unpivot takes no relationship
  for (const row of entities.get(entityId)?.el.querySelectorAll(".col-row") ?? []) { row.draggable = true; row.tabIndex = -1; row.setAttribute("role", "group"); row.setAttribute("aria-describedby", "rel-key-help"); refreshRow(row); }
  ensureRove(entityId);
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
  markSuggestions(null);
}

/** While relating from `source` (a drag or a keyboard pick), flag each other table's best-matching free column (same name, same kind). Only a hint; any column can still be chosen. */
function markSuggestions(source) {
  for (const el of canvas.querySelectorAll(".col-row--suggest")) { el.classList.remove("col-row--suggest"); refreshRow(el); }
  if (!source) return;
  const used = [...relationships.values()].flatMap(relEnds);
  for (const [id, e] of entities) {
    if (e.source || id === source.entityId) continue;
    const name = suggestTarget({ name: source.column, category: source.category }, e.columns ?? [], used.filter((u) => u.entityId === id).map((u) => u.column));
    const row = name ? rowOf({ entityId: id, column: name }) : null;
    if (row) { row.classList.add("col-row--suggest"); refreshRow(row); }
  }
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
    markSuggestions(endOf(dragFrom.entityId, dragFrom.column));
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
    proposeLink(endOf(from.entityId, from.column), rowEnd(row));
  });
  canvas.addEventListener("dragend", () => { dragFrom = null; clearDropMarks(); });
}

/** The one path to a new relationship, for a drop and for the keyboard: check the pair, then ask for the cardinality. */
function proposeLink(a, b, focusEnd = null) {
  if (!a || !b) return;
  const { ok, problem, kind } = dropDecision({ relationships: relationships.values(), from: a, to: b });
  if (!ok) { refuse(problem, kind, a, b); return; }
  const from = { entityId: a.entityId, column: a.column };
  openCardinalityDialog({
    current: "1:N",
    tables: [a.table, b.table],
    keys: keyPairsFor(from, { entityId: b.entityId, column: b.column }, [], null),
    onPick: (cardinality, sel, pairs) => {
      createRelationship(from, { entityId: b.entityId, column: b.column }, cardinality, { ...joinFromSelection(sel), pairs });
      if (focusEnd) rowOf(focusEnd)?.focus(); // the link moves both rows into the key strips; keep the keyboard where it was
    },
  });
}

// --- the keyboard way: Enter on a row picks it, Enter on a row of another table relates them -----------------
let keyFrom = null; // { entityId, column } of the row picked with the keyboard
let refocusing = false; // a row being moved between a card's strip and list blurs and refocuses; that is not leaving

function rowOf(end) { return entities.get(end.entityId)?.el.querySelector(`.col-row[data-column="${cssEscape(end.column)}"]`); }
const sourceEnd = () => (keyFrom ? endOf(keyFrom.entityId, keyFrom.column) : null);

/** Name, and `aria-current` on the picked source. Only the rows whose state changed are refreshed. */
function refreshRow(row) {
  const end = rowEnd(row);
  if (!end) return;
  row.setAttribute("aria-label", rowLabel(end, end.type, sourceEnd()) + (row.classList.contains("col-row--suggest") ? ", suggested match" : ""));
  if (keyFrom && keyFrom.entityId === end.entityId && keyFrom.column === end.column) row.setAttribute("aria-current", "true");
  else row.removeAttribute("aria-current");
}

// Roving tabindex: one row per card is the tab stop (the one last focused, else the first); Tab then reaches the next card.
function ensureRove(entityId) {
  const rows = [...(entities.get(entityId)?.el.querySelectorAll(".col-row") ?? [])];
  if (rows.length && !rows.some((r) => r.tabIndex === 0)) rows[0].tabIndex = 0;
}
function rove(row) {
  for (const r of row.closest(".entity").querySelectorAll(".col-row")) r.tabIndex = r === row ? 0 : -1;
}

function updateKeyHint(focusRow) {
  const source = sourceEnd();
  for (const el of canvas.querySelectorAll(".col-row--key-source")) { el.classList.remove("col-row--key-source"); refreshRow(el); }
  markSuggestions(source);
  if (!source) { keyHint.textContent = ""; return; }
  const srcRow = rowOf(source);
  if (srcRow) { srcRow.classList.add("col-row--key-source"); refreshRow(srcRow); }
  const target = rowEnd(focusRow);
  const decision = target ? dropDecision({ relationships: relationships.values(), from: source, to: target }) : null;
  keyHint.textContent = linkHint(source, target, decision);
}

function cancelKeyPick() {
  if (!keyFrom) return;
  keyFrom = null;
  updateKeyHint(null);
}

function focusCard(row, dir) {
  const cards = [...entities.values()].filter((e) => !e.source).sort((p, q) => p.el.offsetLeft - q.el.offsetLeft || p.el.offsetTop - q.el.offsetTop);
  const at = cards.findIndex((c) => c.el === row.closest(".entity"));
  const next = cards[cardIndex(at, cards.length, dir)];
  const rows = [...(next?.el.querySelectorAll(".col-row") ?? [])];
  (rows.find((r) => r.tabIndex === 0) ?? rows[0])?.focus();
}

function initColumnKeys() {
  canvas.addEventListener("keydown", (e) => {
    const row = e.target instanceof Element && e.target.classList.contains("col-row") ? e.target : null;
    if (!row || e.altKey || e.ctrlKey || e.metaKey) return;
    const action = linkKeyAction(e.key, Boolean(keyFrom));
    if (!action || action === "cancel") return; // Esc is handled for the whole document
    const here = rowEnd(row);
    if (!here) return;
    e.preventDefault();
    if (action === "pick") { keyFrom = { entityId: here.entityId, column: here.column }; updateKeyHint(row); }
    else if (action === "target") {
      const source = sourceEnd();
      const same = source && source.entityId === here.entityId && source.column === here.column;
      cancelKeyPick();
      if (!same) proposeLink(source, here, here); // Enter on the source again un-picks it
    } else if (action === "nextCard" || action === "prevCard") focusCard(row, action === "nextCard" ? 1 : -1);
    else {
      const rows = [...row.closest(".entity").querySelectorAll(".col-row")];
      const at = rows.indexOf(row);
      const to = action === "first" ? 0 : action === "last" ? rows.length - 1 : stepIndex(at, rows.length, action === "next" ? 1 : -1);
      rows[to]?.focus();
    }
  });
  canvas.addEventListener("focusin", (e) => {
    if (!(e.target instanceof Element) || !e.target.classList.contains("col-row")) return;
    rove(e.target);
    if (keyFrom) updateKeyHint(e.target);
  });
  canvas.addEventListener("focusout", (e) => { // focus left the column rows: the pick is dropped
    if (!keyFrom || refocusing) return;
    if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest(".col-row"))) cancelKeyPick();
  });
}

/** A refused link: a type mismatch gets a modal (both columns, their types, columns that would fit); anything else a toast. */
function refuse(problem, kind, a, b) {
  if (kind !== "type") { if (problem) toast(problem, "danger"); return; }
  const used = [...relationships.values()].flatMap(relEnds).filter((e) => e.entityId === b.entityId).map((e) => e.column);
  const names = matchingColumns(entities.get(b.entityId)?.columns ?? [], a.category, used);
  const joinable = keysCompatible(a.category, a.category); // a compound / other column has no kind to match
  openTypeWarning({ from: a, to: b, suggestions: joinable ? { table: b.table, kind: kindLabel(a.category), names } : null });
}

/** What the dialog needs for a compound key: the "Also match on" section's inputs and the "Check this join" request (which reads the pairs as they stand). */
function keyPairsFor(from, to, pairs, rel) {
  const a = entities.get(from.entityId), b = entities.get(to.entityId);
  if (!a || !b) return null;
  const others = [...relationships.values()].filter((r) => r !== rel).flatMap(relEnds);
  const usedOn = (e) => others.filter((x) => x.entityId === e.id).map((x) => x.column);
  let current = pairs.map((p) => ({ ...p }));
  return {
    section: { fromTable: a.table, toTable: b.table, fromCols: a.columns ?? [], toCols: b.columns ?? [], first: { from: from.column, to: to.column },
      pairs: current, used: { from: usedOn(a), to: usedOn(b) }, onChange: (next) => { current = next; } },
    pairs: () => current,
    check: {
      run: (signal) => api.joinPreview(previewRequest(a, from.column, b, to.column, current), { signal }),
      names: () => ({ fromTable: a.table, toTable: b.table, fromColumn: compoundName(from.column, current, "from"), toColumn: compoundName(to.column, current, "to"), declared: rel?.cardinality }),
    },
  };
}

// --- relationship lifecycle ---------------------------------------------------
function createRelationship(from, to, cardinality, { joinType, joinFixed, pairs } = { joinType: "inner", joinFixed: true }) {
  const id = `rel#${++seq}`;
  relationships.set(id, { id, from, to, cardinality, joinType, joinFixed, ...(pairs?.length ? { pairs } : {}) });
  emit("rel:changed", { id });
  select(id);
  render();
}

/** Recreate a saved relationship (workbook open). Drawn once both endpoints' key rows exist. */
export function restoreRelationship(from, to, cardinality, joinType = "inner", joinFixed = false, pairs = []) {
  const id = `rel#${++seq}`;
  relationships.set(id, { id, from, to, cardinality, joinType, joinFixed, ...(pairs.length ? { pairs } : {}) });
  emit("rel:changed", { id });
  render();
}

function onEntityRemoved(entityId) {
  for (const rel of relationships.values()) {
    if (rel.from.entityId === entityId || rel.to.entityId === entityId) relationships.delete(rel.id);
  }
  render();
}

// --- SVG rendering ------------------------------------------------------------
function render() {
  if (!svg) return;
  syncKeyStrips(); // pin key rows first: it moves rows and changes card heights, so anchors measured before it would point at the old positions
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
  markUnlinked();
  updateGuide();
  renderNotes();
  markLinkedRows();
}

// The description card: one entry per relationship — tables and key columns, what the cardinality means, which rows the join keeps.
// Hovering an entry lights its link and key rows like hovering the link does; the selected link's entry is marked.
function renderNotes() {
  if (!notes) return;
  const rels = [...relationships.values()].filter((r) => entities.get(r.from.entityId) && entities.get(r.to.entityId));
  notes.hidden = !isModelActive() || rels.length === 0;
  const summary = document.createElement("summary");
  summary.textContent = `Relationships (${rels.length})`;
  const list = document.createElement("ul");
  list.className = "rel-notes__list";
  for (const rel of rels) {
    const d = describeRelationship(rel, entities.get(rel.from.entityId).table, entities.get(rel.to.entityId).table);
    const li = document.createElement("li");
    li.className = "rel-note";
    li.dataset.rel = rel.id;
    const title = document.createElement("p"), keys = document.createElement("p");
    title.className = "rel-note__title"; title.textContent = `${d.title} · ${joinBadge(rel.cardinality, rel.joinType, rel.pairs?.length ?? 0)}`;
    keys.className = "rel-note__keys"; keys.textContent = d.keys;
    li.append(title, keys, ...d.sentences.map((t) => { const p = document.createElement("p"); p.className = "rel-note__text"; p.textContent = t; return p; }));
    li.addEventListener("pointerenter", () => { hoverId = rel.id; markLinkedRows(); });
    li.addEventListener("pointerleave", () => { hoverId = null; markLinkedRows(); });
    list.append(li);
  }
  notes.replaceChildren(summary, list);
}

// A column in a relationship is pinned to its card's key strip, above the scrolling list: the link's end is then always on a visible row.
// Rows keep their place in the list order (data-index) when they leave the strip.
function syncKeyStrips() {
  const linked = new Set();
  for (const r of relationships.values()) for (const end of relEnds(r)) linked.add(`${end.entityId}\u0000${end.column}`);
  const active = document.activeElement instanceof Element && document.activeElement.classList.contains("col-row") ? document.activeElement : null;
  for (const entity of entities.values()) {
    const strip = entity.el.querySelector(".entity__keys"), list = entity.el.querySelector(".entity__cols");
    if (!strip || !list) continue;
    for (const row of [...entity.el.querySelectorAll(".col-row")]) {
      const pinned = linked.has(`${entity.id}\u0000${row.dataset.column}`);
      row.classList.toggle("col-row--key", pinned); // a joined column reads as one (accent name)
      if (pinned && row.parentElement !== strip) strip.append(row);
      else if (!pinned && row.parentElement === strip) {
        const next = [...list.children].find((r) => Number(r.dataset.index) > Number(row.dataset.index));
        list.insertBefore(row, next ?? null);
      }
    }
    entity.el.classList.toggle("entity--has-keys", strip.children.length > 0);
    orderStrip(entity, strip);
  }
  if (active?.isConnected && document.activeElement !== active) { refocusing = true; active.focus(); refocusing = false; } // moving a row blurs it
}

// Pinned rows follow their partner, not the column order: sorted by the partner card's position, then by relationship, so the links
// between two cards run in parallel instead of crossing (a card with partners above and below lists the upper partner's keys first).
function orderStrip(entity, strip) {
  if (strip.children.length < 2) return;
  const info = new Map(); // column -> { partnerTop, seq }
  let seq = 0;
  for (const r of relationships.values()) {
    seq++;
    const extra = (r.pairs ?? []).flatMap((p) => [[{ entityId: r.from.entityId, column: p.from }, r.to], [{ entityId: r.to.entityId, column: p.to }, r.from]]);
    for (const [mine, theirs] of [[r.from, r.to], [r.to, r.from], ...extra])
      if (mine.entityId === entity.id) info.set(mine.column, { partnerTop: entities.get(theirs.entityId)?.el.offsetTop ?? 0, seq });
  }
  const rows = [...strip.children];
  const want = pinOrder(rows.map((row) => ({ column: row.dataset.column, ...(info.get(row.dataset.column) ?? { partnerTop: 0, seq: 0 }) })));
  if (want.every((c, i) => c === rows[i].dataset.column)) return; // already in order: leave the DOM alone
  for (const c of want) strip.append(rows.find((row) => row.dataset.column === c));
}

// The one-line how-to: shown on the Data Source while some table card has no relationship, gone once every card has one.
function updateGuide() {
  if (!guide) return;
  guide.hidden = !isModelActive() || ![...entities.values()].some((e) => e.el.classList.contains("entity--unlinked"));
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
  const text = joinBadge(rel.cardinality, rel.joinType, rel.pairs?.length ?? 0), w = badgeWidth(text);
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
  for (const li of notes?.querySelectorAll(".rel-note") ?? []) li.classList.toggle("rel-note--active", li.dataset.rel === selectedId || li.dataset.rel === hoverId);
  for (const id of new Set([selectedId, hoverId])) {
    const rel = id && relationships.get(id);
    if (!rel) continue;
    for (const end of relEnds(rel))
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
// An outer join says so on the badge ("1:N · left", "· right", "· full") — words, not a colour.
const badgeWidth = (text) => (text.length <= 3 ? 34 : text.length > 16 ? 140 : text.length > 12 ? 112 : text.length > 10 ? 100 : 64);

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
    keys: keyPairsFor(rel.from, rel.to, rel.pairs ?? [], rel),
    onPick: (cardinality, sel, pairs) => { rel.cardinality = cardinality; Object.assign(rel, joinFromSelection(sel)); if (pairs?.length) rel.pairs = pairs; else delete rel.pairs; emit("rel:changed", { id: rel.id }); render(); },
    onDelete: () => { relationships.delete(rel.id); emit("rel:changed", { id: rel.id }); select(null); render(); },
  });
}

function select(id) {
  selectedId = id;
  render();
}

function openCardinalityDialog({ current = "1:N", joinType = "inner", tables = ["first table", "second table"], legacy = false, keys = null, onPick, onDelete }) {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog dialog--sm";

  const head = document.createElement("div");
  head.className = "dialog__head";
  head.textContent = "Relationship: join and cardinality";

  const body = document.createElement("div");
  body.className = "dialog__body";
  // How the two tables join — only matching rows, or keep every row of the first table (left),
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
  if (keys) {
    body.append(buildKeyPairs(keys.section));
    body.append(buildJoinCheck(dlg, keys.check));
  }
  const choices = document.createElement("div");
  choices.className = "card-choices";
  for (const c of CARDINALITIES) {
    const b = makeButton(c, `card-choice${c === current ? " is-active" : ""}`);
    b.addEventListener("click", () => { closeDialog(dlg); onPick(c, join, keys?.pairs() ?? []); });
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
