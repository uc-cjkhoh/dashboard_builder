import { emptyState } from "./empty-state.js";
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { openContextMenu } from "../Core/menu.js";
import { show, hide, toggle, confirmDestructive, toast } from "../Core/ui.js";
import { exit } from "../Core/motion.js";
import { entities, relationshipsFor, emit, bus, isModelActive, showModel } from "../Core/store.js";
import { expandSidebar } from "../Shell/sidebar.js";
import { openColumnProfile } from "../Schema/column-profile-dialog.js";
import { cardType } from "./column-type.js";
import { entityWidth, rowsWidth } from "./card-width.js";
import { snapTop } from "./align-snap.js";
import { dragListHeight, cleanListHeight } from "./card-height.js";
import { clampZoom, wheelZoom, panForZoom, panToReveal, toModel, stepZoom, fitView, panByKey } from "./canvas-zoom.js";
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
let fitCanvasImpl = null;
let canvasViewImpl = null;
let restoreViewImpl = null;

/** Add a table to the Data Source at (x, y). `source` makes it a union / unpivot entity (Core/source-model.js; its `table` is the source's name; it takes no relationship).
 *  `customSql` is a saved SELECT the card reads instead of the table (D105; the card stays an ordinary, relatable table card); `customSqlMysql` the MySQL text it was written as (D106).
 *  Returns the new entity id, or null before the canvas is initialised. */
export function addEntity(db, table, x, y, opts) { return createEntityImpl?.(db, table, x, y, opts) ?? null; }

/** Remove every entity (and so every relationship) without asking — used when opening a workbook. */
export function clearModel() { clearModelImpl?.(); }

/** Zoom and pan so every card shows, once the cards have their columns (a card's height settles when they load) and the Data Source is on screen.
 *  Used after a workbook is opened; a pan, zoom or Fit by the user in the meantime cancels it. */
export function fitCanvas() { fitCanvasImpl?.(); }

/** The Data Source's zoom and pan, for the workbook to save: `{ zoom, pan: { x, y } }`, or null while a fit is still waiting for the cards (that view is a placeholder, not something the user chose). */
export function canvasView() { return canvasViewImpl?.() ?? null; }

