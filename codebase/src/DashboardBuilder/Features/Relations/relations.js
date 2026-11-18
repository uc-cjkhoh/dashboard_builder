import { entities, relationships, bus, emit, isModelActive } from "../Core/store.js";
import { relEnds, linkIssue, pinOrder, matchingColumns, keysCompatible, kindLabel, unlinkedCards, joinChoices, cardinalityChoices, joinBadge, joinSelection, joinFromSelection, isLegacyLeft, applyAggregate, aggregateChoice, guessCardinality, relationBetween, pairFor } from "./relation-rules.js";
import { toast, makeButton, openDialog, closeDialog, confirmDeleteTwice } from "../Core/ui.js";
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { previewRequest } from "./join-preview-model.js";
import { buildJoinCheck } from "./join-check.js";
import { buildKeyPairs } from "./key-pairs-ui.js";
import { compoundName, suggestTarget, proposeKey, keyText, pairText } from "./key-pairs.js";
import { linkSides, linkRoute, roundedPath, placeBadge, assignLanes, quietBadges } from "./link-route.js";
import { openTypeWarning } from "./type-warning.js";
import { COLUMN_MIME, encodeColumnDrag, parseColumnDrag, dropDecision } from "./link-drag.js";
import { describeRelationship } from "./relation-describe.js";
import { linkKeyAction, stepIndex, cardIndex, linkHint, rowLabel } from "./link-keys.js";

// Relationships: logical, typed links the user draws between a column of one entity and a column of
// another (decision D5 — ClickHouse neither creates nor validates them). Creation is drag-and-drop only:
// drag a column row onto a row of another card, pick a cardinality. Links render as an SVG overlay with shape-coded
// endpoints (readable without colour) and a cardinality badge; clicking one edits/deletes it.
const SVG_NS = "http://www.w3.org/2000/svg";

let seq = 0;
let selectedId = null;
let hoverId = null;   // the link under the pointer
let focusEntityId = null; // the card under the pointer: its links stay strong, the rest fade (markLinkedRows)
let zoom = 1;         // the canvas zoom, for quietBadges
const openNotes = new Set(); // relationship ids whose dropdown in the Relationships card is open (kept across re-renders)
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
  guide.textContent = "Drag a column onto a column in another table, or click a proposed link.";
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
  bus.addEventListener("canvas:zoomed", (e) => { zoom = e.detail?.zoom ?? zoom; render(); });
  bus.addEventListener("entity:loaded", (e) => { markDraggable(e.detail.entityId); render(); }); // a restored link waits for its key rows
  bus.addEventListener("entity:removed", (e) => { cancelKeyPick(); onEntityRemoved(e.detail.entityId); });
  bus.addEventListener("view:changed", () => { cancelKeyPick(); selectedId = null; revealId = focusId = pinnedId = null; render(); });
  canvas.addEventListener("scroll", render);
  // Hovering a card focuses its links: they stay strong (with their badges), every other link fades back.
  canvas.addEventListener("pointerover", (e) => {
    const id = e.target.closest?.("[data-entity-id]")?.dataset.entityId ?? null;
    const next = id && [...relationships.values()].some((r) => r.from.entityId === id || r.to.entityId === id) ? id : null;
    if (next !== focusEntityId) { focusEntityId = next; markLinkedRows(); }
  });
  canvas.addEventListener("pointerleave", () => { if (focusEntityId) { focusEntityId = null; markLinkedRows(); } });
  initGhostReveal();
  initColumnDrag();
  initColumnKeys();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { cancelKeyPick(); select(null); if (pinnedId) { pinnedId = null; applyGhosts(); } }
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
    if (entities.get(row.closest(".entity")?.dataset.entityId)?.source) { toast("A union or unpivot can't be related to a table yet.", "info"); return; }
    proposeLink(endOf(from.entityId, from.column), rowEnd(row));
  });
  canvas.addEventListener("dragend", () => { dragFrom = null; clearDropMarks(); });
}

