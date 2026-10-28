import {
  tabs, isModelActive, currentView, showModel, createWorksheet, createDashboard, tabLimitError,
  switchTab, renameTab, duplicateWorksheet, closeTab, worksheetHasContent, bus,
} from "../Core/store.js";
import { dashboardsUsing } from "../Board/board-model.js";
import { icon } from "../Core/icons.js";
import { wireMenu } from "../Core/menu.js";
import { confirmDialog, toast } from "../Core/ui.js";
import { text, LIMITS } from "../Core/validate.js";

// The view strip: a pinned "Data Model" tab (the shared entity canvas) followed by one ordered list of worksheet and
// dashboard tabs (each with its kind's icon) and a [+] menu — New worksheet / New dashboard. Clicking switches the active
// view; tabs rename on double-click and close with a confirm when they hold content (a worksheet used by dashboards names
// them). The model tab is never closable.
const KINDS = {
  worksheet: { icon: "chart-bar", noun: "worksheet", title: "New worksheet" },
  dashboard: { icon: "dashboard", noun: "dashboard", title: "New dashboard" },
};

export function initTabs() {
  const strip = document.getElementById("tabs");
  if (!strip) return;

  bus.addEventListener("tabs:changed", render);
  // Delegated on the strip, which outlives render(): switching on the first click rebuilds the tabs,
  // so a listener on the old label would never see the double-click.
  strip.addEventListener("dblclick", (event) => {
    const label = event.target.closest?.(".tab__label[data-tab-id]");
    const tab = label && tabs.find((t) => t.id === label.dataset.tabId);
    if (tab) beginRename(tab, label);
  });
  let menuLife = null; // aborts the previous render's [+] menu listeners (they sit on the document)
  render();

  const isActive = (tab) => { const v = currentView(); return v.kind === tab.kind && v.id === tab.id; };

  function render() {
    menuLife?.abort();
    menuLife = new AbortController();
    strip.replaceChildren();
    strip.append(modelTab());
    for (const tab of tabs) strip.append(tabEl(tab));
    strip.append(addMenu(menuLife.signal));
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
    label.title = "The shared tables + relationships every worksheet is built from";
    label.addEventListener("click", () => showModel());

    el.append(label);
    return el;
  }

  function tabEl(tab) {
    const kind = KINDS[tab.kind];
    const active = isActive(tab);
    const el = document.createElement("div");
    el.className = `tab tab--${tab.kind}${active ? " is-active" : ""}`;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(active));
    if (active) el.setAttribute("aria-current", "true");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tab__label";
    label.textContent = tab.name;
    label.dataset.tabId = tab.id;
    label.dataset.kind = tab.kind;
    label.setAttribute("aria-label", `${tab.name} (${kind.noun})`); // the kind is part of the accessible name; the icon is decoration
    label.title = "Click to switch, double-click to rename";
    // Already showing: no switch, so no re-render under a double-click.
    label.addEventListener("click", () => { if (!isActive(tab)) switchTab(tab.id); });

    const glyph = icon(kind.icon, { size: 14 });
    glyph.classList.add("tab__kind");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab__close";
    close.setAttribute("aria-label", `Close ${tab.name}`);
    close.append(icon("close", { size: 14 }));
    close.addEventListener("click", (event) => { event.stopPropagation(); requestClose(tab); });

    el.addEventListener("keydown", (event) => {
      if (event.target !== label) return;
      if (event.key === "F2" || (event.key === "Enter" && active)) { event.preventDefault(); beginRename(tab, label); }
    });

    el.append(glyph, label);
    if (tab.kind === "worksheet") { // a dashboard is not duplicated (its widgets would share worksheets and layout — build another)
      const dup = document.createElement("button");
      dup.type = "button";
      dup.className = "tab__dup";
      dup.setAttribute("aria-label", `Duplicate ${tab.name}`);
      dup.title = "Duplicate worksheet";
      dup.append(icon("duplicate", { size: 14 }));
      dup.addEventListener("click", (event) => {
        event.stopPropagation();
        const r = duplicateWorksheet(tab.id);
        if (!r.ok) toast(r.error, "danger");
        else strip.querySelector(".tab.is-active .tab__label")?.focus(); // render() rebuilt the strip
      });
      el.append(dup);
    }
    el.append(close);
    return el;
  }

  /** [+]: a menu — New worksheet / New dashboard (keyboard: Enter/Space opens, arrows move, Esc closes). */
  function addMenu(signal) {
    const wrap = document.createElement("div");
    wrap.className = "menu tab-menu";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tab-add";
    add.setAttribute("aria-label", "Add a worksheet or dashboard");
    add.title = "Add a worksheet or dashboard";
    add.append(icon("plus"));
    const list = document.createElement("div");
    list.className = "menu__list menu__list--start tab-menu__list";
    list.setAttribute("role", "menu");
    list.setAttribute("aria-label", "New tab");
    list.hidden = true;
    for (const [kind, k] of Object.entries(KINDS)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu__item";
      item.setAttribute("role", "menuitem");
      item.dataset.newTab = kind;
      item.append(icon(k.icon), k.title);
      item.addEventListener("click", () => {
        const tab = kind === "dashboard" ? createDashboard() : createWorksheet();
        if (!tab) { toast(tabLimitError(), "danger"); return; }
        strip.querySelector(".tab.is-active .tab__label")?.focus(); // render() rebuilt the strip
      });
      list.append(item);
    }
    wrap.append(add, list);
    wireMenu(add, list, { signal });
    return wrap;
  }

  async function requestClose(tab) {
    if (tab.kind === "worksheet") {
      const users = dashboardsUsing(tabs, tab.id);
      if (users.length) {
        const ok = await confirmDialog(
          `Close the worksheet “${tab.name}”? Used on: ${users.map((d) => d.name).join(", ")}. It will be removed from ${users.length === 1 ? "that dashboard" : "those dashboards"}.`,
          { danger: true, confirmText: "Close" },
        );
        if (!ok) return;
      } else if (worksheetHasContent(tab.id)) {
        const ok = await confirmDialog(`Close the worksheet “${tab.name}”?`, { danger: true, confirmText: "Close" });
        if (!ok) return;
      }
    } else if (tab.widgets.length) {
      const ok = await confirmDialog(`Close the dashboard “${tab.name}”? The worksheets on it are not affected.`, { danger: true, confirmText: "Close" });
      if (!ok) return;
    }
    closeTab(tab.id);
  }

  function beginRename(tab, labelEl) {
    const input = document.createElement("input");
    input.className = "tab__rename";
    input.value = tab.name;
    input.maxLength = LIMITS.tabName;
    input.setAttribute("aria-label", `Rename ${KINDS[tab.kind].noun}`);
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (refocus) => {
      if (done) return;
      done = true;
      const r = text(input.value, { label: "Tab name", max: LIMITS.tabName, required: true });
      if (!r.ok) toast(r.error, "danger"); // keep tab.name
      else renameTab(tab.id, r.value);
      render();
      if (refocus) refocusLabel();
    };
    // render() rebuilt the strip — put keyboard focus back on this tab's label.
    const refocusLabel = () => {
      const idx = tabs.findIndex((t) => t.id === tab.id);
      strip.querySelectorAll(".tab:not(.tab--model) .tab__label")[idx]?.focus();
    };
    input.addEventListener("blur", (event) => commit(!event.relatedTarget)); // Tab/click to another control keeps its focus
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      else if (event.key === "Escape") { done = true; render(); refocusLabel(); }
    });
  }
}
