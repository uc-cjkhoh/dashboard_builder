import {
  dashboards, isModelActive, activeDashboardId, showModel, createDashboard,
  switchDashboard, renameDashboard, closeDashboard, dashboardHasContent, bus,
} from "../Core/store.js";
import { confirmDialog } from "../Core/ui.js";

// The view strip: a pinned "Data Model" tab (the shared entity canvas) followed by the dashboard
// subtabs and a [+] to add one. Clicking switches the active view; dashboards rename on
// double-click and close with a confirm when they hold widgets. Model tab is never closable.
export function initTabs() {
  const strip = document.getElementById("tabs");
  if (!strip) return;

  bus.addEventListener("tabs:changed", render);
  render();

  function render() {
    strip.replaceChildren();
    strip.append(modelTab());
    for (const dash of dashboards) strip.append(dashboardTab(dash));
    strip.append(addButton());
  }

  function modelTab() {
    const active = isModelActive();
    const el = document.createElement("div");
    el.className = `tab tab--model${active ? " is-active" : ""}`;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(active));
    if (active) el.setAttribute("aria-current", "true");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tab__label";
    label.textContent = "Data Model";
    label.title = "The shared tables + relationships all dashboards are built from";
    label.addEventListener("click", () => showModel());

    el.append(label);
    return el;
  }

  function dashboardTab(dash) {
    const active = activeDashboardId() === dash.id;
    const el = document.createElement("div");
    el.className = `tab${active ? " is-active" : ""}`;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(active));
    if (active) el.setAttribute("aria-current", "true");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tab__label";
    label.textContent = dash.name;
    label.title = "Click to switch, double-click to rename";
    label.addEventListener("click", () => switchDashboard(dash.id));
    label.addEventListener("dblclick", () => beginRename(dash, label));

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab__close";
    close.setAttribute("aria-label", `Close ${dash.name}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => { event.stopPropagation(); requestClose(dash); });

    el.append(label, close);
    return el;
  }

  function addButton() {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tab-add";
    add.setAttribute("aria-label", "Add dashboard");
    add.title = "Add dashboard";
    add.textContent = "+";
    add.addEventListener("click", () => createDashboard());
    return add;
  }

  async function requestClose(dash) {
    if (dashboardHasContent(dash.id)) {
      const ok = await confirmDialog(
        `Close the worksheet “${dash.name}”?`,
        { danger: true, confirmText: "Close" },
      );
      if (!ok) return;
    }
    closeDashboard(dash.id);
  }

  function beginRename(dash, labelEl) {
    const input = document.createElement("input");
    input.className = "tab__rename";
    input.value = dash.name;
    input.setAttribute("aria-label", "Rename dashboard");
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (value) renameDashboard(dash.id, value);
      render();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      else if (event.key === "Escape") { done = true; render(); }
    });
  }
}