/** The one path to a new relationship, for a drop and for the keyboard: check the pair, then ask for the cardinality. */
function proposeLink(a, b, focusEnd = null) {
  if (!a || !b) return;
  const { ok, problem, kind, extend } = dropDecision({ relationships: relationships.values(), from: a, to: b });
  if (!ok) { refuse(problem, kind, a, b); return; }
  if (extend) { extendRelationship(relationships.get(extend), a, b); if (focusEnd) rowOf(focusEnd)?.focus(); return; }
  const from = { entityId: a.entityId, column: a.column };
  openCardinalityDialog({
    current: guessCardinality(a.column, a.table, b.column, b.table), // orders.customer_id onto customers.id starts on N:1
    tables: [a.table, b.table],
    keys: keyPairsFor(from, { entityId: b.entityId, column: b.column }, [], null),
    onPick: (cardinality, sel, pairs, agg) => {
      createRelationship(from, { entityId: b.entityId, column: b.column }, cardinality, { ...joinFromSelection(sel), pairs, agg });
      if (focusEnd) rowOf(focusEnd)?.focus(); // the link moves both rows into the key strips; keep the keyboard where it was
    },
  });
}

/** Two more columns of tables that are already related: one more key pair on that relationship (D127). */
function extendRelationship(rel, a, b) {
  if (!rel) return;
  const pair = pairFor(rel, a, b);
  rel.pairs = [...(rel.pairs ?? []), pair];
  emit("rel:changed", { id: rel.id });
  render();
  const ta = entities.get(rel.from.entityId)?.table, tb = entities.get(rel.to.entityId)?.table;
  toast(`Added ${pairText(pair)} to ${ta} → ${tb} (${rel.pairs.length + 1} keys).`, "info");
}

// --- relate two tables at once (D127): a proposed link ---
const dismissed = new Set(); // proposed links the user closed: "a\0b"
const ghosts = new Map();    // key -> the proposed link's button pair, kept across redraws so focus stays on it

// A proposal is drawn on demand (D127): while the pointer or focus is on one of its two cards (or on the proposal), while one of them was clicked
// (pinned until a click elsewhere or Esc), or when it is the only one in a model with no relationship yet, where nothing else is there to cross.
// Resting, it fades (opacity, no pointer events), never `hidden`, so its button stays in the Tab order and the accessibility tree.
const GHOST_GRACE = 250; // ms a hovered proposal stays after the pointer leaves, so the pointer can cross the gap from the card to its pill
let revealId = null;     // the card (or proposal pair key) the pointer is over
let focusId = null;      // the card (or proposal) holding keyboard focus
let pinnedId = null;     // the card (or proposal) last clicked
let revealTimer = 0;
let autoGhosts = false;  // set by render(): the one proposal of a model with no relationship yet
let proposalCount = 0;   // set by render(): proposals that exist, shown or not (the guide's words)

/** The card id, or the proposal's pair key, that an event target belongs to. */
const revealTarget = (el) => {
  const t = el?.closest?.("[data-entity-id], .rel-ghost");
  return t ? (t.classList.contains("rel-ghost") ? t._p?.pairKey : t.dataset.entityId) ?? null : null;
};
const ghostShown = (p) => autoGhosts || [revealId, focusId, pinnedId].some((id) => id && (id === p.a || id === p.b || id === p.pairKey));

/** Fade each proposal's line and pill in or out. Called at the end of every render(), so a redrawn line never flashes. */
function applyGhosts() {
  for (const g of ghosts.values()) g.classList.toggle("rel-ghost--idle", !ghostShown(g._p));
  for (const line of svg.querySelectorAll(".rel-ghost__line")) {
    const g = ghosts.get(line.dataset.ghost);
    line.classList.toggle("rel-ghost--idle", !g || !ghostShown(g._p));
  }
}

function initGhostReveal() {
  const leave = () => { clearTimeout(revealTimer); revealTimer = setTimeout(() => { revealId = null; applyGhosts(); }, GHOST_GRACE); };
  canvas.addEventListener("pointerover", (e) => {
    const id = revealTarget(e.target);
    clearTimeout(revealTimer);
    if (!id) { if (revealId) leave(); } else if (id !== revealId) { revealId = id; applyGhosts(); }
  });
  canvas.addEventListener("pointerleave", () => { if (revealId) leave(); });
  canvas.addEventListener("pointerdown", (e) => { const id = revealTarget(e.target); if (id !== pinnedId) { pinnedId = id; applyGhosts(); } });
  canvas.addEventListener("focusin", (e) => { const id = revealTarget(e.target); if (id !== focusId) { focusId = id; applyGhosts(); } });
  canvas.addEventListener("focusout", (e) => { if (focusId && !canvas.contains(e.relatedTarget)) { focusId = null; applyGhosts(); } });
}

