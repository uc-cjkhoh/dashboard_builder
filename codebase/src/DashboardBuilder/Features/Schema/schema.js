import { api } from "../Core/api.js";
import { show, hide, toast } from "../Core/ui.js";

// Schema browser (P3): fills the database <select> and renders the selected database's tables
// as draggable chips. Driven by the `connection:changed` event from connection.js — it does
// not touch the connection form. The table list scrolls internally inside its sidebar section.
export function initSchema() {
  const dbSelect = document.getElementById("db-select");
  const tablesSection = document.getElementById("tables-section");
  const tableList = document.getElementById("table-list");
  if (!dbSelect || !tableList) return;

  function reset() {
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
      for (const db of dbs) dbSelect.add(new Option(db, db));
      tableList.replaceChildren();
      hide(tablesSection);
    } catch (err) {
      toast(err.message, "danger");
    }
  }

  async function loadTables(db) {
    tableList.replaceChildren();
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
    for (const table of tables) tableList.append(makeChip(db, table));
  }

  function makeChip(db, table) {
    const chip = document.createElement("div");
    chip.className = "table-chip";
    chip.draggable = true;
    chip.dataset.db = db;
    chip.dataset.table = table;

    const icon = document.createElement("span");
    icon.className = "table-chip__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▦";

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
    add.textContent = "＋";
    add.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("table:add", { detail: { db, table } }));
    });

    chip.addEventListener("dragstart", (event) => {
      // Custom MIME so the canvas accepts our chips only, not arbitrary text/files.
      event.dataTransfer.setData("application/x-ch-table", JSON.stringify({ db, table }));
      event.dataTransfer.effectAllowed = "copy";
      chip.classList.add("table-chip--dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("table-chip--dragging"));

    chip.append(icon, name, add);
    return chip;
  }

  dbSelect.addEventListener("change", () => loadTables(dbSelect.value));

  document.addEventListener("connection:changed", (event) => {
    if (event.detail && event.detail.connected) loadDatabases();
    else reset();
  });
}
