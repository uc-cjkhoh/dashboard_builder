import { emptyState } from "./empty-state.js";
import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { show, hide, toggle, confirmDialog, toast } from "../Core/ui.js";
import { entities, relationshipsFor, emit, bus, isModelActive, showModel } from "../Core/store.js";

// Data Model canvas + entity cards. A table dropped from the sidebar (or added via the
// `table:add` fallback) becomes an entity card: a db.table head over a fixed-height, scrollable
// list of column rows (name + type badge + join-key checkbox). Cards are a uniform height, moved
// by dragging the head and removed via the head's trash icon. No row preview here — data lives in
// dashboard widgets. Entities are the shared model (store.js).
const TABLE_MIME = "application/x-ch-table";

// Set by initCanvas — the entry points the Workbook feature uses to rebuild the model.
let createEntityImpl = null;
let clearModelImpl = null;

/** Add a table to the Data Model at (x, y). `joinKeys` are ticked once its columns load (workbook
 *  open). Returns the new entity id, or null before the canvas is initialised. */
export function addEntity(db, table, x, y, opts) { return createEntityImpl?.(db, table, x, y, opts) ?? null; }

/** Remove every entity (and so every relationship) without asking — used when opening a workbook. */
export function clearModel() { clearModelImpl?.(); }

