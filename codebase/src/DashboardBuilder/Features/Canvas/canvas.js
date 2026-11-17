import { emptyState } from "./empty-state.js";
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { show, hide, toggle, confirmDialog, toast } from "../Core/ui.js";
import { entities, relationshipsFor, emit, bus, isModelActive, showModel } from "../Core/store.js";
import { expandSidebar } from "../Shell/sidebar.js";
import { openColumnProfile } from "../Schema/column-profile-dialog.js";
import { cardType } from "./column-type.js";
import { entityWidth } from "./card-width.js";
import { snapTop } from "./align-snap.js";
import { dragListHeight, cleanListHeight } from "./card-height.js";
import { clampZoom, wheelZoom, panForZoom, panToReveal, toModel } from "./canvas-zoom.js";
import { unionDiffControl } from "./union-diff.js";
import { sourceNote, lossyNote, wireSource, MAX_SOURCE_COLUMNS, SQL_NOTE, defaultSql, sqlWire, lostKeys } from "../Core/source-model.js";
import { relEnds, keyKindBreaks } from "../Relations/relation-rules.js";
import { openSqlDialog } from "./sql-dialog.js";
import { initDataPreview, showPreview, togglePreview, previewedId } from "./data-preview.js";

// Data Source canvas + entity cards. A table dropped from the sidebar (or added via the
// `table:add` fallback) becomes an entity card: a db.table head over a scrollable list of column
// rows (name + type), 240px tall unless an edge drag resized it. Cards are moved
// by dragging the head and removed via the head's trash icon. No row preview here — data lives in
// dashboard widgets. Entities are the shared model (store.js).
const TABLE_MIME = "application/x-ch-table";

// Set by initCanvas — the entry points the Workbook feature uses to rebuild the model.
let createEntityImpl = null;
let clearModelImpl = null;

/** Add a table to the Data Source at (x, y). `source` makes it a union / unpivot entity (Core/source-model.js; its `table` is the source's name; it takes no relationship).
 *  `customSql` is a saved SELECT the card reads instead of the table (D105; the card stays an ordinary, relatable table card); `customSqlMysql` the MySQL text it was written as (D106).
 *  Returns the new entity id, or null before the canvas is initialised. */
export function addEntity(db, table, x, y, opts) { return createEntityImpl?.(db, table, x, y, opts) ?? null; }

/** Remove every entity (and so every relationship) without asking — used when opening a workbook. */
export function clearModel() { clearModelImpl?.(); }