const tableOf =(e) => ({ table: e.table, columns: e.columns ?? [] });
const relatable = (e) => e && !e.source && Array.isArray(e.columns);
const usedOn = (id) => [...relationships.values()].flatMap(relEnds).filter((x) => x.entityId === id).map((x) => x.column);

/** The key cards `aId` and `bId` would join on, oriented a → b, or null (proposeKey in key-pairs.js). */
function keyBetween(aId, bId) {
  const a = entities.get(aId), b = entities.get(bId);
  if (!relatable(a) || !relatable(b)) return null;
  return proposeKey(tableOf(a), tableOf(b), { from: usedOn(aId), to: usedOn(bId) });
}

/** Relate two cards: their relationship's dialog if they already have one, else a new relationship's dialog filled with the key the names point to. */
function relateTables(aId, bId) {
  const a = entities.get(aId), b = entities.get(bId);
  if (!a || !b || aId === bId) return;
  if (a.source || b.source) { toast("A union or unpivot can't be related to a table yet.", "info"); return; }
  const rel = relationBetween(relationships.values(), aId, bId);
  if (rel) { editRelationship(rel); return; }
  const k = keyBetween(aId, bId);
  if (!k) { toast(`No matching columns in ${a.table} and ${b.table}. Drag a column onto a column to relate them.`, "info"); return; }
  const from = { entityId: aId, column: k.first.from }, to = { entityId: bId, column: k.first.to };
  openCardinalityDialog({
    current: guessCardinality(k.first.from, a.table, k.first.to, b.table),
    tables: [a.table, b.table],
    keys: keyPairsFor(from, to, k.pairs, null),
    onPick: (cardinality, sel, pairs, agg) => createRelationship(from, to, cardinality, { ...joinFromSelection(sel), pairs, agg }),
  });
}

/** Proposed links: for each card that needs a partner, the confident key to another card (one per table pair), drawn dashed with a
 *  "Relate on …" button and a close button. Nothing is saved until the user confirms the dialog (golden rule 5). */
function proposals() {
  const lone = new Set(unlinkedCards([...entities.values()].map((e) => ({ id: e.id, source: Boolean(e.source) })), relationships.values()));
  const out = [], seen = new Set();
  for (const id of lone) {
    let best = null;
    for (const other of entities.values()) {
      if (other.id === id || other.source) continue;
      const pairKey = [id, other.id].sort().join("\u0000");
      if (seen.has(pairKey) || dismissed.has(pairKey)) continue;
      const k = keyBetween(id, other.id);
      if (k?.confident && (!best || k.score > best.k.score)) best = { a: id, b: other.id, k, pairKey };
    }
    if (best) { seen.add(best.pairKey); out.push(best); }
  }
  return out;
}

function ghostButton(p) {
  let g = ghosts.get(p.pairKey);
  const a = entities.get(p.a), b = entities.get(p.b);
  const text = `Relate on ${keyText(p.k)}`;
  if (!g) {
    g = document.createElement("div");
    g.className = "rel-ghost";
    const go = makeButton("", "rel-ghost__go"), no = makeButton("", "rel-ghost__no");
    go.append(icon("link", { size: 14 }), document.createElement("span"));
    no.append(icon("close", { size: 14 }));
    go.addEventListener("click", () => relateTables(g._p.a, g._p.b));
    no.addEventListener("click", () => { dismissed.add(g._p.pairKey); render(); });
    g.append(go, no);
    ghosts.set(p.pairKey, g);
  }
  g._p = p;
  const go = g.querySelector(".rel-ghost__go");
  go.querySelector("span").textContent = text;
  go.setAttribute("aria-label", `Relate ${a.table} and ${b.table} on ${keyText(p.k)}`);
  g.querySelector(".rel-ghost__no").setAttribute("aria-label", `Dismiss the suggested ${a.table} – ${b.table} relationship`);
  return g;
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
  if (kind !== "type") { if (problem) toast(problem, "info"); return; } // a refused link is a notice, not a danger (red stays for failures)
  const used = [...relationships.values()].flatMap(relEnds).filter((e) => e.entityId === b.entityId).map((e) => e.column);
  const names = matchingColumns(entities.get(b.entityId)?.columns ?? [], a.category, used);
  const joinable = keysCompatible(a.category, a.category); // a compound / other column has no kind to match
  openTypeWarning({ from: a, to: b, suggestions: joinable ? { table: b.table, kind: kindLabel(a.category), names } : null });
}