export function initCanvas() {
  const canvas = document.getElementById("model-view");
  const empty = document.getElementById("canvas-empty");
  if (!canvas) return;

  let seq = 0; // entities/relationships live in the shared store (store.js)

  const emptyTitle = document.getElementById("canvas-empty-title");
  const emptyAction = document.getElementById("canvas-empty-action");
  let connected = false;

  const dbSelect = document.getElementById("db-select");
  const currentEmpty = () => emptyState({ connected, databaseSelected: Boolean(dbSelect?.value) });

  // One sentence + one button, by state. The buttons focus controls that are visible in that state.
  const refreshEmpty = () => {
    toggle(empty, entities.size === 0);
    const st = currentEmpty();
    if (emptyTitle) emptyTitle.textContent = st.text;
    if (emptyAction) emptyAction.textContent = st.action;
  };
  emptyAction?.addEventListener("click", () => { document.getElementById(currentEmpty().focusId)?.focus(); });
  dbSelect?.addEventListener("change", refreshEmpty);
  document.addEventListener("connection:changed", (e) => { connected = Boolean(e.detail?.connected); refreshEmpty(); });
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
    const x = event.clientX - rect.left + canvas.scrollLeft - 24;
    const y = event.clientY - rect.top + canvas.scrollTop - 12;
    addTableFromUser(payload?.db, payload?.table, Math.max(0, x), Math.max(0, y));
  });

  // Non-drag fallback (accessibility): schema.js dispatches this from a chip's plus button.
  // A table always goes to the shared Data Model; switch there if a dashboard is showing.
  document.addEventListener("table:add", (event) => {
    const { db, table } = event.detail;
    showModel();
    const offset = 24 * (entities.size % 8);
    addTableFromUser(db, table, 24 + offset, 24 + offset);
  });

  // Show the model view only when it's the active view (dashboards render elsewhere).
  bus.addEventListener("view:changed", () => toggle(canvas, isModelActive()));
  toggle(canvas, isModelActive());

  createEntityImpl = createEntity;
  clearModelImpl = clearAll;

  // --- entity lifecycle ----------------------------------------------------
  function addTableFromUser(db, table, x, y) {
    if (typeof db !== "string" || !db || typeof table !== "string" || !table) return; // malformed drag payload
    const existing = [...entities.values()].find((e) => e.db === db && e.table === table);
    if (existing) {
      existing.el.scrollIntoView({ block: "nearest", inline: "nearest" });
      existing.el.focus({ preventScroll: true });
      existing.el.classList.add("is-flash");
      setTimeout(() => existing.el.classList.remove("is-flash"), 1200);
      toast(`${db}.${table} is already on the canvas.`, "info");
      return;
    }
    createEntity(db, table, x, y);
  }

  function createEntity(db, table, x, y, { joinKeys = [] } = {}) {
    const entity = { id: `${db}.${table}#${++seq}`, db, table, x, y, columns: [], joinKeys: new Set(), el: null };
    entity.pendingKeys = joinKeys; // ticked after the columns load (workbook open)
    entity.el = renderCard(entity);
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
      entity.columns = await api.columns(entity.db, entity.table);
      renderColumns(entity);
      applyPendingKeys(entity);
      hide(statusEl);
      show(bodyEl);
      emit("entity:loaded", { entityId: entity.id }); // relations.js draws links that wait on these rows
    } catch (err) {
      setStatus(entity, "failed", err.message);
    }
  }

  // Tick the join keys a workbook saved for this table. Going through the checkbox's own change
  // handler keeps entity.joinKeys, the row highlight and the connector handle in step.
  function applyPendingKeys(entity) {
    const keys = entity.pendingKeys;
    entity.pendingKeys = null;
    if (!keys?.length) return;
    for (const key of entity.el.querySelectorAll(".col-row__key")) {
      if (key.checked || !keys.includes(key.closest(".col-row").dataset.column)) continue;
      key.checked = true;
      key.dispatchEvent(new Event("change"));
    }
  }

  // --- rendering -----------------------------------------------------------
  function renderCard(entity) {
    const card = document.createElement("section");
    card.className = "entity";
    card.tabIndex = -1; // focusable by script (a duplicate drop focuses the existing card)
    card.dataset.entityId = entity.id;
    card.style.left = `${entity.x}px`;
    card.style.top = `${entity.y}px`;

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
    const dbPart = document.createElement("span");
    dbPart.className = "entity__db";
    dbPart.textContent = `${entity.db}.`;
    const tablePart = document.createElement("span");
    tablePart.className = "entity__table";
    tablePart.textContent = entity.table;
    title.append(dbPart, tablePart);
    title.title = `${entity.db}.${entity.table}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "iconbtn iconbtn--danger";
    remove.setAttribute("aria-label", `Remove ${entity.db}.${entity.table}`);
    remove.append(icon("close"));
    remove.addEventListener("click", () => removeEntity(entity));

    head.append(collapse, title, remove);
    enableDragMove(entity, head);

    const status = document.createElement("div");
    status.className = "entity__status";

    const body = document.createElement("div");
    body.className = "entity__body";
    body.hidden = true;
    const cols = document.createElement("div");
    cols.className = "entity__cols";
    body.append(cols);

    card.append(head, status, body);
    return card;
  }

  function renderColumns(entity) {
    const cols = entity.el.querySelector(".entity__cols");
    cols.replaceChildren();
    for (const col of entity.columns) {
      const row = document.createElement("label");
      row.className = "col-row";
      row.dataset.column = col.name;

      const key = document.createElement("input");
      key.type = "checkbox";
      key.className = "col-row__key";
      key.setAttribute("aria-label", `Use ${col.name} as a join key`);
      key.addEventListener("change", () => {
        if (key.checked) entity.joinKeys.add(col.name);
        else entity.joinKeys.delete(col.name);
        row.classList.toggle("col-row--key", key.checked);
        keyIcon.hidden = !key.checked;
        // relations.js adds/removes the connector handle and prunes dropped links.
        emit("joinkey:changed", { entityId: entity.id, column: col.name, checked: key.checked });
      });

      const keyIcon = icon("key", { size: 14 }); // shown while this column is a join key
      keyIcon.classList.add("col-row__keyicon");
      keyIcon.hidden = !key.checked;

      const name = document.createElement("span");
      name.className = "col-row__name";
      name.textContent = col.name;
      name.title = col.name;

      const type = document.createElement("span");
      type.className = "col-row__type";
      type.dataset.category = col.category;
      type.textContent = col.type;
      type.title = `${col.type} (${col.category})`;

      row.append(key, keyIcon, name, type);
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
    // failed
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

  // Move a card by dragging its head (pointer events; the icon buttons are excluded).
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
        entity.x = Math.max(0, originX + (ev.clientX - startX));
        entity.y = Math.max(0, originY + (ev.clientY - startY));
        entity.el.style.left = `${entity.x}px`;
        entity.el.style.top = `${entity.y}px`;
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