export function initCanvas() {
  const canvas = document.getElementById("model-view");
  const empty = document.getElementById("canvas-empty");
  if (!canvas) return;

  let seq = 0; // entities/relationships live in the shared store (store.js)
  let zoom = 1; // view zoom (wheel on an empty spot)
  const pan = { x: 0, y: 0 }; // where the model origin sits in the view, px: dragging an empty spot moves it, with no limit (an open ground, not a scroll area)

  // A card keeps its model x / y and size (offsetWidth is unscaled); the view draws it at model x zoom + pan, scaled from its top-left corner.
  const place = (entity) => {
    entity.el.style.left = `${entity.x * zoom + pan.x}px`;
    entity.el.style.top = `${entity.y * zoom + pan.y}px`;
    entity.el.style.scale = zoom === 1 ? "" : String(zoom);  // the `scale` property, so the card's entrance animation (a transform) never fights it
  };
  // Apply zoom / pan to every card and the dot grid, then let the links re-measure.
  const refreshView = () => {
    canvas.style.setProperty("--zoom", String(zoom));
    canvas.style.setProperty("--pan-x", `${pan.x}px`);
    canvas.style.setProperty("--pan-y", `${pan.y}px`);
    for (const entity of entities.values()) place(entity);
    emit("canvas:zoomed", { zoom });
  };
  const setZoom = (next, cursor) => {
    next = clampZoom(next);
    if (next === zoom) return;
    Object.assign(pan, panForZoom(pan, cursor, zoom, next));
    zoom = next;
    refreshView();
  };
  // The browser may scroll the (overflow-hidden) view to reveal a focused row; the ground is not a scroll area, so that scroll becomes pan.
  canvas.addEventListener("scroll", () => {
    if (!canvas.scrollLeft && !canvas.scrollTop) return;
    pan.x -= canvas.scrollLeft; pan.y -= canvas.scrollTop;
    canvas.scrollLeft = 0; canvas.scrollTop = 0;
    refreshView();
  });
  const reveal = (entity) => {
    const r = entity.el.getBoundingClientRect(), v = canvas.getBoundingClientRect();
    const next = panToReveal(pan, { left: r.left - v.left, top: r.top - v.top, right: r.right - v.left, bottom: r.bottom - v.top }, v.width, v.height);
    if (next.x === pan.x && next.y === pan.y) return;
    Object.assign(pan, next);
    refreshView();
  };
  const onEmptySpot = (event) => event.target === canvas;

  // Wheel on an empty spot zooms about the pointer; over a card or link the wheel still scrolls the card's own list / the view.
  canvas.addEventListener("wheel", (event) => {
    if (!onEmptySpot(event) || event.ctrlKey) return;
    event.preventDefault();
    const r = canvas.getBoundingClientRect();
    setZoom(wheelZoom(zoom, event.deltaY, event.deltaMode), { x: event.clientX - r.left, y: event.clientY - r.top });
  }, { passive: false });

  // Dragging an empty spot pans the whole ground, as far as the user likes.
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !onEmptySpot(event)) return;
    const startX = event.clientX, startY = event.clientY, originX = pan.x, originY = pan.y;
    let moved = false;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("canvas--panning");
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return; // a click is not a pan
      moved = true;
      pan.x = originX + (ev.clientX - startX);
      pan.y = originY + (ev.clientY - startY);
      refreshView();
    };
    const up = () => {
      canvas.classList.remove("canvas--panning");
      canvas.releasePointerCapture(event.pointerId);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      if (moved) canvas.addEventListener("click", (e) => e.stopPropagation(), { capture: true, once: true }); // the pan's own release is not a click on the ground
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  });

  const emptyTitle = document.getElementById("canvas-empty-title");
  const emptyAction = document.getElementById("canvas-empty-action");
  let connected = false;

  const dbSelect = document.getElementById("db-select");
  const currentEmpty = () => emptyState({ connected, databaseSelected: Boolean(dbSelect?.value) });

  // One sentence + one button, by state. The buttons focus controls that are visible in that state.
  // While the connect form is open (Connection/connection.js), the start card shows even over cards — `data-over` adds a scrim.
  const connForm = document.getElementById("conn-form");
  const refreshEmpty = () => {
    const formOpen = Boolean(connForm && !connForm.hidden);
    toggle(empty, entities.size === 0 || formOpen);
    empty?.toggleAttribute("data-over", formOpen && entities.size > 0);
    const st = currentEmpty();
    if (emptyTitle) emptyTitle.textContent = st.text;
    if (emptyAction) emptyAction.textContent = st.action;
  };
  emptyAction?.addEventListener("click", () => { expandSidebar(); document.getElementById(currentEmpty().focusId)?.focus(); });
  dbSelect?.addEventListener("change", refreshEmpty);
  document.addEventListener("connection:changed", (e) => { connected = Boolean(e.detail?.connected); refreshEmpty(); });
  document.addEventListener("connection:form", refreshEmpty);
  refreshEmpty();

  // --- drop target ---------------------------------------------------------
  canvas.addEventListener("dragover", (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes(TABLE_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    canvas.classList.add("canvas--dragover");
  });
  canvas.addEventListener("dragleave", (event) => {
    if (event.target === canvas) canvas.classList.remove("canvas--dragover");
  });
  canvas.addEventListener("drop", (event) => {
    canvas.classList.remove("canvas--dragover");
    const raw = event.dataTransfer?.getData(TABLE_MIME);
    if (!raw) return;
    event.preventDefault();
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - pan.x) / zoom - 24;
    const y = (event.clientY - rect.top - pan.y) / zoom - 12;
    addTableFromUser(payload?.db, payload?.table, Math.max(0, x), Math.max(0, y));
  });

  // A union / unpivot built in the sidebar dialogs: a new entity on the Data Source, like a table added with its + button.
  document.addEventListener("source:add", (event) => {
    const { source } = event.detail;
    showModel();
    const { x, y } = freeSlot();
    createEntity(source.db, source.name, x, y, { source });
  });

  // Non-drag fallback (accessibility): schema.js dispatches this from a chip's plus button.
  // A table always goes to the shared Data Source; switch there if a dashboard is showing.
  document.addEventListener("table:add", (event) => {
    const { db, table } = event.detail;
    showModel();
    const { x, y } = freeSlot();
    addTableFromUser(db, table, x, y);
  });

  // Show the model view only when it's the active view (dashboards render elsewhere).
  bus.addEventListener("view:changed", () => toggle(canvas, isModelActive()));
  // relations.js showed or hid a card's "Needs a partner" badge: refit that card's width so the badge never clips its name
  bus.addEventListener("entity:need", (e) => {
    const entity = entities.get(e.detail?.entityId);
    const head = entity?.el.querySelector(".entity__head");
    if (head) fitWidth(entity.el, head.querySelector(".entity__title"), head.querySelector(".entity__edit"), head.querySelector(".entity__need"), head.querySelector(".entity__relate"), head.querySelector(".entity__peek"));
  });
  toggle(canvas, isModelActive());
  initDataPreview(); // the rows of one card, docked under the ground

  createEntityImpl = createEntity;
  clearModelImpl = clearAll;

  // First grid slot (left→right, top→bottom, fitted to the visible width) that no card overlaps, so a
  // card added with the + button never hides another card's title. Dropped cards keep the drop point.
  function freeSlot() {
    // pad = the view gutter (.view --s4), so cards line up with the tab strip; gaps = room for a link's elbow and badge between cards. Across, the gap
    // is wider (step 456 = 19 dot cells): a card grows after it is placed (the Needs a partner button shows once a second card arrives), and the head's
    // buttons already take it past 312, so 96 would let it touch the next slot. Down, card width doesn't matter (step 408 = 17 cells).
    const pad = 16, gapX = 144, gapY = 96, w = 312, h = 312;
    const boxes = [...entities.values()].map((e) => ({ x: e.x, y: e.y, w: e.el.offsetWidth, h: e.el.offsetHeight }));
    const ox = Math.max(0, Math.ceil(-pan.x / zoom / 8) * 8), oy = Math.max(0, Math.ceil(-pan.y / zoom / 8) * 8); // slots start at the top-left of what is on screen
    const perRow = Math.max(1, Math.floor((canvas.clientWidth / zoom - 2 * pad + gapX) / (w + gapX)));
    for (let i = 0; i < 400; i++) {
      const x = ox + pad + (i % perRow) * (w + gapX), y = oy + pad + Math.floor(i / perRow) * (h + gapY);
      if (!boxes.some((b) => x < b.x + b.w + gapX && b.x < x + w + gapX && y < b.y + b.h + gapY && b.y < y + h + gapY)) return { x, y };
    }
    return { x: ox + pad, y: oy + pad };
  }

  // --- entity lifecycle ----------------------------------------------------
  function addTableFromUser(db, table, x, y) {
    if (typeof db !== "string" || !db || typeof table !== "string" || !table) return; // malformed drag payload
    const existing = [...entities.values()].find((e) => e.db === db && e.table === table);
    if (existing) {
      reveal(existing);
      existing.el.focus({ preventScroll: true });
      existing.el.classList.add("is-flash");
      setTimeout(() => existing.el.classList.remove("is-flash"), 1200);
      toast(`${db}.${table} is already on the canvas.`, "info");
      return;
    }
    const id = createEntity(db, table, x, y);
    reveal(entities.get(id)); // a + add can land below the visible ground (the grid fills down); bring it into view
  }

  function createEntity(db, table, x, y, { source = null, customSql = null, customSqlMysql = null, listHeight = null, id = null } = {}) {
    // `id`: Undo of a remove gives the card its old id back, so worksheet fields that point at it find it again
    const entity = { id: id && !entities.has(id) ? id : `${db}.${table}#${++seq}`, db, table, x, y, columns: [], el: null };
    if (source) entity.source = source;
    else if (customSql) { entity.customSql = customSql; if (customSqlMysql) entity.customSqlMysql = customSqlMysql; }
    entity.el = renderCard(entity);
    setListHeight(entity, cleanListHeight(listHeight));
    place(entity);
    entities.set(entity.id, entity);
    canvas.append(entity.el);
    refreshEmpty();
    emit("entity:added", { entityId: entity.id });
    loadEntity(entity);
    return entity.id;
  }

  function clearAll() {
    for (const entity of [...entities.values()]) {
      emit("entity:removed", { entityId: entity.id }); // relations.js drops its links
      entity.el.remove();
      entities.delete(entity.id);
    }
    refreshEmpty();
  }

  async function removeEntity(entity) {
    if (relationshipsFor(entity.id).length > 0) {
      const ok = await confirmDialog(
        `Remove ${entity.db}.${entity.table} and its relationship(s)?`,
        { danger: true, confirmText: "Remove" },
      );
      if (!ok) return;
    }
    // What Undo needs: the card as the workbook saves it, plus its relationships (copied before relations.js drops them).
    const snap = { id: entity.id, db: entity.db, table: entity.table, x: entity.x, y: entity.y, source: entity.source ?? null,
      customSql: entity.customSql ?? null, customSqlMysql: entity.customSqlMysql ?? null, listHeight: entity.listHeight ?? null,
      rels: relationshipsFor(entity.id).map((r) => structuredClone(r)) };
    emit("entity:removed", { entityId: entity.id }); // relations.js drops its links
    entity.el.remove();
    entities.delete(entity.id);
    refreshEmpty();
    const name = entity.source ? entity.table : `${entity.db}.${entity.table}`;
    toast(`Removed ${name}.`, "info", { action: { label: "Undo", run: () => restoreRemoved(snap) } });
  }

  // Undo of a remove: the same card (same id, place, SQL, list height) and every relationship whose other card is still there.
  function restoreRemoved(snap) {
    if (!snap.source && [...entities.values()].some((e) => e.db === snap.db && e.table === snap.table)) {
      toast(`${snap.db}.${snap.table} is already on the canvas.`, "info");
      return;
    }
    const id = createEntity(snap.db, snap.table, snap.x, snap.y, snap);
    reveal(entities.get(id));
    const back = snap.rels.filter((r) => [r.from.entityId, r.to.entityId].every((e) => e === snap.id || entities.has(e)));
    if (back.length) emit("rel:reinstate", { rels: back.map((r) => ({ ...r, from: { ...r.from, entityId: r.from.entityId === snap.id ? id : r.from.entityId }, to: { ...r.to, entityId: r.to.entityId === snap.id ? id : r.to.entityId } })) });
  }

  async function loadEntity(entity) {
    const statusEl = entity.el.querySelector(".entity__status");
    const bodyEl = entity.el.querySelector(".entity__body");
    setStatus(entity, "loading");
    hide(bodyEl);
    try {
      if (entity.source) {
        const res = await api.sourceColumns(wireSource(entity.source));
        entity.columns = res.columns;
        const lossy = lossyNote(res.lossy); // same-named columns of differing types were read as Float64
        entity.el.querySelector(".entity__note-lossy")?.remove();
        if (lossy) { const p = document.createElement("p"); p.className = "entity__note entity__note-lossy"; p.textContent = lossy; p.title = res.lossy.join(", "); entity.el.querySelector(".entity__note")?.after(p); }
        if (res.truncated) toast(`${entity.table}: only the first ${MAX_SOURCE_COLUMNS} shared columns are listed.`, "info");
      } else if (entity.customSql) entity.columns = (await api.sourceColumns(sqlWire(entity.db, entity.table, entity.customSql))).columns; // the query's own columns
      else entity.columns = await api.columns(entity.db, entity.table);
      renderColumns(entity);
      hide(statusEl);
      show(bodyEl);
      emit("entity:loaded", { entityId: entity.id }); // relations.js draws links that wait on these rows
    } catch (err) {
      setStatus(entity, "failed", err.message, err.status === 400); // a 400 is a rule the card breaks (the server's reason is shown): trying again would say the same
    }
  }

  // --- rendering -----------------------------------------------------------
  function renderCard(entity) {
    const card = document.createElement("section");
    card.className = "entity";
    card.tabIndex = -1; // focusable by script (a duplicate drop focuses the existing card)
    card.dataset.entityId = entity.id;
    if (entity.source) { card.classList.add("entity--source"); card.dataset.source = entity.source.kind; }

    const head = document.createElement("header");
    head.className = "entity__head";

    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "iconbtn entity__toggle";
    collapse.setAttribute("aria-label", "Collapse columns");
    collapse.setAttribute("aria-expanded", "true");
    collapse.append(icon("chevron"));
    collapse.addEventListener("click", () => toggleCollapsed(entity, collapse));

    const title = document.createElement("span");
    title.className = "entity__title";
    const tablePart = document.createElement("span");
    tablePart.className = "entity__table";
    tablePart.textContent = entity.table;
    title.append(tablePart);
    title.title = `${entity.db}.${entity.table}`;
    // The database only earns space in the title when another card has the same table name.
    if ([...entities.values()].some((e) => e !== entity && e.table === entity.table && e.db !== entity.db)) {
      const dbPart = document.createElement("span");
      dbPart.className = "entity__db";
      dbPart.textContent = entity.db;
      title.append(dbPart);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "iconbtn iconbtn--danger";
    remove.setAttribute("aria-label", `Remove ${entity.db}.${entity.table}`);
    remove.append(icon("close"));
    remove.addEventListener("click", () => removeEntity(entity));

    // Shown by relations.js while the card is in no relationship (the model has other cards to relate it to). A button: it opens
    // "Relate <table> to" (relations.js, D127), so the warning is also the way out of it.
    const need = document.createElement("button");
    need.type = "button";
    need.className = "entity__need";
    need.textContent = "Needs a partner";
    need.title = "Held out of worksheets until this table is related to another one. Click to relate it.";
    need.hidden = true;
    need.addEventListener("click", () => emit("rel:relate", { entityId: entity.id }));
    // The link button: click for "Relate <table> to", or drag it onto another card to relate the two tables (relations.js, D127).
    let relate = null;
    if (!entity.source) {
      relate = document.createElement("button");
      relate.type = "button";
      relate.className = "iconbtn entity__relate";
      relate.draggable = true;
      relate.title = "Relate to another table — click, or drag onto a table";
      relate.setAttribute("aria-label", `Relate ${entity.table} to another table`);
      relate.append(icon("link"));
      relate.addEventListener("click", () => emit("rel:relate", { entityId: entity.id }));
    }

    // The Edit SQL icon button (D105) sits left of the title; a union / unpivot card is built from its own dialog and has no SQL to edit, so it gets none.
    if (!entity.source) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "iconbtn entity__edit";
      edit.title = "Edit SQL — choose or change the columns with your own SELECT";
      edit.setAttribute("aria-label", `Edit SQL for ${entity.db}.${entity.table}`);
      edit.append(icon("edit"));
      edit.addEventListener("click", () => editSql(entity));
      head.append(edit);
    }
    // The table button: the card's first rows in the data preview under the canvas (data-preview.js); pressed while it shows this card.
    const peek = document.createElement("button");
    peek.type = "button";
    peek.className = "iconbtn entity__peek";
    peek.title = "Preview data";
    peek.setAttribute("aria-label", `Preview data of ${entity.table}`);
    peek.setAttribute("aria-pressed", "false");
    peek.append(icon("table"));
    peek.addEventListener("click", () => togglePreview(entity.id));
    head.append(title, need, ...(relate ? [relate] : []), peek, collapse, remove); // the caret sits by the ✕
    // Fit the card to its name (and the Edit button) between the card's min/max tokens; beyond max the title ellipsises (title = full name).
    fitWidth(card, title, head.querySelector(".entity__edit"), need, relate, peek);
    enableDragMove(entity, head);

    const status = document.createElement("div");
    status.className = "entity__status";

    const body = document.createElement("div");
    body.className = "entity__body";
    body.hidden = true;
    // Joined keys are pinned here (Relations/relations.js), above the scrolling column list, so a link always ends on a visible row.
    const keys = document.createElement("div");
    keys.className = "entity__keys";
    const cols = document.createElement("div");
    cols.className = "entity__cols";
    body.append(keys, cols);

    if (entity.source) { // how the columns are matched, in one line (the same rule as the preview)
      const note = document.createElement("p");
      note.className = "entity__note";
      note.textContent = sourceNote(entity.source);
      body.prepend(note);
      if (entity.source.kind === "union") note.after(unionDiffControl(entity.source));
    }
    card.append(head, status, body, resizeHandle(entity, "top"), resizeHandle(entity, "bottom"));
    if (entity.customSql) syncSqlUi(entity, card);
    return card;
  }

  // --- list height (drag the card's top or bottom edge) ---------------------
  // The column list's height is the card's one adjustable size: null = the default (canvas.css), else a max-height in px that a saved workbook keeps.
  function setListHeight(entity, h) {
    if (h) { entity.listHeight = h; entity.el.style.setProperty("--list-h", `${h}px`); }
    else { delete entity.listHeight; entity.el.style.removeProperty("--list-h"); }
    entity.el.classList.toggle("entity--sized", Boolean(h));
  }

  // A thin strip along the top or bottom edge: drag it to grow or shrink the list (the top edge keeps the card's bottom in place),
  // double-click it to go back to the default. The bottom one is also a keyboard separator (↑ / ↓ in 8px steps).
  function resizeHandle(entity, edge) {
    const grip = document.createElement("div");
    grip.className = `entity__resize entity__resize--${edge}`;
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", `Resize ${entity.table} column list`);
    grip.title = "Drag to resize";
    if (edge === "bottom") grip.tabIndex = 0;
    const list = () => entity.el.querySelector(".entity__cols");
    const apply = (dy, start) => {
      const { h, y } = dragListHeight({ edge, startH: start.h, startY: start.y, dy, fit: list().scrollHeight });
      setListHeight(entity, h);
      if (y !== entity.y) { entity.y = y; place(entity); }
      emit("entity:moved", { entityId: entity.id }); // links re-route; the workbook marks itself changed
    };
    const current = () => ({ h: list().offsetHeight, y: entity.y }); // offsetHeight is unscaled, so a zoomed view still lands on the 8px grid
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY, start = current();
      grip.setPointerCapture(event.pointerId);
      entity.el.classList.add("entity--resizing"); grip.classList.add("is-active");
      const move = (ev) => apply(toModel(ev.clientY - startY, zoom), start);
      const up = () => {
        entity.el.classList.remove("entity--resizing"); grip.classList.remove("is-active");
        grip.releasePointerCapture(event.pointerId);
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
    grip.addEventListener("dblclick", () => { if (!entity.listHeight) return; setListHeight(entity, null); emit("entity:moved", { entityId: entity.id }); });
    grip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      apply(event.key === "ArrowDown" ? 8 : -8, current());
    });
    return grip;
  }

  // --- custom SQL (D105) ---------------------------------------------------
  // The card's marks for custom SQL: a class, and one note line under the head (like a union's), added or removed to match entity.customSql.
  function syncSqlUi(entity, card = entity.el) {
    card.classList.toggle("entity--sql", Boolean(entity.customSql));
    const body = card.querySelector(".entity__body");
    let note = body.querySelector(".entity__note--sql");
    if (!entity.customSql) { note?.remove(); return; }
    if (!note) { note = document.createElement("p"); note.className = "entity__note entity__note--sql"; body.prepend(note); }
    note.textContent = SQL_NOTE;
  }

  // The key columns the card's relationships use: a new query has to keep them, or those links would point at nothing.
  const keyColumnsOf = (entity) => relationshipsFor(entity.id).flatMap(relEnds).filter((end) => end.entityId === entity.id).map((end) => end.column);
  const keysMessage = (lost) => `The relationships on this card use ${lost.map((c) => `“${c}”`).join(", ")}. Keep ${lost.length === 1 ? "that column" : "those columns"} in the query, or remove the relationship first.`;

  // A key whose kind (number / text / date / boolean) would change to one its partner key can't match: a relationship needs the same kind on both ends.
  const kindsMessage = ([k]) => `“${k.column}” is a key in a relationship with ${k.partner} (${k.other}), but the query would make it ${k.now}. Both ends must hold the same kind of value — change the query or remove the relationship first.`;
  const brokenKinds = (entity, columns) => keyKindBreaks(entity.id, relationshipsFor(entity.id), entities, columns);

  function editSql(entity) {
    const own = () => defaultSql(entity.db, entity.table, entity.columns);
    let tableColumns = null; // the table's own columns, read once per dialog while the card shows a query's
    const tableDefault = async () => defaultSql(entity.db, entity.table, tableColumns ??= await api.columns(entity.db, entity.table));
    openSqlDialog({
      table: entity.table,
      // MySQL is what the dialog opens in: the text it was written as, else the query translated for display (the default SELECT reads the same in both)
      mysql: entity.customSql ? (entity.customSqlMysql ?? null) : own(),
      translate: (text, from, to, signal) => api.translateSql(text, from, to, { signal }),
      explain: (text, signal) => api.sourceSyntax(sqlWire(entity.db, entity.table, text), { signal }), // how ClickHouse reads it, to tell whether a MySQL round trip kept the meaning
      validate: (sql, signal) => api.sourceColumns(sqlWire(entity.db, entity.table, sql), { signal }), // the live check while typing: describes the query, reads no rows
      sql: entity.customSql ?? own(),
      // "Default" is always the table's own SELECT, even when the card now shows a query's columns.
      getDefault: async () => (entity.customSql ? tableDefault() : own()),
      apply: async (sql, mysql) => { // `sql` is the ClickHouse query that will run; `mysql` the MySQL text it was written as, or null
        if (!entity.customSql && sql.trim() === own().trim()) return; // the default text: nothing to change
        if (entity.customSql && sql.trim() === (await tableDefault()).trim()) { backToTable(entity, tableColumns); return; } // Reset to default + Save = back to the table
        if (sql === entity.customSql) { // the same query; only the way it was written may have changed
          if ((mysql ?? null) !== (entity.customSqlMysql ?? null)) { if (mysql) entity.customSqlMysql = mysql; else delete entity.customSqlMysql; }
          return;
        }
        const { columns } = await api.sourceColumns(sqlWire(entity.db, entity.table, sql)); // the server checks and describes the query; an error stays in the dialog
        const lost = lostKeys(keyColumnsOf(entity), columns);
        if (lost.length) throw new Error(keysMessage(lost));
        const broken = brokenKinds(entity, columns);
        if (broken.length) throw new Error(kindsMessage(broken));
        applyCustomSql(entity, sql, columns, mysql);
        toast(`${entity.table}: using your SQL.`, "ok");
      },
    });
  }

  // Drop the card's SQL and read the table again. Thrown errors (a relationship key the table lacks or types differently) stay in the dialog.
  function backToTable(entity, columns) {
    const lost = lostKeys(keyColumnsOf(entity), columns);
    if (lost.length) throw new Error(keysMessage(lost));
    const broken = brokenKinds(entity, columns);
    if (broken.length) throw new Error(kindsMessage(broken));
    applyCustomSql(entity, null, columns);
    toast(`${entity.table}: back to the table.`, "ok");
  }

  // Switch a card to a query (or back to its table): its columns become the query's, and everything that cached the old ones is told.
  function applyCustomSql(entity, sql, columns, mysql = null) {
    if (sql) entity.customSql = sql; else delete entity.customSql;
    if (sql && mysql) entity.customSqlMysql = mysql; else delete entity.customSqlMysql; // the MySQL text it was written as, kept so reopening shows exactly it
    entity.columns = columns;
    syncSqlUi(entity);
    renderColumns(entity);
    emit("entity:sql", { entityId: entity.id, db: entity.db, table: entity.table });
    emit("entity:loaded", { entityId: entity.id }); // links redraw on the new rows; worksheets re-check their fields
    if (previewedId() !== entity.id) showPreview(entity.id); // the data preview shows what the card now returns (it re-reads by itself when already on this card)
  }

  // Width follows the `db.table` text: measured in the title's own font, held between --entity-min and --entity-max.
  function fitWidth(card, title, edit, need = null, relate = null, peek = null) {
    const measure = (node) => {
      const probe = node.cloneNode(true);
      probe.style.cssText = "position:absolute;visibility:hidden;flex:none;overflow:visible;white-space:nowrap";
      if (node === title) probe.style.padding = "0";
      canvas.append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    };
    const gap = parseFloat(getComputedStyle(canvas).getPropertyValue("--s2")) || 8;
    // the Edit button, the link and table buttons, and the "Needs a partner" badge while it shows, ride on the title's width (each with its gap), so they never clip a short name
    const px = measure(title) + (edit ? measure(edit) + gap : 0) + (need && !need.hidden ? measure(need) + gap : 0) + (relate ? measure(relate) + gap : 0) + (peek ? measure(peek) + gap : 0);
    const cs = getComputedStyle(canvas);
    const limit = (name, fallback) => parseFloat(cs.getPropertyValue(name)) || fallback;
    const { width } = entityWidth(px, { min: limit("--entity-min", 312), max: limit("--entity-max", 480) });
    card.style.width = `${width}px`;
  }

  function renderColumns(entity) {
    const cols = entity.el.querySelector(".entity__cols");
    cols.replaceChildren();
    entity.el.querySelector(".entity__keys")?.replaceChildren();
    for (const [index, col] of entity.columns.entries()) {
      const row = document.createElement("div");
      row.className = "col-row";
      row.dataset.column = col.name;
      row.dataset.index = String(index);

      const isSource = Boolean(entity.source);
      const name = document.createElement("span");
      name.className = "col-row__name";
      name.textContent = col.name;
      name.title = col.name;

      const type = document.createElement("span");
      type.className = "col-row__type";
      type.dataset.category = col.category;
      type.textContent = cardType(col.type); // the ClickHouse type (UInt64, Nullable(String)…) minus LowCardinality; the full type is the tooltip
      type.title = `${col.type} (${col.category})`;

      // Column profile + field details (Schema/column-profile-dialog.js). 
      const profile = document.createElement("button");
      profile.type = "button";
      profile.className = "iconbtn col-row__profile";
      profile.setAttribute("aria-label", `Profile ${col.name}`);
      profile.title = "Profile this field (distinct values, nulls, top values)";
      profile.append(icon("profile", { size: 14 }));
      profile.addEventListener("click", (event) => { event.preventDefault(); openColumnProfile(entity.db, entity.table, col, entity.customSql ? sqlWire(entity.db, entity.table, entity.customSql) : null); });

      if (isSource) row.append(name, type); // no profile: it reads the table's own rows, which a union / unpivot card does not show
      else row.append(name, type, profile);
      cols.append(row);
    }
  }

  function setStatus(entity, state, message, refused = false) {
    const statusEl = entity.el.querySelector(".entity__status");
    statusEl.hidden = false;
    statusEl.replaceChildren();

    const pill = document.createElement("span");
    if (state === "loading") {
      pill.className = "pill pill--warn";
      const g = document.createElement("span");
      g.className = "pill__glyph";
      g.append(icon("refresh", { size: 14 }));
      pill.append(g, " Loading…");
      statusEl.append(pill);
      return;
    }
    pill.className = "pill pill--danger";
    pill.append(icon("error", { size: 14 }), " Failed to load");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn--danger";
    retry.textContent = refused ? "Remove card" : "Retry"; // the same request would be refused again: offer the way out instead
    retry.addEventListener("click", () => (refused ? removeEntity(entity) : loadEntity(entity)));
    statusEl.append(pill, document.createTextNode(" "), retry);
    if (message) {
      const detail = document.createElement("p");
      detail.className = "entity__error";
      detail.textContent = message;
      statusEl.append(detail);
    }
  }

  // Collapse/expand a card's columns + preview (the head stays visible).
  function toggleCollapsed(entity, btn) {
    const collapsed = entity.el.classList.toggle("entity--collapsed");
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", collapsed ? "Expand columns" : "Collapse columns");
  }

  // Cards sit on the dot grid's 8px steps, never at a negative offset.
  const snap = (v) => Math.max(0, Math.round(v / 8) * 8);

  // Move a card by dragging its head (pointer events; the icon buttons are excluded).
  // The tops that would put one of this card's links on a straight line: its pinned key row level with the partner's key row.
  // Rows are measured where they sit, so the pinned strip, its order and a different head height are all accounted for.
  function straightenTops(entity) {
    const centre = (card, column) => {
      const row = card.el.querySelector(`.col-row[data-column="${CSS.escape(column)}"]`);
      return row ? (row.getBoundingClientRect().top - card.el.getBoundingClientRect().top + row.getBoundingClientRect().height / 2) / zoom : null;
    };
    const tops = [];
    if (entity.el.classList.contains("entity--collapsed")) return tops;
    for (const rel of relationshipsFor(entity.id)) {
      const mine = rel.from.entityId === entity.id ? rel.from : rel.to;
      const theirs = mine === rel.from ? rel.to : rel.from;
      const other = entities.get(theirs.entityId);
      if (!other || other.el.classList.contains("entity--collapsed")) continue;
      const a = centre(entity, mine.column), b = centre(other, theirs.column);
      if (a !== null && b !== null) tops.push(other.y + b - a);
    }
    return tops;
  }

  function enableDragMove(entity, head) {
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const originX = entity.x;
      const originY = entity.y;
      entity.el.classList.add("entity--dragging");
      head.setPointerCapture(event.pointerId);

      const move = (ev) => {
        entity.x = snap(originX + toModel(ev.clientX - startX, zoom));
        entity.y = ev.altKey ? snap(originY + toModel(ev.clientY - startY, zoom)) : snapTop(snap(originY + toModel(ev.clientY - startY, zoom)), straightenTops(entity)); // Alt: no magnet
        place(entity);
        emit("entity:moved", { entityId: entity.id }); // relationship links re-route
      };
      const up = () => {
        entity.el.classList.remove("entity--dragging");
        head.releasePointerCapture(event.pointerId);
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
    });
  }
}
