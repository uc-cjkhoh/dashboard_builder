// Entry point for the browser app. Wires the modules together: connection (below), schema browser,
// canvas/drag-drop, relationships, subtabs.
import { initSidebar } from "./sidebar.js";
import { initConnection } from "../Connection/connection.js";
import { initSchema } from "../Schema/schema.js";
import { initCanvas } from "../Canvas/canvas.js";
import { initRelations } from "../Relations/relations.js";
import { initTabs } from "../Tabs/tabs.js";
import { initDashboards } from "../Dashboard/dashboards.js";
import { initBoard } from "../Board/board.js";
import { initStory } from "../Story/story.js";
import { initWorkbook } from "../Workbook/workbook.js";
import { initBackup } from "../Workbook/backup.js";
import { initTheme } from "../Core/theme.js";
import { initScheme } from "../Core/scheme.js";
import { initAppearance } from "./appearance.js";
import { initPerfPanel } from "./perf-panel.js";
import { initActivityBar } from "./activity-bar.js";
import { toast } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { initHoverTips } from "../Core/hover-tip.js";

// Last-resort handlers: an unexpected error is told to the user, never only logged. Aborted queries are normal.
window.addEventListener("error", (e) => {
  // The browser's benign "ResizeObserver loop completed…" notice carries no error object — not a failure.
  if (!e.error || /ResizeObserver loop/.test(e.message ?? "")) return;
  console.error(e.error); toast("Something went wrong — try again.", "danger");
});
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.name === "AbortError") return;
  console.error(e.reason); toast("Something went wrong — try again.", "danger");
});

// Static markup declares icons as <span data-icon="name">; hydrate them once.
for (const el of document.querySelectorAll("[data-icon]")) el.replaceChildren(icon(el.dataset.icon));

// Schema + canvas + relations + tabs + dashboards first so their `connection:changed` /
// `table:add` / bus listeners are registered before the connection module's initial status
// check fires an event.
initHoverTips(); // one styled tooltip for every button's title: on hover and on keyboard focus
initScheme();  // light / dark (data-scheme) before anything reads it
initAppearance();
initPerfPanel();
initActivityBar(); // names every in-flight request, so a wait is never a guess
initTheme();   // the workbook theme's tokens (default until a workbook opens)
initSidebar();
initSchema();
initCanvas();
initRelations();
initTabs();
initDashboards();
initBoard();
initStory();
initWorkbook(); // restores the saved workbook on the connection:changed event below
initBackup();   // after the workbook: on a connection change it copies what the workbook has just saved
initConnection();
