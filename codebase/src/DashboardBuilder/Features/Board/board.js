import { bus, activeDashboard, isDashboardActive } from "../Core/store.js";
import { toggle } from "../Core/ui.js";

// The dashboard tab's body. A dashboard's data (widgets, limits, validation, save / open) is complete in Core/store.js,
// Board/board-model.js and Workbook/; the board canvas that edits and draws them replaces this placeholder.
export function initBoard() {
  const view = document.getElementById("board-view");
  const title = document.getElementById("board-title");
  const text = document.getElementById("board-text");
  if (!view || !title || !text) return;

  const sync = () => {
    toggle(view, isDashboardActive());
    const dash = activeDashboard();
    if (!dash) return;
    title.textContent = dash.name;
    const n = dash.widgets.length;
    text.textContent = n ? `${n} widget${n === 1 ? "" : "s"} saved with this dashboard.` : "This dashboard has no worksheets yet.";
  };
  for (const type of ["view:changed", "tabs:changed", "dashboard:changed"]) bus.addEventListener(type, sync);
  sync();
}
