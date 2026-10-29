import { api } from "../Core/api.js";
import { icon } from "../Core/icons.js";
import { show, hide, toggle, toast } from "../Core/ui.js";
import { matchTables } from "./table-filter.js";
import { openTablePreview } from "../Rows/rows-dialog.js";
import { openUnionDialog } from "../Rows/union-dialog.js";

// Schema browser (P3): fills the database <select> and renders the selected database's tables
// as draggable chips. Driven by the `connection:changed` event from connection.js — it does
// not touch the connection form. The table list scrolls internally inside its sidebar section.
export function initSchema() {
  const dbSelect = document.getElementById("db-select");
  const tablesSection = document.getElementById("tables-section");
  const tableList = document.getElementById("table-list");
  if (!dbSelect || !tableList) return;
  const searchEl = document.getElementById("table-search");
  const emptyEl = document.getElementById("table-empty");
  let names = []; // tables of the selected database, for the search box

  function applyFilter() {
    const shown = new Set(matchTables(names, searchEl?.value ?? ""));
    for (const chip of tableList.querySelectorAll(".table-chip")) chip.hidden = !shown.has(chip.dataset.table);
    toggle(emptyEl, names.length > 0 && shown.size === 0);
  }
  function clearSearch() {
    if (searchEl) searchEl.value = "";
    names = [];
    hide(emptyEl);
  }
  document.getElementById("union-open")?.addEventListener("click", () => openUnionDialog(dbSelect.value, names));
  searchEl?.addEventListener("input", applyFilter);
  searchEl?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchEl.value) { searchEl.value = ""; applyFilter(); }
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
      for (const db of dbs) dbSelect.add(new Option(db, db));
      tableList.replaceChildren();
      hide(tablesSection);
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
    for (const table of tables) tableList.append(makeChip(db, table));
    applyFilter();
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
    // canvas.js (P4) listens for `table:add`.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "iconbtn";
    add.setAttribute("aria-label", `Add ${table} to the canvas`);
    add.title = "Add to the canvas (or drag the table)";
    add.append(icon("plus"));
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

    chip.title = `Drag ${table} onto the canvas`;
    chip.append(grip, iconEl, name, peek, add);
    return chip;
  }

  dbSelect.addEventListener("change", () => loadTables(dbSelect.value));

  document.addEventListener("connection:changed", (event) => {
    if (event.detail && event.detail.connected) loadDatabases();
    else reset();
  });
}
