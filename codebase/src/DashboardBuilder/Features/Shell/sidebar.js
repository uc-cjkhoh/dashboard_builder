// Resizable, collapsible sidebar. Dragging the right-edge handle sets `--sidebar-w` (which the shell
// grid reads), clamped between a sensible minimum and 30% of the viewport width (Core/resizer.js —
// the same handle as the worksheet field pane). Arrow keys nudge it for keyboard users. The brand-row
// toggle collapses the sidebar to a narrow rail (`.app.is-sidebar-collapsed`) and back; the chosen width is kept while collapsed, and the collapsed state is remembered in this browser.
import { toggle } from "../Core/ui.js";
import { wireResizer } from "../Core/resizer.js";
import { bus, isModelActive, isWorksheetActive } from "../Core/store.js";

const MIN = 240;
const STORAGE_KEY = "dashboardbuilder.sidebar.collapsed";

export function initSidebar() {
  initCollapse();
  initViewFlag();
  const handle = document.getElementById("sidebar-resizer");
  const sidebar = document.querySelector(".sidebar");
  if (!handle || !sidebar) return;
  wireResizer(handle, {
    min: MIN,
    max: () => window.innerWidth * 0.30,
    origin: () => 0, // the sidebar starts at the viewport's left edge
    current: () => sidebar.getBoundingClientRect().width,
    apply: (w) => document.documentElement.style.setProperty("--sidebar-w", `${w}px`),
    active: () => !isCollapsed(), // the rail's width is not the chosen width
  });
}

/** Expand the sidebar if collapsed (e.g. before focusing a control inside it). */
export function expandSidebar() { if (isCollapsed()) applyCollapsed(false); }

let applyCollapsed = () => {};
const isCollapsed = () => document.querySelector(".app")?.classList.contains("is-sidebar-collapsed") ?? false;

function initCollapse() {
  const app = document.querySelector(".app");
  const btn = document.getElementById("sidebar-toggle");
  const body = document.getElementById("sidebar-body");
  const handle = document.getElementById("sidebar-resizer");
  if (!app || !btn || !body) return;

  const apply = (collapsed) => {
    app.classList.toggle("is-sidebar-collapsed", collapsed);
    toggle(body, !collapsed);
    toggle(handle, !collapsed);
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    btn.setAttribute("aria-expanded", String(!collapsed));
    btn.setAttribute("aria-label", label);
    btn.title = label;
  };

  let stored = false;
  try { stored = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* storage blocked — start expanded */ }
  // P41 phone layout: a narrow screen starts on the rail (the sidebar then opens as an overlay); this
  // isn't remembered, so a wide screen keeps the user's own choice.
  apply(stored || matchMedia("(max-width: 640px)").matches);

  applyCollapsed = (collapsed) => {
    apply(collapsed);
    try { localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0"); } catch { /* not remembered — fine */ }
  };
  btn.addEventListener("click", () => applyCollapsed(!isCollapsed()));
}

// The sidebar body follows the tab: `.app[data-view="model"]` shows the connection, database and tables, a worksheet tab shows only the calculated fields and hierarchies there, a dashboard tab a brand-only rail (shell.css).
function initViewFlag() {
  const app = document.querySelector(".app");
  if (!app) return;
  const sync = () => { app.dataset.view = isModelActive() ? "model" : isWorksheetActive() ? "sheet" : "board"; };
  bus.addEventListener("view:changed", sync);
  sync();
}
