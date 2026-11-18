import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { show, hide, toggle, toast } from "../Core/ui.js";
import { matchTables, listStep } from "./table-filter.js";
import { entities, bus } from "../Core/store.js";
import { splitDatabases, rememberDb, recallDb, sanitizeDbMemory } from "./schema-model.js";
import { openTablePreview } from "../Rows/rows-dialog.js";

// Schema browser: fills the database <select> and renders the selected database's tables
// as draggable chips. Driven by the `connection:changed` event from connection.js — it does
// not touch the connection form. The table list scrolls internally inside its sidebar section.
// The last database picked per server lives in this browser only (a name, no secrets), so a reload lands back on it.
const DB_KEY = "dashboardbuilder.last-database";
const loadMemory = () => { try { return sanitizeDbMemory(JSON.parse(localStorage.getItem(DB_KEY))); } catch { return {}; } };
const saveMemory = (m) => { try { localStorage.setItem(DB_KEY, JSON.stringify(m)); } catch { /* not remembered — fine */ } };

export function initSchema() {
  const dbSelect = document.getElementById("db-select");
  const tablesSection = document.getElementById("tables-section");
  const tableList = document.getElementById("table-list");
  if (!dbSelect || !tableList) return;
  const searchEl = document.getElementById("table-search");
  const emptyEl = document.getElementById("table-empty");
  let names = []; // tables of the selected database, for the search box
  let server = null; // the connected view, the key for the remembered database

  function applyFilter() {
    const shown = new Set(matchTables(names, searchEl?.value ?? ""));
    for (const chip of tableList.querySelectorAll(".table-chip")) chip.hidden = !shown.has(chip.dataset.table);
    toggle(emptyEl, names.length > 0 && shown.size === 0);
    rove();
  }

  // One Tab stop for the whole list (roving tabindex): Tab reaches one chip's buttons, Up / Down / Home / End move between the
  // visible chips (keeping eye or +), Left / Right switch between a chip's two buttons. The stop follows the last focused chip.
  const visibleChips = () => [...tableList.querySelectorAll(".table-chip:not([hidden])")];
  let activeChip = null;
  function rove(chip = activeChip) {
    const chips = visibleChips();
    activeChip = chips.includes(chip) ? chip : chips[0] ?? null;
    for (const c of tableList.querySelectorAll(".table-chip"))
      for (const b of c.querySelectorAll("button")) b.tabIndex = c === activeChip && b.classList.contains("table-chip__add") ? 0 : -1;
  }
  tableList.addEventListener("focusin", (e) => {
    const chip = e.target.closest?.(".table-chip");
    if (!chip || chip === activeChip) return;
    activeChip = chip;
    for (const c of tableList.querySelectorAll(".table-chip")) for (const b of c.querySelectorAll("button")) b.tabIndex = -1;
    e.target.tabIndex = 0;
  });
  tableList.addEventListener("keydown", (e) => {
    const btn = e.target.closest?.(".table-chip button");
    if (!btn) return;
    const chip = btn.closest(".table-chip");
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const other = chip.querySelector(e.key === "ArrowLeft" ? ".table-chip__peek" : ".table-chip__add");
      if (other && other !== btn) { e.preventDefault(); other.focus(); }
      return;
    }
    const chips = visibleChips();
    const next = listStep(chips.indexOf(chip), e.key, chips.length);
    if (next === null) return;
    e.preventDefault();
    const kind = btn.classList.contains("table-chip__peek") ? ".table-chip__peek" : ".table-chip__add";
    chips[next].querySelector(kind)?.focus();
  });

  // A table already on the canvas says so on its chip: the + turns into a check (icon + label + tooltip, never colour alone);
  // pressing it still shows that card (canvas.js reveals and flashes it).
  function markPlaced() {
    const placed = new Set([...entities.values()].filter((e) => !e.source).map((e) => `${e.db}\u0000${e.table}`));
    for (const chip of tableList.querySelectorAll(".table-chip")) setPlaced(chip, placed.has(`${chip.dataset.db}\u0000${chip.dataset.table}`));
  }
  const markSoon = () => queueMicrotask(markPlaced); // entity:removed fires before the card leaves the store
  bus.addEventListener("entity:added", markSoon);
  bus.addEventListener("entity:removed", markSoon);
  function clearSearch() {
    if (searchEl) searchEl.value = "";
    names = [];
    hide(emptyEl);
  }
  searchEl?.addEventListener("input", applyFilter);
  searchEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchEl.value) { searchEl.value = ""; applyFilter(); }
    // Enter adds the one table the search leaves; Down goes into the list.
    const chips = visibleChips();
    if (event.key === "Enter" && chips.length === 1) { event.preventDefault(); chips[0].querySelector(".table-chip__add")?.click(); }
    if (event.key === "ArrowDown" && chips.length) { event.preventDefault(); chips[0].querySelector(".table-chip__add")?.focus(); }
  });

  function reset() {
    clearSearch();
    dbSelect.replaceChildren();
    tableList.replaceChildren();
    hide(tablesSection);
  }

  async function loadDatabases() {
    try {
      const dbs = await api.databases();
      dbSelect.replaceChildren();
      const placeholder = new Option("Select a database…", "");
      placeholder.disabled = true;
      placeholder.selected = true;
      dbSelect.add(placeholder);
      clearSearch();
      // User databases first; system ones (selectable) under their own heading.
      const { user, system } = splitDatabases(dbs);
      for (const db of user) dbSelect.add(new Option(db, db));
      if (system.length) {
        const group = document.createElement("optgroup");
        group.label = "System";
        for (const db of system) group.append(new Option(db, db));
        dbSelect.add(group);
      }
      tableList.replaceChildren();
      hide(tablesSection);
      const back = server ? recallDb(loadMemory(), server, dbs) : "";
      if (back) { dbSelect.value = back; await loadTables(back); }
    } catch (err) {
      toast(err.message, "danger");
    }
  }

  async function loadTables(db) {
    tableList.replaceChildren();
    clearSearch();
    if (!db) { hide(tablesSection); return; }
    try {
      const tables = await api.tables(db);
      renderChips(db, tables);
      show(tablesSection);
    } catch (err) {
      hide(tablesSection);
      toast(err.message, "danger");
    }
  }

  function renderChips(db, tables) {
    tableList.replaceChildren();
    if (tables.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No tables in this database.";
      tableList.append(empty);
      return;
    }
    names = tables;
    activeChip = null;
    for (const table of tables) tableList.append(makeChip(db, table));
    applyFilter();
    markPlaced();
  }

  function makeChip(db, table) {
    const chip = document.createElement("div");
    chip.className = "table-chip";
    chip.draggable = true;
    chip.dataset.db = db;
    chip.dataset.table = table;

    // Drag affordance: a grip that shows on hover / keyboard focus (decorative — the + button is the
    // non-drag path).
    const grip = document.createElement("span");
    grip.className = "table-chip__grip";
    grip.setAttribute("aria-hidden", "true");
    grip.append(icon("grip", { size: 14 }));

    const iconEl = document.createElement("span");
    iconEl.className = "table-chip__icon";
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.append(icon("table"));

    const name = document.createElement("span");
    name.className = "table-chip__name";
    name.textContent = table;
    name.title = table;

    // Non-drag fallback (accessibility): add the table to the canvas without dragging.
    // canvas.js listens for `table:add`.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "iconbtn table-chip__add";
    add.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("table:add", { detail: { db, table } }));
    });

    // Raw-record preview: the first rows of the table (names, types, sample rows) in a read-only dialog.
    const peek = document.createElement("button");
    peek.type = "button";
    peek.className = "iconbtn table-chip__peek";
    peek.setAttribute("aria-label", `Preview rows of ${table}`);
    peek.title = "Preview the first rows";
    peek.append(icon("eye"));
    peek.addEventListener("click", () => openTablePreview(db, table));

    chip.addEventListener("dragstart", (event) => {
      // Custom MIME so the canvas accepts our chips only, not arbitrary text/files.
      event.dataTransfer.setData("application/x-ch-table", JSON.stringify({ db, table }));
      event.dataTransfer.effectAllowed = "copy";
      chip.classList.add("table-chip--dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("table-chip--dragging"));

    chip.append(grip, iconEl, name, peek, add);
    setPlaced(chip, false);
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

  dbSelect.addEventListener("change", () => {
    if (server && dbSelect.value) saveMemory(rememberDb(loadMemory(), server, dbSelect.value));
    loadTables(dbSelect.value);
  });

  document.addEventListener("connection:changed", (event) => {
    if (event.detail && event.detail.connected) { server = event.detail; loadDatabases(); }
    else { server = null; reset(); }
  });
}
