import {
  dashboards, isModelActive, activeDashboardId, showModel, createDashboard,
  switchDashboard, renameDashboard, duplicateDashboard, closeDashboard, dashboardHasContent, bus,
} from "../Core/store.js";
import { icon } from "../Core/icons.js";
import { confirmDialog, toast } from "../Core/ui.js";
import { text, LIMITS } from "../Core/validate.js";

// The view strip: a pinned "Data Model" tab (the shared entity canvas) followed by the dashboard
// subtabs and a [+] to add one. Clicking switches the active view; dashboards rename on
// double-click and close with a confirm when they hold widgets. Model tab is never closable.
export function initTabs() {
  const strip = document.getElementById("tabs");
  if (!strip) return;

  bus.addEventListener("tabs:changed", render);
  // Delegated on the strip, which outlives render(): switching on the first click rebuilds the tabs,
  // so a listener on the old label would never see the double-click.
  strip.addEventListener("dblclick", (event) => {
    const label = event.target.closest?.(".tab__label[data-dash-id]");
    const dash = label && dashboards.find((d) => d.id === label.dataset.dashId);
    if (dash) beginRename(dash, label);
  });
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
    label.dataset.dashId = dash.id;
    label.title = "Click to switch, double-click to rename";
    // Already showing: no switch, so no re-render under a double-click.
    label.addEventListener("click", () => { if (activeDashboardId() !== dash.id) switchDashboard(dash.id); });

    const dup = document.createElement("button");
    dup.type = "button";
    dup.className = "tab__dup";
    dup.setAttribute("aria-label", `Duplicate ${dash.name}`);
    dup.title = "Duplicate worksheet";
    dup.append(icon("duplicate", { size: 14 }));
    dup.addEventListener("click", (event) => {
      event.stopPropagation();
      const r = duplicateDashboard(dash.id);
      if (!r.ok) toast(r.error, "danger");
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab__close";
    close.setAttribute("aria-label", `Close ${dash.name}`);
    close.append(icon("close", { size: 14 }));
    close.addEventListener("click", (event) => { event.stopPropagation(); requestClose(dash); });

    el.addEventListener("keydown", (event) => {
      if (event.target !== label) return;
      if (event.key === "F2" || (event.key === "Enter" && active)) { event.preventDefault(); beginRename(dash, label); }
    });

    el.append(label, dup, close);
    return el;
  }

  function addButton() {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tab-add";
    add.setAttribute("aria-label", "Add dashboard");
    add.title = "Add dashboard";
    add.append(icon("plus"));
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
    input.maxLength = LIMITS.tabName;
    input.setAttribute("aria-label", "Rename dashboard");
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (refocus) => {
      if (done) return;
      done = true;
      const r = text(input.value, { label: "Tab name", max: LIMITS.tabName, required: true });
      if (!r.ok) toast(r.error, "danger"); // keep dash.name
      else renameDashboard(dash.id, r.value);
      render();
      if (refocus) refocusLabel();
    };
    // render() rebuilt the strip — put keyboard focus back on this tab's label.
    const refocusLabel = () => {
      const idx = dashboards.findIndex((d) => d.id === dash.id);
      strip.querySelectorAll(".tab:not(.tab--model) .tab__label")[idx]?.focus();
    };
    input.addEventListener("blur", (event) => commit(!event.relatedTarget)); // Tab/click to another control keeps its focus
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      else if (event.key === "Escape") { done = true; render(); refocusLabel(); }
    });
  }
}
