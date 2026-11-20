import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { toast } from "../Core/ui.js";
import { listStep } from "./table-filter.js";
import { entities, bus } from "../Core/store.js";
import { splitDatabases, sanitizeOpenMemory, rememberOpen, recallOpen } from "./schema-model.js";
import { filterTree, capRows, runLimited, initialOpen, LOAD_PARALLEL } from "./tree-model.js";
import { openTablePreview } from "../Rows/rows-dialog.js";

// Schema browser: a tree of the server's databases, each opening to its tables as draggable rows (Schema/_Schema.cshtml).
// Driven by the `connection:changed` event from connection.js — it does not touch the connection form. The tree scrolls inside its
// sidebar section. A database's tables are listed when it first opens (or when a search needs them), never all up front.
// The open databases per server live in this browser only (names, no secrets), so a reload lands back on them.
const OPEN_KEY = "dashboardbuilder.open-databases";
const loadMemory = () => { try { return sanitizeOpenMemory(JSON.parse(localStorage.getItem(OPEN_KEY))); } catch { return {}; } };
const saveMemory = (m) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(m)); } catch { /* not remembered — fine */ } };
const SYS = "sys"; // the System group's row key

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function initSchema() {
  const tableList = document.getElementById("table-list");
  const section = document.getElementById("schema-section");
  if (!tableList || !section) return;
  const searchEl = document.getElementById("table-search");
  const emptyEl = document.getElementById("table-empty");
  const statusEl = document.getElementById("table-status");

  let server = null;            // the connected view, the key for the remembered open set
  let dbs = { user: [], system: [] };
  const cache = new Map();      // db → { state: "loading" | "ready" | "error", tables, error }
  let open = new Set(), systemOpen = false, includeSystem = false;
  const showAll = new Set();    // databases drawn past the row cap
  const searchClosed = new Set(); // databases folded during one search (not remembered)
  let primed = false;           // this search has already asked for every database's tables
  let searchLoading = 0;
  let epoch = 0;                // bumped on connect / disconnect so a late answer from the old server is dropped
  let activeKey = null;         // the roving tab stop
  const query = () => searchEl?.value.trim() ?? "";
  const searching = () => query() !== "";
  const isOpen = (db) => (searching() ? !searchClosed.has(db) : open.has(db));

  const announce = () => document.dispatchEvent(new CustomEvent("schema:open", { detail: { open: open.size + (systemOpen ? 1 : 0) } }));
  const persist = () => { if (server) saveMemory(rememberOpen(loadMemory(), server, { open: [...open], system: systemOpen })); };

  // ---- loading -------------------------------------------------------------------------------------------------------
  async function ensureTables(db) {
    const hit = cache.get(db);
    if (hit && (hit.state === "ready" || hit.state === "loading")) return;
    const mine = epoch;
    cache.set(db, { state: "loading", tables: [] });
    render();
    try {
      const tables = await api.tables(db);
      if (mine !== epoch) return;
      cache.set(db, { state: "ready", tables });
    } catch (err) {
      if (mine !== epoch) return;
      cache.set(db, { state: "error", tables: [], error: err.message });
    }
    render();
  }

  // A search needs every database's tables: list the user databases (and System once asked), a few at a time.
  async function loadForSearch() {
    const targets = [...dbs.user, ...(includeSystem ? dbs.system : [])].filter((db) => !["ready", "loading"].includes(cache.get(db)?.state));
    if (!targets.length) return;
    const mine = epoch;
    searchLoading += 1;
    render();
    try { await runLimited(targets, LOAD_PARALLEL, ensureTables); }
    finally { if (mine === epoch) { searchLoading -= 1; render(); } }
  }

  function toggleDb(db) {
    if (searching()) {
      if (searchClosed.has(db)) searchClosed.delete(db); else searchClosed.add(db);
      render();
      return;
    }
    if (open.has(db)) open.delete(db); else { open.add(db); ensureTables(db); }
    persist();
    render();
    announce();
  }
  function toggleSystem() {
    systemOpen = !systemOpen;
    persist();
    render();
    announce();
  }

  // ---- rows ----------------------------------------------------------------------------------------------------------
  function dbRow({ key, name, glyph, opened, count, countTitle }) {
    const row = el("button", "tree-row db-row");
    row.type = "button";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-expanded", String(opened));
    row.dataset.key = key;
    const chev = el("span", "tree-row__chev"); chev.setAttribute("aria-hidden", "true"); chev.append(icon("chevron"));
    const glyphEl = el("span", "tree-row__icon"); glyphEl.setAttribute("aria-hidden", "true"); glyphEl.append(icon(glyph));
    const label = el("span", "tree-row__name", name); label.title = name;
    const badge = el("span", "db-row__count", count ? String(count) : "");
    badge.hidden = !count;
    if (countTitle) badge.title = countTitle;
    row.append(chev, glyphEl, label, badge);
    return row;
  }

  function note(text, { busy = false, error = false } = {}) {
    const n = el("p", `tree-note${error ? " tree-note--error" : ""}`);
    const g = el("span", busy ? "tree-note__glyph tree-spin" : "tree-note__glyph"); g.setAttribute("aria-hidden", "true");
    g.append(icon(error ? "warning" : busy ? "refresh" : "info"));
    n.append(g, el("span", "", text));
    return n;
  }

  function dbNode({ db, tables }) {
    const opened = isOpen(db);
    const node = el("div", "db-node");
    const placed = [...entities.values()].filter((e) => !e.source && e.db === db).length;
    const row = dbRow({ key: `db:${db}`, name: db, glyph: "database", opened, count: placed, countTitle: `${placed} on the canvas` });
    row.dataset.db = db;
    row.addEventListener("click", () => toggleDb(db));
    node.append(row);
    if (!opened) return node;
    const group = el("div", "db-children");
    group.setAttribute("role", "group");
    const st = cache.get(db);
    if (!st || st.state === "loading") group.append(note("Loading tables…", { busy: true }));
    else if (st.state === "error") {
      const e = note("Could not list tables.", { error: true });
      e.title = st.error; // the server's reason, on hover (the row stays one line)
      const retry = el("button", "btn btn--ghost tree-note__btn", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => { cache.delete(db); ensureTables(db); });
      e.append(retry);
      group.append(e);
    } else {
      const list = tables ?? st.tables;
      if (list.length === 0) group.append(note("No tables."));
      else {
        const { rows, hidden } = capRows(list, showAll.has(db));
        for (const table of rows) group.append(makeChip(db, table));
        if (hidden) {
          const more = el("button", "btn btn--ghost tree-more", `Show all ${list.length.toLocaleString()} tables`);
          more.type = "button";
          more.addEventListener("click", () => { showAll.add(db); render(); });
          group.append(more);
        }
      }
    }
    node.append(group);
    return node;
  }

  function systemNode(items, forced) {
    const node = el("div", "db-node");
    const placed = items.reduce((n, { db }) => n + [...entities.values()].filter((e) => !e.source && e.db === db).length, 0);
    const row = dbRow({ key: SYS, name: "System", glyph: "settings", opened: forced || systemOpen, count: placed, countTitle: `${placed} on the canvas` });
    row.dataset.group = "system";
    row.addEventListener("click", () => { if (!forced) toggleSystem(); });
    node.append(row);
    if (forced || systemOpen) {
      const group = el("div", "db-children");
      group.setAttribute("role", "group");
      for (const item of items) group.append(dbNode(item));
      node.append(group);
    }
    return node;
  }

  const nodeOf = (db) => ({ db, tables: cache.get(db)?.state === "ready" ? cache.get(db).tables : null });

  function render() {
    const focus = focusSnapshot();
    const q = query();
    const frag = document.createDocumentFragment();
    let any = false;
    if (q) {
      const shown = filterTree(dbs.user.map(nodeOf), q);
      for (const item of shown) frag.append(dbNode(item));
      const sysShown = filterTree(dbs.system.filter((db) => includeSystem || cache.get(db)?.state === "ready").map(nodeOf), q);
      if (sysShown.length) frag.append(systemNode(sysShown, true));
      if (!includeSystem && dbs.system.length) {
        const n = el("p", "tree-note", "System not searched.");
        const include = el("button", "btn btn--ghost tree-note__btn", "Include");
        include.type = "button";
        include.addEventListener("click", () => { includeSystem = true; loadForSearch(); render(); });
        n.append(include);
        frag.append(n);
      }
      any = shown.length > 0 || sysShown.length > 0;
    } else {
      for (const db of dbs.user) frag.append(dbNode(nodeOf(db)));
      if (dbs.system.length) frag.append(systemNode(dbs.system.map(nodeOf), false));
      any = true;
    }
    tableList.replaceChildren(frag);
    tableList.querySelector(".db-row")?.setAttribute("id", "db-first");
    emptyEl.hidden = !(q && !any && searchLoading === 0);
    statusEl.hidden = searchLoading === 0;
    statusEl.textContent = searchLoading ? "Searching all databases…" : "";
    rove();
    restoreFocus(focus);
  }

  // ---- focus: one Tab stop for the whole tree (roving tabindex) --------------------------------------------------------------
  // Tab reaches one row; Up / Down / Home / End move between rows (keeping a table's preview or + button); Right opens a database
  // or steps into it, Left folds it or steps out. A table row's own buttons: Left / Right switch between preview and +.
  const rows = () => [...tableList.querySelectorAll(".tree-row")];
  const mainBtn = (row) => (row.matches("button") ? row : row.querySelector(".table-chip__add"));
  const keyOf = (row) => row.dataset.key;
  function rove() {
    const all = rows();
    const active = all.find((r) => keyOf(r) === activeKey) ?? all[0] ?? null;
    activeKey = active ? keyOf(active) : null;
    for (const r of all) {
      const main = mainBtn(r);
      if (r.classList.contains("table-chip")) for (const b of r.querySelectorAll("button")) b.tabIndex = r === active && b === main ? 0 : -1;
      else r.tabIndex = r === active ? 0 : -1;
    }
  }
  function focusSnapshot() {
    const a = document.activeElement;
    const row = a?.closest?.(".tree-row");
    if (!row || !tableList.contains(row)) return null;
    return { key: keyOf(row), peek: a.classList.contains("table-chip__peek") };
  }
  function restoreFocus(s) {
    if (!s) return;
    const row = rows().find((r) => keyOf(r) === s.key);
    if (!row) return;
    (s.peek ? row.querySelector(".table-chip__peek") : mainBtn(row))?.focus({ preventScroll: true });
  }
  const ownerRow = (row) => {
    const node = (row.classList.contains("table-chip") ? row.parentElement : row.parentElement.parentElement).closest(".db-node");
    return node?.querySelector(":scope > .tree-row") ?? null;
  };
  tableList.addEventListener("focusin", (e) => {
    const row = e.target.closest?.(".tree-row");
    if (!row || keyOf(row) === activeKey) return;
    activeKey = keyOf(row);
    rove();
  });
  tableList.addEventListener("keydown", (e) => {
    const btn = e.target.closest?.("button");
    const row = btn?.closest(".tree-row");
    if (!row) return;
    const chip = row.classList.contains("table-chip");
    const all = rows();
    if (e.key === "ArrowLeft") {
      if (chip) {
        e.preventDefault();
        if (btn.classList.contains("table-chip__add")) row.querySelector(".table-chip__peek")?.focus(); else ownerRow(row)?.focus();
      } else if (row.getAttribute("aria-expanded") === "true") { e.preventDefault(); row.click(); }
      else { const up = ownerRow(row); if (up) { e.preventDefault(); up.focus(); } }
      return;
    }
    if (e.key === "ArrowRight") {
      if (chip) { if (btn.classList.contains("table-chip__peek")) { e.preventDefault(); row.querySelector(".table-chip__add")?.focus(); } }
      else if (row.getAttribute("aria-expanded") === "false") { e.preventDefault(); row.click(); }
      else { const next = all[all.indexOf(row) + 1]; if (next && row.parentElement.contains(next)) { e.preventDefault(); mainBtn(next)?.focus(); } }
      return;
    }
    const next = listStep(all.indexOf(row), e.key, all.length);
    if (next === null) return;
    e.preventDefault();
    const target = all[next];
    (chip && btn.classList.contains("table-chip__peek") && target.classList.contains("table-chip") ? target.querySelector(".table-chip__peek") : mainBtn(target))?.focus();
  });

  // ---- search --------------------------------------------------------------------------------------------------------
  function onQuery() {
    searchClosed.clear();
    if (searching()) { if (!primed) { primed = true; loadForSearch(); } }
    else primed = false;
    render();
  }
  searchEl?.addEventListener("input", onQuery);
  searchEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchEl.value) { searchEl.value = ""; onQuery(); }
    // Enter adds the one table the search leaves; Down goes into the tree.
    const chips = tableList.querySelectorAll(".table-chip");
    if (event.key === "Enter" && chips.length === 1) { event.preventDefault(); chips[0].querySelector(".table-chip__add")?.click(); }
    if (event.key === "ArrowDown") { const first = rows()[0]; if (first) { event.preventDefault(); mainBtn(first).focus(); } }
  });

  // ---- on the canvas -------------------------------------------------------------------------------------------------
  // A table already on the canvas says so on its row: the + turns into a check (icon + label + tooltip, never colour alone);
  // pressing it still shows that card (canvas.js reveals and flashes it). Its database row counts the tables it has there.
  function markPlaced() {
    const placed = new Set([...entities.values()].filter((e) => !e.source).map((e) => `${e.db}\u0000${e.table}`));
    for (const chip of tableList.querySelectorAll(".table-chip")) setPlaced(chip, placed.has(`${chip.dataset.db}\u0000${chip.dataset.table}`));
    const sysDbs = new Set(dbs.system);
    const countOf = (row) => [...entities.values()].filter((e) => !e.source && (row.dataset.group === "system" ? sysDbs.has(e.db) : e.db === row.dataset.db)).length;
    for (const row of tableList.querySelectorAll(".db-row[data-db], .db-row[data-group]")) {
      const n = countOf(row);
      const badge = row.querySelector(".db-row__count");
      badge.textContent = n ? String(n) : "";
      badge.title = `${n} on the canvas`;
      badge.hidden = !n;
    }
  }
  const markSoon = () => queueMicrotask(markPlaced); // entity:removed fires before the card leaves the store
  bus.addEventListener("entity:added", markSoon);
  bus.addEventListener("entity:removed", markSoon);

  function makeChip(db, table) {
    const chip = el("div", "tree-row table-chip");
    chip.draggable = true;
    chip.dataset.db = db;
    chip.dataset.table = table;
    chip.dataset.key = `t:${db}\u0000${table}`;
    chip.setAttribute("role", "treeitem");

    // Drag affordance: a grip that shows on hover / keyboard focus (decorative — the + button is the non-drag path).
    const grip = el("span", "table-chip__grip");
    grip.setAttribute("aria-hidden", "true");
    grip.append(icon("grip", { size: 14 }));

    const iconEl = el("span", "table-chip__icon");
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.append(icon("table"));

    const name = el("span", "table-chip__name", table);
    name.title = table;

    // Non-drag fallback (accessibility): add the table to the canvas without dragging. canvas.js listens for `table:add`.
    const add = el("button", "iconbtn table-chip__add");
    add.type = "button";
    add.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("table:add", { detail: { db, table } }));
    });

    // Raw-record preview: the first rows of the table (names, types, sample rows) in a read-only dialog.
    const peek = el("button", "iconbtn table-chip__peek");
    peek.type = "button";
    peek.setAttribute("aria-label", `Preview rows of ${table}`);
    peek.title = "Preview the first rows";
    peek.append(icon("eye"));
    peek.addEventListener("click", () => openTablePreview(db, table));

    chip.addEventListener("dragstart", (event) => {
      // Custom MIME so the canvas accepts our rows only, not arbitrary text/files.
      event.dataTransfer.setData("application/x-ch-table", JSON.stringify({ db, table }));
      event.dataTransfer.effectAllowed = "copy";
      chip.classList.add("table-chip--dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("table-chip--dragging"));

    chip.append(grip, iconEl, name, peek, add);
    setPlaced(chip, [...entities.values()].some((e) => !e.source && e.db === db && e.table === table));
    return chip;
  }

  function setPlaced(chip, placed) {
    if (chip.classList.contains("table-chip--placed") === placed && chip.title) return;
    const table = chip.dataset.table, add = chip.querySelector(".table-chip__add");
    chip.classList.toggle("table-chip--placed", placed);
    chip.title = placed ? `${table} is on the canvas` : `Drag ${table} onto the canvas`;
    add.setAttribute("aria-label", placed ? `${table} is on the canvas — show it` : `Add ${table} to the canvas`);
    add.title = placed ? "On the canvas — show it" : "Add to the canvas (or drag the table)";
    add.replaceChildren(icon(placed ? "check" : "plus"));
  }

  // ---- connection ----------------------------------------------------------------------------------------------------
  function reset() {
    epoch += 1;
    cache.clear();
    dbs = { user: [], system: [] };
    open = new Set(); systemOpen = false; includeSystem = false; primed = false; searchLoading = 0;
    showAll.clear(); searchClosed.clear();
    if (searchEl) searchEl.value = "";
    tableList.replaceChildren();
    emptyEl.hidden = true; statusEl.hidden = true;
    announce();
  }

  async function loadDatabases() {
    reset();
    const mine = epoch;
    try {
      const list = await api.databases();
      if (mine !== epoch) return;
      dbs = splitDatabases(list);
      const placed = [...entities.values()].filter((e) => !e.source).map((e) => e.db);
      const start = initialOpen({ remembered: server ? recallOpen(loadMemory(), server) : null, user: dbs.user, system: dbs.system, placed });
      open = new Set(start.open);
      systemOpen = start.system;
      render();
      announce();
      await runLimited([...open], LOAD_PARALLEL, ensureTables);
    } catch (err) {
      toast(err.message, "danger");
    }
  }

  document.addEventListener("connection:changed", (event) => {
    if (event.detail && event.detail.connected) { server = event.detail; loadDatabases(); }
    else { server = null; reset(); }
  });
}
