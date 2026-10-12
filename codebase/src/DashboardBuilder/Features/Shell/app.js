// Entry point for the browser app. Modules are wired in their build-plan phases:
// connection (P2, below), schema browser (P3), canvas/drag-drop (P4), relationships (P5),
// subtabs (P6).
import { initSidebar } from "./sidebar.js";
import { initConnection } from "../Connection/connection.js";
import { initSchema } from "../Schema/schema.js";
import { initCanvas } from "../Canvas/canvas.js";
import { initRelations } from "../Relations/relations.js";
import { initTabs } from "../Tabs/tabs.js";
import { initDashboards } from "../Dashboard/dashboards.js";
import { initWorkbook } from "../Workbook/workbook.js";
import { toast } from "../Core/ui.js";
import { icon } from "../Core/icons.js";

// Last-resort handlers: an unexpected error is told to the user, never only logged. Aborted queries are normal.
window.addEventListener("error", (e) => { console.error(e.error ?? e.message); toast("Something went wrong — try again.", "danger"); });
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.name === "AbortError") return;
  console.error(e.reason); toast("Something went wrong — try again.", "danger");
});

// Static markup declares icons as <span data-icon="name">; hydrate them once.
for (const el of document.querySelectorAll("[data-icon]")) el.replaceChildren(icon(el.dataset.icon));

// Schema + canvas + relations + tabs + dashboards first so their `connection:changed` /
// `table:add` / bus listeners are registered before the connection module's initial status
// check fires an event.
initSidebar();
initSchema();
initCanvas();
initRelations();
initTabs();
initDashboards();
initWorkbook(); // restores the saved workbook on the connection:changed event below
initConnection();