/** What the dialog needs for a compound key: the "Also match on" section's inputs and the suggestion's request (which reads the pairs as they stand). */
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
      run: (signal) => api.joinPreview(previewRequest(a, from.column, b, to.column, current), { signal }), // a card with custom SQL sends its query (previewRequest)
      names: () => ({ fromTable: a.table, toTable: b.table, fromColumn: compoundName(from.column, current, "from"), toColumn: compoundName(to.column, current, "to"), declared: rel?.cardinality }),
    },
  };
}

// --- relationship lifecycle ---------------------------------------------------
function createRelationship(from, to, cardinality, { joinType, joinFixed, pairs, agg } = { joinType: "inner", joinFixed: true }) {
  const id = `rel#${++seq}`;
  relationships.set(id, applyAggregate({ id, from, to, cardinality, joinType, joinFixed, ...(pairs?.length ? { pairs } : {}) }, agg ?? {}));
  emit("rel:changed", { id });
  select(id);
  render();
}

/** Recreate a saved relationship (workbook open). Drawn once both endpoints' key rows exist. */
export function restoreRelationship(from, to, cardinality, joinType = "inner", joinFixed = false, pairs = [], agg = {}) {
  const id = `rel#${++seq}`;
  relationships.set(id, applyAggregate({ id, from, to, cardinality, joinType, joinFixed, ...(pairs.length ? { pairs } : {}) }, agg));
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
  markUnlinked(); // before measuring too: showing / hiding "Needs a partner" refits the card's width (canvas.js)
  svg.replaceChildren();
  labels.replaceChildren();
  const crect = canvas.getBoundingClientRect();
  for (const layer of [svg, labels]) { layer.setAttribute("width", "0"); layer.setAttribute("height", "0"); } // measure the cards alone, so zooming out lets the scroll area shrink
  const [w, h] = [canvas.scrollWidth, canvas.scrollHeight];
  for (const layer of [svg, labels]) {
    layer.setAttribute("width", String(w));
    layer.setAttribute("height", String(h));
  }

  const placed = []; // badge boxes already laid out; a badge never covers one
  const cards = [...entities.values()].map((e) => { const r = e.el.getBoundingClientRect(); return { left: r.left - crect.left + canvas.scrollLeft, right: r.right - crect.left + canvas.scrollLeft, top: r.top - crect.top + canvas.scrollTop, bottom: r.bottom - crect.top + canvas.scrollTop }; });
  // Measure every link first, then give links that share a gutter separate lanes wherever their vertical runs overlap (assignLanes).
  const links = [];
  for (const rel of relationships.values()) {
    const a = entities.get(rel.from.entityId);
    const b = entities.get(rel.to.entityId);
    if (!a || !b) continue;

    const [sa, sb] = linkSides(cardSpan(a, crect), cardSpan(b, crect));
    const p1 = anchor(a, rel.from.column, sa, crect);
    const p2 = anchor(b, rel.to.column, sb, crect);
    if (!p1 || !p2) continue;
    const group = Math.round(sa === sb ? (sa > 0 ? Math.max(p1.x, p2.x) : Math.min(p1.x, p2.x)) : Math.min(p1.x, p2.x));
    // where each horizontal run comes from (the left card, the right card, or both ends from one side on a loop), so lanes can be ordered not to cross
    const [l, r] = p1.x <= p2.x ? [p1, p2] : [p2, p1];
    const ends = sa !== sb ? { left: [l.y], right: [r.y], room: r.x - l.x - 30 } : sa > 0 ? { left: [p1.y, p2.y], right: [] } : { left: [], right: [p1.y, p2.y] };
    links.push({ rel, sa, sb, p1, p2, group, lo: Math.min(p1.y, p2.y), hi: Math.max(p1.y, p2.y), ...ends });
  }
  const props = proposals();
  autoGhosts = relationships.size === 0 && props.length === 1;
  proposalCount = props.length;
  for (const p of props) { // a proposed link takes a lane like a real one, so it never runs along one (it can still cross one: shown on demand, D127)
    const a = entities.get(p.a), b = entities.get(p.b);
    const [sa, sb] = linkSides(cardSpan(a, crect), cardSpan(b, crect));
    const p1 = anchor(a, p.k.first.from, sa, crect), p2 = anchor(b, p.k.first.to, sb, crect);
    const group = Math.round(sa === sb ? (sa > 0 ? Math.max(p1.x, p2.x) : Math.min(p1.x, p2.x)) : Math.min(p1.x, p2.x));
    const [l, r] = p1.x <= p2.x ? [p1, p2] : [p2, p1];
    const ends = sa !== sb ? { left: [l.y], right: [r.y], room: r.x - l.x - 30 } : sa > 0 ? { left: [p1.y, p2.y], right: [] } : { left: [], right: [p1.y, p2.y] };
    links.push({ ghost: p, sa, sb, p1, p2, group, lo: Math.min(p1.y, p2.y), hi: Math.max(p1.y, p2.y), ...ends });
  }
  const lanes = assignLanes(links);
  const keep = new Set();
  links.forEach(({ rel, ghost, sa, sb, p1, p2 }, i) => {
    if (ghost) { keep.add(ghost.pairKey); drawGhost(ghost, p1, sa, p2, sb, lanes[i], placed, cards); return; }
    const [fromKind, toKind] = markerKinds(rel.cardinality);
    const { line, label, under } = drawLink(rel, p1, sa, p2, sb, fromKind, toKind, lanes[i], placed, cards);
    svg.append(line);
    (under ? svg : labels).append(label); // a badge with no free spot beside the cards sits under them, never over
  });
  for (const [k, g] of ghosts) if (!keep.has(k)) { g.remove(); ghosts.delete(k); }
  applyGhosts();
  canvas.classList.toggle("rel-quiet", quietBadges(links.length - props.length, zoom)); // many links: badges only on the hovered / focused ones
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
    const more = document.createElement("details"); // a dropdown per link: the title row stays one line, the words open beneath it
    more.className = "rel-note__more";
    more.open = openNotes.has(rel.id);
    more.addEventListener("toggle", () => { if (more.open) openNotes.add(rel.id); else openNotes.delete(rel.id); });
    const head = document.createElement("summary"), title = document.createElement("span");
    head.className = "rel-note__head";
    title.className = "rel-note__title"; title.textContent = d.title; // tables only: "How rows match" below says the kind in words
    title.title = d.title; // the row ellipsises at the card's fixed width: the whole link is its tooltip
    head.append(title);
    more.append(head, ...d.sentences.map((t, i) => notePart(d.heads[i], noteLine(t, d.refs, d.tones[i]))));
    li.append(more);
    li.addEventListener("pointerenter", () => { hoverId = rel.id; markLinkedRows(); });
    li.addEventListener("pointerleave", () => { hoverId = null; markLinkedRows(); });
    list.append(li);
  }
  notes.replaceChildren(summary, list);
}

