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
