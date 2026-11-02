import { bus, activeStory, tabs, tabById, switchTab, worksheetById, setSteps } from "../Core/store.js";
import { toggle, makeButton, toast } from "../Core/ui.js";
import { icon } from "../Core/icons.js";
import { LIMITS } from "../Core/validate.js";
import { createWorksheetView } from "../Dashboard/worksheet-view.js";
import { planCtx, categoryOf, castOf, sharedResults } from "../Dashboard/dashboards.js";
import { hint } from "../Dashboard/render-dom.js";
import { sizeChart } from "../Dashboard/chart.js";
import { addStep, removeStep, moveStep, setCaption, goTo, offeredTargets, targetKind, stepName, refocusTarget } from "./story-model.js";

// The story tab's body. A story is an ordered list of steps; each step is a caption over a worksheet (drawn here, static: no
// selection or drill) or a link to a dashboard tab. The step on screen is transient UI state (per story, in memory); the steps
// themselves live in the store and the workbook. Only the active story renders — leaving it destroys the worksheet view.
const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
let seq = 0;

export function initStory() {
  const $ = (id) => document.getElementById(id);
  const view = $("story-view");
  if (!view) return;
  const title = $("story-title"), count = $("story-count"), statusEl = $("story-status"), tools = $("story-tools"), addForm = $("story-add"),
    strip = $("story-strip"), panel = $("story-step"), stepTitle = $("story-step-title"), stepTools = $("story-step-tools"),
    caption = $("story-caption"), stage = $("story-stage"), nav = $("story-nav"), empty = $("story-empty");
  const at = new Map();   // story id → the step on screen
  let shownId = null;     // the story whose steps are drawn
  let stageView = null;   // the worksheet view in the stage
  let stageKey = null;    // what the stage shows: "<story id>|<target id>"
  let editing = false;    // the caption editor is open
  let addSig = null;      // what the add row was drawn for
  let statusTimer = 0;

  function status(message, refused = false) {
    clearTimeout(statusTimer);
    const span = h("span", null, message); // a fresh node each time, so an identical message is announced again
    statusEl.replaceChildren(...(refused ? [icon("warning", { size: 14 }), span] : [span]));
    statusEl.classList.toggle("is-refused", refused);
    statusTimer = setTimeout(() => statusEl.replaceChildren(), 8000);
  }

  const current = (story) => { const n = story.steps.length; const i = Math.min(at.get(story.id) ?? 0, Math.max(0, n - 1)); at.set(story.id, i); return i; };
  const commit = (story, steps, index) => { at.set(story.id, index); setSteps(story.id, steps); }; // → story:changed → sync (autosave listens too)

  function destroyStage() { stageView?.destroy(); stageView = null; stageKey = null; stage.replaceChildren(); }

  // --- the step stage: a worksheet's static view, or a dashboard link ---
  function drawStage(story, step) {
    const key = `${story.id}|${step.target}`;
    if (key === stageKey) return;
    destroyStage();
    stageKey = key;
    const kind = targetKind(tabs, step.target), tab = tabById(step.target);
    if (kind === "worksheet") {
      const notice = h("p", "ws-chart-notice story-stage__notice");
      notice.setAttribute("role", "status");
      notice.hidden = true;
      const body = h("div", "story-stage__body ws-chart");
      stage.append(notice, body);
      stageView = createWorksheetView(body, () => ({ dash: worksheetById(step.target), noticeEl: notice, results: sharedResults, plan: planCtx(), categoryOf, castOf }),
        { interactive: false, cancelLabel: () => tab?.name ?? "the worksheet" });
      stageView.run();
    } else if (kind === "dashboard") {
      const box = h("div", "story-stage__link");
      const open = makeButton("", "btn btn--primary story-btn");
      open.append(icon("arrow-right", { size: 14 }), document.createTextNode("Open dashboard"));
      open.setAttribute("aria-label", `Open the dashboard ${tab.name}`);
      open.addEventListener("click", () => switchTab(tab.id));
      box.append(icon("dashboard"), h("p", null, `This step shows the dashboard “${tab.name}”.`), open);
      stage.append(box);
    } else stage.append(hint("This step's tab was closed."));
  }

  // --- the add row ---
  function paintAdd(story) {
    addForm.replaceChildren();
    const offers = offeredTargets(tabs);
    const id = `sa${++seq}`;
    const label = h("label", "story-add__label", "Step shows");
    const select = h("select", "select story-add__select");
    label.htmlFor = select.id = `${id}-t`;
    for (const o of offers) select.append(new Option(`${o.kind === "dashboard" ? "Dashboard" : "Worksheet"}: ${o.name}`, o.id));
    const cap = h("input", "story-add__caption");
    cap.type = "text";
    cap.maxLength = LIMITS.stepCaption;
    cap.id = `${id}-c`;
    cap.setAttribute("aria-label", "Caption for the new step");
    cap.placeholder = "Caption";
    const add = makeButton("", "btn btn--primary story-btn");
    add.type = "submit";
    add.append(icon("plus", { size: 14 }), document.createTextNode("Add step"));
    add.disabled = offers.length === 0;
    const err = h("p", "story-add__error");
    err.setAttribute("role", "alert");
    err.hidden = true;
    addForm.append(label, select, cap, add, err);
    if (!offers.length) { select.disabled = true; select.append(new Option("No worksheets or dashboards yet", "")); }
    addForm.onsubmit = (ev) => {
      ev.preventDefault();
      const r = addStep(story.steps, select.value, cap.value);
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      err.hidden = true;
      addSig = null; // a fresh add row
      commit(story, r.steps, r.index);
      status(`Added step ${r.index + 1}: ${stepName(tabs, r.steps[r.index])}.`);
      $("story-strip").querySelector('[aria-selected="true"]')?.focus();
    };
  }

  // --- the strip (a tablist: arrows, Home / End) ---
  function paintStrip(story, i) {
    strip.replaceChildren();
    toggle(strip, story.steps.length > 0);
    story.steps.forEach((s, n) => {
      const kind = targetKind(tabs, s.target);
      const b = makeButton("", "story-chip");
      b.setAttribute("role", "tab");
      b.id = `story-tab-${n}`;
      b.setAttribute("aria-selected", String(n === i));
      b.setAttribute("aria-controls", "story-step");
      b.tabIndex = n === i ? 0 : -1;
      b.setAttribute("aria-label", `Step ${n + 1} of ${story.steps.length}: ${s.caption || stepName(tabs, s)}`);
      b.title = s.caption || stepName(tabs, s);
      b.append(h("span", "story-chip__n", String(n + 1)), h("span", "story-chip__text", s.caption || stepName(tabs, s)), icon(kind === "dashboard" ? "dashboard" : "chart-bar", { size: 14 }));
      b.addEventListener("click", () => go(story, n, "chip"));
      strip.append(b);
    });
  }
  strip.addEventListener("keydown", (ev) => {
    const story = activeStory();
    if (!story || !story.steps.length) return;
    const how = { ArrowRight: "next", ArrowLeft: "prev", Home: "first", End: "last" }[ev.key];
    if (!how) return;
    ev.preventDefault();
    go(story, goTo(current(story), story.steps.length, how));
    strip.querySelector('[aria-selected="true"]')?.focus();
  });

  /** Show step `n`. `focus` = "chip" (a strip click) | "prev" | "next" (a nav button): keyboard focus ends on a live control, never on a destroyed or now-disabled one. */
  function go(story, n, focus) {
    if (n === current(story) && !editing) return;
    editing = false;
    at.set(story.id, n);
    sync();
    status(`Step ${n + 1} of ${story.steps.length}.`);
    if (focus === "chip") strip.querySelector('[aria-selected="true"]')?.focus();
    else if (focus) { const want = focus === "prev" ? prevBtn : nextBtn, other = focus === "prev" ? nextBtn : prevBtn; (want.disabled ? other : want).focus(); }
  }

  // --- caption + step tools ---
  function paintStep(story, i) {
    const step = story.steps[i];
    toggle(panel, Boolean(step));
    stepTools.replaceChildren();
    if (!step) { editing = false; stepTitle.textContent = ""; caption.replaceChildren(); destroyStage(); return; }
    panel.setAttribute("aria-labelledby", `story-tab-${i}`);
    stepTitle.textContent = `Step ${i + 1} of ${story.steps.length} · ${stepName(tabs, step)}`;
    if (editing) { if (!caption.querySelector("form")) paintEditor(story, i); } // an open editor keeps what was typed through other redraws
    else {
      caption.className = `story-step__caption${step.caption ? "" : " is-empty"}`;
      caption.replaceChildren(document.createTextNode(step.caption || "No caption."));
    }
    const tool = (name, label, onClick, disabled = false, role = name) => {
      const b = makeButton("", "iconbtn story-step__btn");
      b.dataset.tool = role;
      b.append(icon(name, { size: 16 }));
      b.title = label;
      b.setAttribute("aria-label", label);
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    };
    const edit = tool("edit", `Edit the caption of step ${i + 1}`, () => { editing = true; paintStep(story, i); caption.querySelector("textarea")?.focus(); });
    const earlier = tool("arrow-left", `Move step ${i + 1} earlier`, () => {
      const r = moveStep(story.steps, i, -1);
      commit(story, r.steps, r.index); status(`Step moved to position ${r.index + 1}.`); focusMoved("earlier");
    }, i === 0, "earlier");
    const later = tool("arrow-right", `Move step ${i + 1} later`, () => {
      const r = moveStep(story.steps, i, 1);
      commit(story, r.steps, r.index); status(`Step moved to position ${r.index + 1}.`); focusMoved("later");
    }, i === story.steps.length - 1, "later");
    const remove = tool("close", `Remove step ${i + 1}`, () => {
      const steps = removeStep(story.steps, i);
      commit(story, steps, Math.min(i, steps.length - 1)); status(`Removed step ${i + 1}.`);
      (steps.length ? strip.querySelector('[aria-selected="true"]') : addForm.querySelector("select"))?.focus();
    });
    remove.classList.add("iconbtn--danger");
    const open = makeButton("", "btn story-btn");
    open.append(icon("arrow-right", { size: 14 }), document.createTextNode("Open tab"));
    open.setAttribute("aria-label", `Open the tab ${stepName(tabs, step)}`);
    open.addEventListener("click", () => { if (tabById(step.target)) switchTab(step.target); });
    stepTools.append(edit, earlier, later, remove, open);
    drawStage(story, step);
  }
  /** After a move the tools were redrawn: focus the same role, or the enabled opposite when that end was reached. */
  function focusMoved(role) {
    const q = (r) => panel.querySelector(`[data-tool="${r}"]`);
    const target = refocusTarget(role, { earlier: Boolean(q("earlier")?.disabled), later: Boolean(q("later")?.disabled) });
    q(target)?.focus();
  }

  function paintEditor(story, i) {
    const id = `se${++seq}`;
    const form = h("form", "story-edit");
    form.noValidate = true;
    const lab = h("label", "story-edit__label", "Caption");
    const input = h("textarea", "story-edit__input");
    input.id = lab.htmlFor = id;
    input.rows = 3;
    input.maxLength = LIMITS.stepCaption;
    input.value = story.steps[i].caption;
    input.setAttribute("aria-describedby", `${id}-m`);
    const meta = h("p", "story-edit__meta");
    meta.id = `${id}-m`;
    const counter = h("span"), err = h("span", "story-edit__error");
    err.setAttribute("role", "alert");
    meta.append(counter, err);
    const sync = () => { counter.textContent = `${input.value.length} / ${LIMITS.stepCaption}`; };
    input.addEventListener("input", () => { sync(); err.textContent = ""; input.removeAttribute("aria-invalid"); });
    sync();
    const actions = h("div", "story-edit__actions");
    const save = makeButton("Save", "btn btn--primary story-btn");
    save.type = "submit";
    save.setAttribute("aria-label", "Save the caption");
    const cancel = makeButton("Cancel", "btn story-btn");
    cancel.setAttribute("aria-label", "Cancel editing the caption");
    actions.append(save, cancel);
    form.append(lab, input, meta, actions);
    const finish = () => { editing = false; paintStep(story, i); panel.querySelector(`[aria-label^="Edit the caption"]`)?.focus(); };
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const r = setCaption(story.steps, i, input.value);
      if (!r.ok) { err.textContent = r.error; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
      editing = false;
      commit(story, r.steps, i);
      status("Caption updated.");
      panel.querySelector(`[aria-label^="Edit the caption"]`)?.focus();
    });
    cancel.addEventListener("click", finish);
    form.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(); }
      else if (ev.key === "Enter" && ev.ctrlKey) { ev.preventDefault(); form.requestSubmit(); }
    });
    caption.className = "story-step__caption";
    caption.replaceChildren(form);
  }

  // --- Previous / Next ---
  // The nav buttons are built once and updated in place, so keyboard focus is never lost to a redraw.
  const prevBtn = makeButton("", "btn story-btn"), nextBtn = makeButton("", "btn btn--primary story-btn"), posEl = h("span", "story-nav__pos");
  prevBtn.append(icon("arrow-left", { size: 14 }), document.createTextNode("Previous"));
  nextBtn.append(document.createTextNode("Next"), icon("arrow-right", { size: 14 }));
  prevBtn.setAttribute("aria-label", "Previous step");
  nextBtn.setAttribute("aria-label", "Next step");
  nav.append(prevBtn, posEl, nextBtn);
  prevBtn.addEventListener("click", () => { const s = activeStory(); if (s) go(s, goTo(current(s), s.steps.length, "prev"), "prev"); });
  nextBtn.addEventListener("click", () => { const s = activeStory(); if (s) go(s, goTo(current(s), s.steps.length, "next"), "next"); });
  function paintNav(story, i) {
    toggle(nav, story.steps.length > 0);
    prevBtn.disabled = i === 0;
    nextBtn.disabled = i === story.steps.length - 1;
    posEl.textContent = `${i + 1} / ${story.steps.length}`;
  }

  function sync() {
    const story = activeStory();
    toggle(view, Boolean(story));
    if (!story) { destroyStage(); shownId = null; editing = false; addSig = null; return; }
    if (shownId !== story.id) { destroyStage(); shownId = story.id; editing = false; addSig = null; statusEl.replaceChildren(); }
    const i = current(story);
    title.textContent = story.name;
    count.textContent = `${story.steps.length} of ${LIMITS.storySteps} steps`;
    toggle(empty, story.steps.length === 0);
    const offerSig = `${story.id}|${offeredTargets(tabs).map((o) => `${o.id}:${o.name}`).join(",")}|${story.steps.length >= LIMITS.storySteps}`;
    if (offerSig !== addSig) { addSig = offerSig; paintAdd(story); } // keep a half-typed caption while nothing it depends on changed
    paintStrip(story, i);
    paintStep(story, i);
    paintNav(story, i);
  }

  for (const type of ["view:changed", "tabs:changed", "story:changed"]) bus.addEventListener(type, sync);
  // A worksheet edit re-runs the stage when it shows that worksheet; colours are read at render time, so a light / dark or theme flip redraws it.
  bus.addEventListener("worksheet:changed", (ev) => { const s = activeStory(); if (s && stageView && stageKey?.endsWith(`|${ev.detail?.id}`)) stageView.run(); });
  // After a reload the stage may show a hint before its tables' columns arrive: it runs again once they do (as dashboard widgets do).
  let columnsTimer = 0;
  bus.addEventListener("entity:loaded", () => { clearTimeout(columnsTimer); columnsTimer = setTimeout(() => { if (activeStory() && stage.querySelector(".ws-hint")) { stageView?.run(); } }, 100); });
  for (const type of ["scheme:changed", "theme:changed", "parameters:changed"]) bus.addEventListener(type, () => { if (activeStory() && stageView) stageView.run(); });

  const printBtn = makeButton("", "btn story-btn");
  printBtn.append(icon("print", { size: 14 }), document.createTextNode("Print step"));
  printBtn.setAttribute("aria-label", "Print this step");
  printBtn.addEventListener("click", () => { if (!activeStory()?.steps.length) { toast("Add a step first — print shows the current step.", "info"); return; } window.print(); });
  tools.append(printBtn);
  // Print: the chart is drawn at page size (as the worksheet's own print does), then restored.
  window.addEventListener("beforeprint", () => { const b = stage.querySelector(".story-stage__body"); if (activeStory() && b) sizeChart(b, { width: 1000, height: 560 }); });
  window.addEventListener("afterprint", () => { const b = stage.querySelector(".story-stage__body"); if (b) sizeChart(b, null); });
  sync();
}
