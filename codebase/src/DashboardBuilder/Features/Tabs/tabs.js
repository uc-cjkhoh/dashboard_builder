import {
  tabs, isModelActive, currentView, showModel, createWorksheet, createDashboard, createStory, tabLimitError,
  switchTab, renameTab, duplicateWorksheet, closeTab, worksheetHasContent, setGroupCollapsed, bus,
} from "../Core/store.js";
import { stripItems, groupKey, fitTabWidth } from "./tab-groups-model.js";
import { dashboardsUsing } from "../Board/board-model.js";
import { dashboardsLinking } from "../Board/nav-model.js";
import { storiesUsing } from "../Story/story-model.js";
import { icon } from "../Core/icons.js";
import { wireMenu } from "../Core/menu.js";
import { confirmDestructive, toast } from "../Core/ui.js";
import { text, LIMITS } from "../Core/validate.js";

// The view strip: a pinned "Data Source" tab (the shared entity canvas) followed by one ordered list of worksheet and
// dashboard / story tabs (each with its kind's icon) and a [+] menu — New worksheet / New dashboard / New story. Clicking switches the active
// view; tabs rename on double-click and close with a confirm when they hold content (a worksheet used by dashboards names
// them). The model tab is never closable.
// One row: tabs shrink (label first, down to the icon) and then the tab list scrolls inside the bar; Data Source and [+] stay put.
// A dashboard that holds worksheets is drawn as a group — the dashboard's tab (with a fold button) + its worksheet tabs under one coloured underline (tab-groups-model.js).
const MIN_TAB_PX = 36; // an inactive tab never narrows past its icon; the list scrolls instead
const ICON_PX = 60; // narrower than this an inactive tab is its icon alone (a clipped sliver of label would only be noise)
const DENSE_PX = 96; // an inactive tab narrower than this drops its duplicate / close buttons (the active tab keeps them)
const KINDS = {
  worksheet: { icon: "chart-bar", noun: "worksheet", title: "New worksheet" },
  dashboard: { icon: "dashboard", noun: "dashboard", title: "New dashboard" },
  story: { icon: "story", noun: "story", title: "New story" },
};