// A paragraph of a note under its short title (the purpose of the paragraph); the title is text in the same ink as the card title, so it never relies on colour.
function notePart(heading, line) {
  const part = document.createElement("div"), label = document.createElement("div");
  part.className = "rel-note__part";
  label.className = "rel-note__label"; label.textContent = heading;
  part.append(label, line);
  return part;
}

// One sentence of a note: table and column names are set in a chip (bold + wash, so not colour alone); a caution or reassurance gets a tone.
function noteLine(text, refs, tone) {
  const p = document.createElement("p");
  p.className = tone ? `rel-note__text rel-note__text--${tone}` : "rel-note__text";
  const esc = (r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w.])(${refs.map(esc).join("|")})(?![\\w])`, "g");
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) p.append(text.slice(at, m.index));
    const b = document.createElement("strong");
    b.className = "rel-ref"; b.textContent = m[0];
    p.append(b);
    at = m.index + m[0].length;
  }
  if (at < text.length) p.append(text.slice(at));
  return p;
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
  // the words follow what is on screen: a proposal in view can be clicked; one waiting for the pointer is pointed at; none leaves the drag
  guide.textContent = autoGhosts ? "Drag a column onto a column in another table, or click a proposed link."
    : proposalCount ? "Drag a column onto a column in another table, or point at a card that needs a partner to see its proposed link."
    : "Drag a column onto a column in another table.";
}

// Every table card belongs to a relationship; one that doesn't says so (text + dashed outline, never colour alone).
function markUnlinked() {
  const lone = new Set(unlinkedCards([...entities.values()].map((e) => ({ id: e.id, source: Boolean(e.source) })), relationships.values()));
  for (const entity of entities.values()) {
    const flag = lone.has(entity.id);
    entity.el.classList.toggle("entity--unlinked", flag);
    const need = entity.el.querySelector(".entity__need");
    if (need && need.hidden === flag) { need.hidden = !flag; emit("entity:need", { entityId: entity.id }); }
  }
}

// A proposed link: a dashed line and, on its middle run, the "Relate on …" button with a close button (HTML over the cards, keyboard-reachable).
function drawGhost(p, p1, s1, p2, s2, lane, placed, cards) {
  const { points, label: spot } = linkRoute(p1, s1, p2, s2, lane);
  svg.append(svgEl("path", { class: "rel-ghost__line", d: roundedPath(points), "data-ghost": p.pairKey }));
  const g = ghostButton(p);
  if (!g.isConnected) canvas.append(g);
  const w = g.offsetWidth, h = g.offsetHeight;
  let at = placeBadge(spot, p1.y, p2.y, w, h, cards, placed);
  if (at.under) { // no room beside the cards (the pill is wider than most gutters): it sits 16px under the lower of the two, centred on the gap
    const ra = entities.get(p.a).el.getBoundingClientRect(), rb = entities.get(p.b).el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const bottom = Math.max(ra.bottom, rb.bottom) - c.top + canvas.scrollTop;
    at = { x: spot.x, y: bottom + 16 + h / 2 };
    while (placed.some((q) => Math.abs(q.x - at.x) < (q.w + w) / 2 && Math.abs(q.y - at.y) < (q.h + h) / 2)) at = { x: at.x, y: at.y + h + 8 };
  }
  placed.push({ x: at.x, y: at.y, w, h });
  g.style.left = `${at.x - w / 2}px`;
  g.style.top = `${at.y - h / 2}px`;
}

function drawLink(rel, p1, s1, p2, s2, fromKind, toKind, lane, placed, cards) {
  const cls = "rel-link";
  const line = svgEl("g", { class: cls, "data-rel": rel.id });
  const { points, label: spot } = linkRoute(p1, s1, p2, s2, lane);
  const d = roundedPath(points);
  line.append(svgEl("path", { class: "rel-link__hit", d }), svgEl("path", { class: "rel-link__line", d }),
    endMarker(p1, { x: s1, y: 0 }, fromKind), endMarker(p2, { x: s2, y: 0 }, toKind));
  const label = svgEl("g", { class: `${cls} rel-link--label`, "data-rel": rel.id });
  const text = joinBadge(rel.cardinality, rel.joinType, rel.pairs?.length ?? 0), w = badgeWidth(text);
  const at = placeBadge(spot, p1.y, p2.y, w, BADGE_H, cards, placed);
  placed.push({ x: at.x, y: at.y, w, h: BADGE_H });
  label.append(badge(text, w, at));

  for (const g of [line, label]) { // the line and its badge sit in two layers but act as one link
    g.addEventListener("click", (e) => { e.stopPropagation(); editRelationship(rel); });
    g.addEventListener("pointerenter", () => { hoverId = rel.id; markLinkedRows(); });
    g.addEventListener("pointerleave", () => { hoverId = null; markLinkedRows(); });
  }
  return { line, label, under: at.under };
}

// The two key rows a hovered or selected link joins read as one pair: both take the accent wash.
function markLinkedRows() {
  for (const el of canvas.querySelectorAll(".col-row--linked, .rel-link--hover")) el.classList.remove("col-row--linked", "rel-link--hover");
  if (hoverId) for (const el of canvas.querySelectorAll(`.rel-link[data-rel="${hoverId}"]`)) el.classList.add("rel-link--hover");
  // Focus: a hovered link, or every link of a hovered card, stays strong; the others fade (.rel-focus in relations.css).
  const focused = (r) => r.id === hoverId || (focusEntityId && (r.from.entityId === focusEntityId || r.to.entityId === focusEntityId));
  canvas.classList.toggle("rel-focus", !!(hoverId || focusEntityId));
  for (const el of canvas.querySelectorAll(".rel-link[data-rel]")) el.classList.toggle("rel-link--focus", !!focused(relationships.get(el.dataset.rel) ?? {}));
  for (const li of notes?.querySelectorAll(".rel-note") ?? []) li.classList.toggle("rel-note--active", li.dataset.rel === hoverId);
  const rel = hoverId && relationships.get(hoverId); // hover only: selecting a link (which opens its dialog) highlights nothing
  if (rel)
    for (const end of relEnds(rel))
      entities.get(end.entityId)?.el.querySelector(`.col-row[data-column="${cssEscape(end.column)}"]`)?.classList.add("col-row--linked");
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
    agg: aggregateChoice(rel),
    onPick: (cardinality, sel, pairs, agg) => { rel.cardinality = cardinality; Object.assign(rel, joinFromSelection(sel)); applyAggregate(rel, agg); if (pairs?.length) rel.pairs = pairs; else delete rel.pairs; emit("rel:changed", { id: rel.id }); render(); },
    onDelete: async () => {
      const ta = entities.get(rel.from.entityId)?.table, tb = entities.get(rel.to.entityId)?.table;
      if (!(await confirmDeleteTwice(`Remove the ${ta} → ${tb} relationship?`, `the ${ta} → ${tb} relationship`, { confirmText: "Remove" }))) return;
      relationships.delete(rel.id); emit("rel:changed", { id: rel.id }); select(null); render();
      toast(`Removed the ${ta} → ${tb} relationship.`, "info");
    },
  });
}

function select(id) {
  selectedId = id;
  hoverId = null; // render() replaces the hovered link, so its pointerleave never fires: clear the hover here
  render();
}

// One section of the left panel; `i` staggers the entrance.
function section(kind, i, ...children) {
  const c = document.createElement("div");
  c.className = `rel-sec rel-sec--${kind}`;
  c.style.setProperty("--i", i);
  c.append(...children);
  return c;
}

function openCardinalityDialog({ current = "1:N", joinType = "inner", tables = ["first table", "second table"], legacy = false, keys = null, agg = { aggregate: false, direction: "both" }, onPick, onDelete }) {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog dialog--sm dialog--rel";

  // Same head as the column profile: title and the two tables, with a close button.
  dlg.setAttribute("aria-labelledby", "rel-dialog-title");
  const head = document.createElement("div");
  head.className = "rel-dialog__head";
  const titles = document.createElement("div");
  titles.className = "rel-dialog__titles";
  const title = document.createElement("h2");
  title.className = "dialog__title rel-dialog__title";
  title.id = "rel-dialog-title";
  title.textContent = "Relationship";
  const sub = document.createElement("p");
  sub.className = "rel-dialog__sub";
  sub.textContent = `${tables[0]} → ${tables[1]}`;
  sub.title = sub.textContent;
  titles.append(title, sub);
  const x = makeButton("", "iconbtn");
  x.append(icon("close"));
  x.setAttribute("aria-label", "Close");
  x.addEventListener("click", () => closeDialog(dlg));
  head.append(titles, x);

  // Landscape: settings and the cardinality buttons on the left, the data's suggestion (with its evidence) on the right.
  const body = document.createElement("div");
  body.className = "rel-dialog";
  const left = document.createElement("div");
  left.className = "rel-dialog__left";
  const right = document.createElement("div");
  right.className = "rel-dialog__right";
  // Left, top to bottom: Join, Cardinality, Totals, Also match on. Join and Cardinality are the same control: one choice of four as
  // radio cards in a 2 x 2. Picking only selects; Confirm saves. The link runs first → second.
  let join = joinType;
  left.append(section("join", 0, radioCards("Join", "join-type", joinChoices(legacy), join, (v) => { join = v; }).root));
  let cardinality = current;
  let check = null;
  const card = radioCards("Cardinality", "cardinality", cardinalityChoices(), cardinality, (v) => { cardinality = v; check?.redescribe(); });
  left.append(section("card", 1, card.root));
  let aggregate = agg.aggregate, direction = agg.direction;
  left.append(section("totals", 2, buildAggregateChoice(agg, (v) => { aggregate = v.aggregate; direction = v.direction; })));
  // The suggestion runs as the dialog opens (start() below), re-runs when the key pairs change, and re-reads its result against
  // each cardinality pick; "Use N:1" only selects (Confirm still saves).
  if (keys) {
    check = buildJoinCheck(dlg, { ...keys.check, apply: { get: () => cardinality, set: (c) => card.inputs.find((r) => r.value === c)?.click() } });
    left.append(section("pairs", 3, buildKeyPairs({ ...keys.section, onChange: (next) => { keys.section.onChange(next); check.rerun(); } })));
    right.append(check.root);
  }
  body.append(left);
  if (keys) body.append(right);
  else body.classList.add("rel-dialog--single");

  const foot = document.createElement("div");
  foot.className = "dialog__foot rel-dialog__foot";
  if (onDelete) {
    const del = makeButton("Delete", "btn btn--danger");
    del.addEventListener("click", () => { closeDialog(dlg); onDelete(); });
    foot.append(del);
  }
  const cancel = makeButton("Cancel", "btn");
  cancel.addEventListener("click", () => closeDialog(dlg));
  const confirm = makeButton("Confirm", "btn btn--primary");
  confirm.addEventListener("click", () => { closeDialog(dlg); onPick(cardinality, join, keys?.pairs() ?? [], { aggregate, direction }); });
  foot.append(cancel, confirm);

  dlg.append(head, body, foot);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDialog(dlg); });
  document.body.append(dlg);
  openDialog(dlg);
  check?.start();
}

// One choice of several as radio cards in a 2 x 2 grid (a toggle would read as "pick several"): a bold name.
// The radio and the text sit vertically centred in the card.
// The chosen card takes the accent border, a tint and a filled dot, so it never relies on colour alone. Reports each pick.
function radioCards(title, name, choices, value, onPick) {
  const root = document.createElement("fieldset");
  root.className = "join-choice";
  const legend = document.createElement("legend");
  legend.textContent = title;
  const grid = document.createElement("div");
  grid.className = "choice-cards";
  const inputs = [];
  for (const { value: v, text } of choices) {
    const lab = document.createElement("label");
    lab.className = "choice-card";
    const r = document.createElement("input");
    r.type = "radio"; r.name = name; r.value = v; r.checked = v === value;
    r.addEventListener("change", () => { if (r.checked) onPick(v); });
    const words = document.createElement("span");
    words.className = "choice-card__text";
    const n = document.createElement("span");
    n.className = "choice-card__name";
    n.textContent = text;
    words.append(n);
    lab.append(r, words);
    inputs.push(r);
    grid.append(lab);
  }
  root.append(legend, grid);
  return { root, inputs };
}

// "Total each table by the key before joining" + which way a filter works (only shown once the box is ticked). Reports every change.
function buildAggregateChoice(start, onChange) {
  const box = document.createElement("fieldset");
  box.className = "join-choice join-aggregate";
  const legend = document.createElement("legend");
  legend.textContent = "Totals";
  const state = { ...start };
  const lab = document.createElement("label");
  lab.className = "form-check";
  const check = document.createElement("input");
  check.type = "checkbox"; check.checked = state.aggregate;
  lab.append(check, document.createTextNode(" Total each table by the key before joining, so a total isn't repeated"));
  const dir = document.createElement("fieldset");
  dir.className = "join-choice join-aggregate__dir";
  dir.hidden = !state.aggregate;
  const dl = document.createElement("legend");
  dl.textContent = "Filters";
  dir.append(dl);
  for (const [value, text] of [["both", "A filter on either table also limits the other"], ["single", "A filter changes only its own table"]]) {
    const l = document.createElement("label");
    l.className = "form-check";
    const r = document.createElement("input");
    r.type = "radio"; r.name = "filter-direction"; r.value = value; r.checked = state.direction === value;
    r.addEventListener("change", () => { if (r.checked) { state.direction = value; onChange(state); } });
    l.append(r, document.createTextNode(` ${text}`));
    dir.append(l);
  }
  check.addEventListener("change", () => { state.aggregate = check.checked; dir.hidden = !check.checked; onChange(state); });
  box.append(legend, lab, dir);
  return box;
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