/** Show a saved view (zoom, pan) instead of fitting; cancels a fit that is waiting. Used when a workbook is opened with a saved view. */
export function restoreView(view) { restoreViewImpl?.(view); }

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
    pendingFit = false; // the user took the view: a fit waiting on the cards would undo it
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
      pendingFit = false;
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

  // --- overview: Fit, keyboard pan and zoom ----------------------
  let pendingFit = false; // a fit asked for before the cards had their columns (or before the Data Source was on screen)
  const viewCentre = () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
  const zoomBy = (dir) => setZoom(stepZoom(zoom, dir), viewCentre());
  // Zoom and pan so every card shows, as large as fits and never past 100 %.
  function fit() {
    pendingFit = false;
    const boxes = [...entities.values()].map((e) => ({ x: e.x, y: e.y, w: e.el.offsetWidth, h: e.el.offsetHeight }));
    if (!boxes.length || !canvas.clientWidth) return;
    const v = fitView(boxes, canvas.clientWidth, canvas.clientHeight, 16);
    zoom = v.zoom;
    Object.assign(pan, v.pan);
    refreshView();
  }
  function tryFit() {
    if (!pendingFit || !canvas.clientWidth || [...entities.values()].some((e) => e.loading)) return;
    fit();
  }
  fitCanvasImpl = () => { pendingFit = true; tryFit(); };
  canvasViewImpl = () => (pendingFit ? null : { zoom, pan: { x: pan.x, y: pan.y } });
  restoreViewImpl = (view) => {
    pendingFit = false;
    zoom = clampZoom(view.zoom);
    pan.x = view.pan.x; pan.y = view.pan.y;
    refreshView();
  };

  // Fit is the one overview control with no pointer-only equivalent (the wheel zooms, F is a key): a solid icon button in the bottom-right dock, under Appearance (Shell/Index.cshtml).
  const fitBtn = document.createElement("button");
  fitBtn.type = "button";
  fitBtn.className = "iconbtn canvas__fit";
  fitBtn.setAttribute("aria-label", "Fit all cards (F)");
  fitBtn.title = "Fit all cards (F)";
  fitBtn.hidden = true;
  fitBtn.append(icon("expand"));
  fitBtn.addEventListener("click", fit);
  (document.getElementById("canvas-dock") ?? canvas).append(fitBtn);

  // The ground itself takes focus (cards, rows and inputs keep their own keys): arrows pan (Shift: four steps), + and − zoom, 0 is 100 %, F fits.
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-describedby", "canvas-key-help");
  const keyHelp = document.createElement("p");
  keyHelp.id = "canvas-key-help";
  keyHelp.className = "sr-only";
  keyHelp.textContent = "Arrow keys pan, Shift and an arrow pan further. Plus and minus zoom, 0 resets to 100 percent, F fits every card.";
  canvas.parentElement.append(keyHelp);
  canvas.addEventListener("keydown", (event) => {
    if (event.target !== canvas || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (key.startsWith("Arrow")) {
      const next = panByKey(pan, key, event.shiftKey);
      if (next === pan) return;
      event.preventDefault();
      pendingFit = false;
      Object.assign(pan, next);
      refreshView();
    } else if (key === "+" || key === "=") { event.preventDefault(); zoomBy(1); }
    else if (key === "-" || key === "_") { event.preventDefault(); zoomBy(-1); }
    else if (key === "0") { event.preventDefault(); setZoom(1, viewCentre()); }
    else if (key === "f" || key === "F") { event.preventDefault(); fit(); }
  });

  const emptyTitle = document.getElementById("canvas-empty-title");
  const emptyAction = document.getElementById("canvas-empty-action");
  let connected = false;

  let databaseOpen = false; // a database is open in the sidebar tree (schema.js says so)
  const currentEmpty = () => emptyState({ connected, databaseOpen });

  // One sentence + one button, by state. The buttons focus controls that are visible in that state.
  // While the connect form is open (Connection/connection.js), the start card shows even over cards — `data-over` adds a scrim.
  const connForm = document.getElementById("conn-form");
  const refreshEmpty = () => {
    const formOpen = Boolean(connForm && !connForm.hidden);
    toggle(empty, entities.size === 0 || formOpen);
    fitBtn.hidden = entities.size === 0 || formOpen; // nothing to fit, or the start card is over the cards
    empty?.toggleAttribute("data-over", formOpen && entities.size > 0);
    const st = currentEmpty();
    if (emptyTitle) emptyTitle.textContent = st.text;
    if (emptyAction) emptyAction.textContent = st.action;
  };
  emptyAction?.addEventListener("click", () => { expandSidebar(); document.getElementById(currentEmpty().focusId)?.focus(); });
  document.addEventListener("schema:open", (e) => { databaseOpen = (e.detail?.open ?? 0) > 0; refreshEmpty(); });
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
  bus.addEventListener("view:changed", () => { toggle(canvas, isModelActive()); tryFit(); });
  // relations.js showed or hid a card's "Needs a partner" badge: refit that card's width so the badge never clips its name
  bus.addEventListener("entity:need", (e) => {
    refit(entities.get(e.detail?.entityId));
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

  function createEntity(db, table, x, y, { source = null, customSql = null, customSqlMysql = null, listHeight = null } = {}) {
    const entity = { id: `${db}.${table}#${++seq}`, db, table, x, y, columns: [], el: null };
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
      entities.delete(entity.id); // out of the store first, so a listener that redraws (relations.js) never counts the card that is going
      emit("entity:removed", { entityId: entity.id }); // relations.js drops its links
      entity.el.remove();
    }
    refreshEmpty();
  }

  async function removeEntity(entity) {
    const name = entity.source ? entity.table : `${entity.db}.${entity.table}`;
    const rels = relationshipsFor(entity.id).length;
    const ok = await confirmDestructive(
      rels > 0 ? `Remove ${name} and its relationship(s)?` : `Remove ${name} from the canvas?`,
      { confirmText: "Remove" },
    );
    if (!ok) return;
    entities.delete(entity.id); // out of the store first: relations.js redraws on the event, and a card that is leaving must not take part (no proposal to it, no count)
    emit("entity:removed", { entityId: entity.id }); // relations.js drops its links
    entity.el.inert = true; // leaving: no more clicks or focus while it fades (the model is already without it)
    await exit(entity.el, { y: 4, scale: .98 });
    entity.el.remove();
    refreshEmpty();
    toast(`Removed ${name}.`, "info");
  }

  async function loadEntity(entity) {
    const statusEl = entity.el.querySelector(".entity__status");
    const bodyEl = entity.el.querySelector(".entity__body");
    setStatus(entity, "loading");
    hide(bodyEl);
    entity.loading = true; // a pending Fit (opening a workbook) waits for every card's height to settle
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
    } finally {
      entity.loading = false;
      tryFit();
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
    collapse.title = "Collapse columns";
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
    // The database only earns space in the title when another card has the same table name (syncDbLabels, below, keeps that true as cards come and go).
    if (collides(entity)) title.append(dbLabel(entity));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "iconbtn iconbtn--danger";
    remove.setAttribute("aria-label", `Remove ${entity.db}.${entity.table}`);
    remove.title = `Remove ${entity.db}.${entity.table}`;
    remove.append(icon("close"));
    remove.addEventListener("click", () => removeEntity(entity));

    // Shown by relations.js while the card is in no relationship (the model has other cards to relate it to). A plain label, not a button.
    const need = document.createElement("span");
    need.className = "entity__need";
    need.textContent = "Needs a partner";
    need.title = "Held out of worksheets until this table is related to another one.";
    need.hidden = true;
    // The ☰ menu holds the card's actions (Edit SQL, Preview data), so the head is the name, the badge, ☰, the caret and the ✕ (D129).
    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "iconbtn entity__menu";
    menu.title = "Table actions";
    menu.setAttribute("aria-label", `Actions for ${entity.table}`);
    menu.append(icon("menu"));
    wireCardMenu(entity, menu);
    head.append(title, need, menu, collapse, remove); // the caret sits by the ✕
    // Fit the card to its name (and the ☰ and the badge) between the card's min/max tokens; beyond max the title ellipsises (title = full name).
    fitWidth(card, title, menu, need);
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
          if ((mysql ?? null) !== (entity.customSqlMysql ?? null)) { if (mysql) entity.customSqlMysql = mysql; else delete entity.customSqlMysql; emit("entity:sqltext", { entityId: entity.id }); } // nothing else changes, but the workbook saves the new text
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

  // Width follows the `db.table` text and the longest column name + type: measured in their own fonts, held between --entity-min and --entity-max.
  const collides = (entity) => [...entities.values()].some((e) => e !== entity && e.table === entity.table && e.db !== entity.db);
  const dbLabel = (entity) => {
    const dbPart = document.createElement("span");
    dbPart.className = "entity__db";
    dbPart.textContent = entity.db;
    return dbPart;
  };
  // A card's database label follows the other cards: it appears on both once two cards share a table name in different databases,
  // and goes again when the twin is removed. The card refits, because the label changes its title's width.
  function syncDbLabels() {
    for (const entity of entities.values()) {
      const title = entity.el.querySelector(".entity__title");
      if (!title) continue;
      const want = collides(entity), has = title.querySelector(".entity__db");
      if (want && !has) title.append(dbLabel(entity));
      else if (!want && has) has.remove();
      else continue;
      refit(entity);
    }
  }
  bus.addEventListener("entity:added", () => queueMicrotask(syncDbLabels));
  bus.addEventListener("entity:removed", () => queueMicrotask(syncDbLabels)); // (the card is already out of the store; the microtask is kept for the listeners that read the DOM)

  /** The width the browser really gives a card's column-list scrollbar (thin, classic or overlay, whichever the platform draws), px. Measured on a
   *  hidden list with the same class, so core.css decides the look; the rows' right padding and the card width read it (--sb-w). */
  function measureScrollbar() {
    const probe = document.createElement("div");
    probe.className = "entity__cols";
    probe.style.cssText = "position:absolute;visibility:hidden;width:100px;height:40px;max-height:none;overflow:scroll;padding:0";
    probe.innerHTML = '<div style="height:200px"></div>';
    canvas.append(probe);
    const w = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    canvas.style.setProperty("--sb-w", `${w}px`);
    return w;
  }
  let scrollbarW = measureScrollbar();
  window.addEventListener("resize", () => { scrollbarW = measureScrollbar(); }); // a zoom or a changed OS setting can change it

  const rowsNeeded = new WeakMap(); // card element → the width its column rows ask for (renderColumns), so a long name never ellipsises for want of room
  function refit(entity) {
    const head = entity?.el.querySelector(".entity__head");
    if (head) fitWidth(entity.el, head.querySelector(".entity__title"), head.querySelector(".entity__menu"), head.querySelector(".entity__need"));
  }
  function fitWidth(card, title, menu, need = null) {
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
    // the ☰ button and the "Needs a partner" badge while it shows ride on the title's width (each with its gap), so they never clip a short name
    const px = measure(title) + (menu ? measure(menu) + gap : 0) + (need && !need.hidden ? measure(need) + gap : 0);
    const cs = getComputedStyle(canvas);
    const limit = (name, fallback) => parseFloat(cs.getPropertyValue(name)) || fallback;
    const { width } = entityWidth(px, { min: limit("--entity-min", 312), max: limit("--entity-max", 480) }, rowsNeeded.get(card) ?? 0);
    card.style.width = `${width}px`;
  }

  const textCtx = document.createElement("canvas").getContext?.("2d") ?? null; // text metrics work on a hidden or collapsed card too
  /** The widest of `labels` in the list's own font (`weight` "600" for names, which a key column bolds), px; 0 without a canvas. */
  function widestText(cols, labels, weight = "400") {
    if (!textCtx) return 0;
    const cs = getComputedStyle(cols);
    textCtx.font = `${weight} ${cs.fontSize} ${cs.fontFamily}`;
    return Math.ceil(Math.max(0, ...labels.map((l) => textCtx.measureText(l).width)));
  }

  function renderColumns(entity) {
    const cols = entity.el.querySelector(".entity__cols");
    cols.replaceChildren();
    entity.el.querySelector(".entity__keys")?.replaceChildren();
    // One type-column width per card (the longest label, measured), so the profile icon before it sits at the same x on every row.
    const typeW = widestText(cols, entity.columns.map((c) => cardType(c.type)));
    if (typeW) cols.style.setProperty("--type-w", `${typeW}px`); else cols.style.removeProperty("--type-w");
    rowsNeeded.set(entity.el, rowsWidth(widestText(cols, entity.columns.map((c) => c.name), "600"), typeW, { profile: !entity.source, scrollbar: scrollbarW }));
    refit(entity);
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
      profile.addEventListener("click", (event) => { event.preventDefault(); openColumnProfile(entity.db, entity.table, col, entity.customSql ? sqlWire(entity.db, entity.table, entity.customSql) : null, profile); });

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

  // The card's ☰ menu (D129): a popup on <body> under the button (Core/menu.js), so canvas zoom and the card's edges never shrink or clip it.
  // A union / unpivot card has no SQL to edit, so its menu holds Preview data only. Preview data is ticked while the panel shows this card.
  function wireCardMenu(entity, btn) {
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    let open = false, closedAt = -Infinity, reopen = true;
    const entries = () => [
      ...(entity.source ? [] : [
        { type: "item", icon: "edit", label: "Edit SQL", title: "Choose or change the columns with your own SELECT", onSelect: () => editSql(entity) },
      ]),
      { type: "check", icon: "table", label: "Preview data", checked: previewedId() === entity.id, onSelect: () => togglePreview(entity.id) },
    ];
    // The popup closes on any pointerdown outside it (capture, before this button hears it), the ☰ included: a close in that same
    // pointerdown means the ☰ was pressed to shut the menu, so the click that follows doesn't reopen it.
    btn.addEventListener("pointerdown", () => { reopen = !(open || performance.now() - closedAt < 50); });
    btn.addEventListener("click", () => {
      if (!reopen) { reopen = true; return; }
      const r = btn.getBoundingClientRect();
      open = true;
      btn.setAttribute("aria-expanded", "true");
      openContextMenu({
        x: r.left, y: r.bottom + 4, entries, label: `Actions for ${entity.table}`, returnFocus: () => btn,
        onClose: () => { open = false; closedAt = performance.now(); btn.setAttribute("aria-expanded", "false"); },
      });
    });
  }

  // Collapse/expand a card's columns + preview (the head stays visible).
  function toggleCollapsed(entity, btn) {
    const collapsed = entity.el.classList.toggle("entity--collapsed");
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", collapsed ? "Expand columns" : "Collapse columns");
    btn.title = collapsed ? "Expand columns" : "Collapse columns";
    followFold(entity);
  }

  // The body folds over a max-height transition (--dur-slow, 250ms): re-route the card's links every frame until it has settled.
  // A fixed window, not a transition check: the transition only exists after the next style pass, and reduced motion has none.
  function followFold(entity) {
    cancelAnimationFrame(entity.foldFrame);
    const until = performance.now() + 300;
    const tick = () => {
      emit("entity:collapsing", { entityId: entity.id });
      if (performance.now() < until) entity.foldFrame = requestAnimationFrame(tick);
    };
    tick();
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