export function initTabs() {
  const strip = document.getElementById("tabs");
  if (!strip) return;

  let lastKey = "";
  bus.addEventListener("tabs:changed", render);
  // Adding or removing a widget changes which worksheets a dashboard owns but emits only "dashboard:changed"; a drag or resize must not rebuild the strip.
  bus.addEventListener("dashboard:changed", () => { if (groupKey(tabs) !== lastKey) render(); });
  new ResizeObserver(() => { const sc = strip.querySelector(".tabs__scroll"); if (!sc) return; fitTabs(sc); revealActive(sc); }).observe(strip);
  // Delegated on the strip, which outlives render(): switching on the first click rebuilds the tabs,
  // so a listener on the old label would never see the double-click.
  strip.addEventListener("dblclick", (event) => {
    // Anywhere on the tab (an icon-only tab's label is 0px wide), except its own buttons.
    const host = event.target.closest?.(".tab:not(.tab--model)");
    if (!host || event.target.closest(".tab__close, .tab__dup, .tab__fold, .tab__rename")) return;
    const label = host.querySelector(".tab__label[data-tab-id]");
    const tab = label && tabs.find((t) => t.id === label.dataset.tabId);
    if (tab) beginRename(tab, label);
  });
  let menuLife = null; // aborts the previous render's [+] menu listeners (they sit on the document)
  render();

  const isActive = (tab) => { const v = currentView(); return v.kind === tab.kind && v.id === tab.id; };

  function render() {
    menuLife?.abort();
    menuLife = new AbortController();
    const kept = strip.querySelector(".tabs__scroll")?.scrollLeft ?? 0; // the rebuild must not throw the scroll position away
    const view = currentView();
    const scroller = document.createElement("div");
    scroller.className = "tabs__scroll";
    for (const item of stripItems(tabs, view.kind === "model" ? null : view.id)) scroller.append(item.kind === "tab" ? tabEl(item.tab) : groupEl(item));
    scroller.addEventListener("wheel", (event) => { // the scrollbar is hidden: a vertical wheel turn scrolls the tabs sideways (as Chrome's strip does)
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && scroller.scrollWidth > scroller.clientWidth) { scroller.scrollLeft += event.deltaY; event.preventDefault(); }
    }, { passive: false });
    strip.replaceChildren(modelTab(), scroller, addMenu(menuLife.signal));
    lastKey = groupKey(tabs);
    fitTabs(scroller);
    scroller.scrollLeft = kept;
    revealActive(scroller);
  }

  /** Chrome-style shrinking: measure the inactive tabs at their natural width (buttons shown, nothing capped), solve for one shared cap (`--tab-w`), and mark a
   *  crowded strip dense. Decided from that natural measurement only, so hiding buttons afterwards cannot flip the answer back. */
  function fitTabs(scroller) {
    strip.classList.remove("tabs--dense", "tabs--icons");
    scroller.style.removeProperty("--tab-w");
    const inactive = [...scroller.querySelectorAll(".tab:not(.is-active):not(.tab--head)")]; // the active tab and a group's dashboard tab are never capped
    const naturals = inactive.map((t) => t.getBoundingClientRect().width);
    const overhead = scroller.scrollWidth - naturals.reduce((a, b) => a + b, 0); // the active tab, group headers, gaps and paddings
    const cap = fitTabWidth(naturals, scroller.clientWidth - overhead, MIN_TAB_PX);
    if (cap === null) return;
    scroller.style.setProperty("--tab-w", `${Math.floor(cap)}px`);
    strip.classList.toggle("tabs--dense", cap < DENSE_PX);
    strip.classList.toggle("tabs--icons", cap < ICON_PX);
  }

  /** Scroll the tab list just enough to show the active tab. By rects on the scroller only: scrollIntoView could scroll the fixed shell. */
  function revealActive(scroller) {
    const tab = scroller.querySelector(".tab.is-active");
    if (!tab) return;
    const t = tab.getBoundingClientRect(), box = scroller.getBoundingClientRect();
    if (t.left < box.left) scroller.scrollLeft += t.left - box.left;
    else if (t.right > box.right) scroller.scrollLeft += t.right - box.right;
  }

  /** A dashboard group: the dashboard's tab heads it (its fold button collapses the group) and its shown worksheet tabs follow, all under one coloured underline. */
  function groupEl({ dashboard, members, shown, hidden, collapsed }) {
    const el = document.createElement("div");
    el.className = "tab-group";
    el.dataset.slot = String(dashboard.groupSlot ?? 1);
    el.dataset.state = collapsed ? "collapsed" : "open";
    el.setAttribute("role", "presentation"); // transparent to assistive tech: the tablist keeps owning every tab (one position count across the strip); the fold button names the group
    el.append(...shown.map((tab) => tabEl(tab, tab === dashboard ? { collapsed, hidden, size: members.length } : null)));
    return el;
  }

  /** The group's collapse toggle, on the dashboard tab: a chevron (down = open) with `aria-expanded`. */
  function foldButton(dashboard, { collapsed, size }) {
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "tab__fold";
    fold.dataset.dashboardId = dashboard.id;
    fold.setAttribute("aria-expanded", String(!collapsed));
    fold.setAttribute("aria-label", `${dashboard.name} group, ${size} ${size === 1 ? "tab" : "tabs"}, ${collapsed ? "collapsed" : "expanded"}`);
    fold.title = collapsed ? "Expand group" : "Collapse group";
    const chevron = icon("chevron", { size: 14 });
    chevron.classList.add("tab__fold-chevron");
    fold.append(chevron);
    fold.addEventListener("click", (event) => {
      event.stopPropagation();
      setGroupCollapsed(dashboard.id, !collapsed);
      strip.querySelector(`.tab__fold[data-dashboard-id="${CSS.escape(dashboard.id)}"]`)?.focus(); // render() rebuilt the strip
    });
    return fold;
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
    label.textContent = "Data Source";
    label.title = "The shared tables + relationships every worksheet is built from";
    label.addEventListener("click", () => showModel());

    el.append(label);
    return el;
  }

  /** One tab. `head` (only for a group's dashboard tab): `{ collapsed, hidden, size }` — adds the fold button and, when collapsed, the hidden count. */
  function tabEl(tab, head = null) {
    const kind = KINDS[tab.kind];
    const active = isActive(tab);
    const el = document.createElement("div");
    el.className = `tab tab--${tab.kind}${active ? " is-active" : ""}${head ? " tab--head" : ""}`;
    if (head) el.dataset.state = head.collapsed ? "collapsed" : "open";
    el.setAttribute("role", "tab");
    el.title = `${tab.name} (${kind.noun})`; // an icon-only tab has no visible name: this is how the pointer finds it
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
    // The whole tab switches (at icon-only width the label button can be 0px wide). Already showing: no switch, so no re-render under a double-click.
    el.addEventListener("click", (event) => {
      if (event.target.closest(".tab__close, .tab__dup, .tab__rename, .tab__fold")) return;
      if (!isActive(tab)) switchTab(tab.id);
    });

    const glyph = icon(kind.icon, { size: 14 });
    glyph.classList.add("tab__kind");

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab__close";
    close.setAttribute("aria-label", `Close ${tab.name}`);
    close.title = `Close ${tab.name}`;
    close.append(icon("close", { size: 14 }));
    close.addEventListener("click", (event) => { event.stopPropagation(); requestClose(tab); });

    el.addEventListener("keydown", (event) => {
      if (event.target !== label) return;
      if (event.key === "F2" || (event.key === "Enter" && active)) { event.preventDefault(); beginRename(tab, label); }
    });

    if (head) el.append(foldButton(tab, head));
    el.append(glyph, label);
    if (head?.collapsed && head.hidden) {
      const count = document.createElement("span");
      count.className = "tab__count";
      count.textContent = String(head.hidden);
      el.append(count);
    }
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

  /** [+]: a menu — New worksheet / New dashboard / New story (keyboard: Enter/Space opens, arrows move, Esc closes). */
  function addMenu(signal) {
    const wrap = document.createElement("div");
    wrap.className = "menu tab-menu";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tab-add";
    add.setAttribute("aria-label", "Add a worksheet, dashboard or story");
    add.title = "Add a worksheet, dashboard or story";
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
        const tab = kind === "dashboard" ? createDashboard() : kind === "story" ? createStory() : createWorksheet();
        if (!tab) { toast(tabLimitError(), "danger"); strip.querySelector(".tab-add")?.focus(); return; } // the menu closed: keep focus on [+]
        strip.querySelector(".tab.is-active .tab__label")?.focus(); // render() rebuilt the strip
      });
      list.append(item);
    }
    wrap.append(add, list);
    wireMenu(add, list, { signal });
    return wrap;
  }

  async function requestClose(tab) {
    const inStories = tab.kind === "story" ? [] : storiesUsing(tabs, tab.id); // a closed worksheet or dashboard leaves the steps that showed it
    const stepNote = inStories.length ? ` Its steps will be removed from ${inStories.length === 1 ? "the story" : "the stories"}: ${inStories.map((s) => s.name).join(", ")}.` : "";
    const linking = tab.kind === "story" ? [] : dashboardsLinking(tabs, tab.id).filter((d) => d.id !== tab.id); // their buttons to this tab are unlinked
    const linkNote = linking.length ? ` Buttons that go to it will be unlinked on: ${linking.map((d) => d.name).join(", ")}.` : "";
    const ask = (message) => confirmDestructive(message, { confirmText: "Close" });
    if (tab.kind === "worksheet") {
      const users = dashboardsUsing(tabs, tab.id);
      if (users.length) {
        if (!(await ask(`Close the worksheet “${tab.name}”? Used on: ${users.map((d) => d.name).join(", ")}. It will be removed from ${users.length === 1 ? "that dashboard" : "those dashboards"}.${stepNote}${linkNote}`))) return;
      } else if (inStories.length || linking.length) {
        if (!(await ask(`Close the worksheet “${tab.name}”?${stepNote}${linkNote}`))) return;
      } else if (worksheetHasContent(tab.id)) {
        if (!(await ask(`Close the worksheet “${tab.name}”?`))) return;
      }
    } else if (tab.kind === "story") {
      if (tab.steps.length && !(await ask(`Close the story “${tab.name}”? The worksheets and dashboards it shows are not affected.`))) return;
    } else if (tab.widgets.length || inStories.length || linking.length) {
      if (!(await ask(`Close the dashboard “${tab.name}”?${tab.widgets.length ? " The worksheets on it are not affected." : ""}${stepNote}${linkNote}`))) return;
    }
    closeTab(tab.id);
  }

  function beginRename(tab, labelEl) {
    const input = document.createElement("input");
    input.className = "tab__rename";
    input.value = tab.name;
    input.maxLength = LIMITS.tabName;
    input.setAttribute("aria-label", `Rename ${KINDS[tab.kind].noun}`);
    labelEl.closest(".tab")?.classList.add("is-renaming"); // an inactive tab is width-capped; the input needs its room
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
      strip.querySelector(`.tab__label[data-tab-id="${CSS.escape(tab.id)}"]`)?.focus(); // by id: groups make the display order differ from `tabs`
    };
    input.addEventListener("blur", (event) => commit(!event.relatedTarget)); // Tab/click to another control keeps its focus
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      else if (event.key === "Escape") { done = true; render(); refocusLabel(); }
    });
  }
}
