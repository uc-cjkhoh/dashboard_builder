import { emptyState } from "./empty-state.js";
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { show, hide, toggle, confirmDialog, toast } from "../Core/ui.js";
import { entities, relationshipsFor, emit, bus, isModelActive, showModel } from "../Core/store.js";
import { expandSidebar } from "../Shell/sidebar.js";
import { openColumnProfile } from "../Schema/column-profile-dialog.js";
import { entityWidth } from "./card-width.js";
import { snapTop } from "./align-snap.js";
import { clampZoom, wheelZoom, panForZoom, panToReveal, toModel } from "./canvas-zoom.js";
import { unionDiffControl } from "./union-diff.js";
import { sourceNote, lossyNote, wireSource, MAX_SOURCE_COLUMNS } from "../Core/source-model.js";

// Data Source canvas + entity cards. A table dropped from the sidebar (or added via the
// `table:add` fallback) becomes an entity card: a db.table head over a fixed-height, scrollable
// list of column rows (name + type badge). Cards are a uniform height, moved
// by dragging the head and removed via the head's trash icon. No row preview here — data lives in
// dashboard widgets. Entities are the shared model (store.js).
const TABLE_MIME = "application/x-ch-table";

// Set by initCanvas — the entry points the Workbook feature uses to rebuild the model.
let createEntityImpl = null;
let clearModelImpl = null;

/** Add a table to the Data Source at (x, y). `source` makes it a union / unpivot entity (Core/source-model.js; its `table` is the source's name; it takes no relationship).
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
  toggle(canvas, isModelActive());

  createEntityImpl = createEntity;
  clearModelImpl = clearAll;

  // First grid slot (left→right, top→bottom, fitted to the visible width) that no card overlaps, so a
  // card added with the + button never hides another card's title. Dropped cards keep the drop point.
  function freeSlot() {
    const pad = 16, gap = 96, w = 312, h = 312;  // pad = the view gutter (.view --s4), so cards line up with the tab strip; gap = room for a link's elbow and badge between cards
    const boxes = [...entities.values()].map((e) => ({ x: e.x, y: e.y, w: e.el.offsetWidth, h: e.el.offsetHeight }));
    const ox = Math.max(0, Math.ceil(-pan.x / zoom / 8) * 8), oy = Math.max(0, Math.ceil(-pan.y / zoom / 8) * 8); // slots start at the top-left of what is on screen
    const perRow = Math.max(1, Math.floor((canvas.clientWidth / zoom - 2 * pad + gap) / (w + gap)));
    for (let i = 0; i < 400; i++) {
      const x = ox + pad + (i % perRow) * (w + gap), y = oy + pad + Math.floor(i / perRow) * (h + gap);
      if (!boxes.some((b) => x < b.x + b.w + gap && b.x < x + w + gap && y < b.y + b.h + gap && b.y < y + h + gap)) return { x, y };
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
    createEntity(db, table, x, y);
  }

  function createEntity(db, table, x, y, { source = null } = {}) {
    const entity = { id: `${db}.${table}#${++seq}`, db, table, x, y, columns: [], el: null };
    if (source) entity.source = source;
    entity.el = renderCard(entity);
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
    emit("entity:removed", { entityId: entity.id }); // relations.js drops its links
    entity.el.remove();
    entities.delete(entity.id);
    refreshEmpty();
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
      } else entity.columns = await api.columns(entity.db, entity.table);
      renderColumns(entity);
      hide(statusEl);
      show(bodyEl);
      emit("entity:loaded", { entityId: entity.id }); // relations.js draws links that wait on these rows
    } catch (err) {
      setStatus(entity, "failed", err.message);
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
    // Fit the card to its name between the card's min/max tokens; beyond max the title ellipsises (title = full name).
    fitWidth(card, title);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "iconbtn iconbtn--danger";
    remove.setAttribute("aria-label", `Remove ${entity.db}.${entity.table}`);
    remove.append(icon("close"));
    remove.addEventListener("click", () => removeEntity(entity));

    // Shown by relations.js while the card is in no relationship (the model has other cards to relate it to).
    const need = document.createElement("span");
    need.className = "entity__need";
    need.textContent = "Needs a partner";
    need.title = "Held out of worksheets until this table is related to another one";
    need.hidden = true;

    head.append(title, need, collapse, remove); // the caret sits by the ✕ so the title starts on the card's left gutter, like the column names
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
    card.append(head, status, body);
    return card;
  }

  // Width follows the `db.table` text: measured in the title's own font, held between --entity-min and --entity-max.
  function fitWidth(card, title) {
    const probe = title.cloneNode(true);
    probe.style.cssText = "position:absolute;visibility:hidden;flex:none;overflow:visible;padding:0;white-space:nowrap";
    canvas.append(probe);
    const px = probe.getBoundingClientRect().width;
    probe.remove();
    const cs = getComputedStyle(canvas);
    const limit = (name, fallback) => parseFloat(cs.getPropertyValue(name)) || fallback;
    const { width } = entityWidth(px, { min: limit("--entity-min", 300), max: limit("--entity-max", 480) });
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
      type.textContent = col.type;
      type.title = `${col.type} (${col.category})`;

      // Column profile + field details (Schema/column-profile-dialog.js). 
      const profile = document.createElement("button");
      profile.type = "button";
      profile.className = "iconbtn col-row__profile";
      profile.setAttribute("aria-label", `Profile ${col.name}`);
      profile.title = "Profile this field (distinct values, nulls, top values)";
      profile.append(icon("profile", { size: 14 }));
      profile.addEventListener("click", (event) => { event.preventDefault(); openColumnProfile(entity.db, entity.table, col); });

      if (isSource) row.append(name, type); // no profile: a source takes no relationship and reads no table
      else row.append(name, type, profile);
      cols.append(row);
    }
  }

  function setStatus(entity, state, message) {
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
    retry.textContent = "Retry";
    retry.addEventListener("click", () => loadEntity(entity));
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
      if (event.button !== 0 || event.target.closest(".iconbtn")) return;
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
