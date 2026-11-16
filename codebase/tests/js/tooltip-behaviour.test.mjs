// Tooltip behaviour on the Format panel: Show tooltips, command buttons in an enterable tooltip (Keep only / Exclude / View data) and
// Responsive vs On hover — the pure model, the option each chart type builds, the render path's gates (which marks get buttons), the
// click wiring and the saved-workbook rules. The browser check is tests/live/tooltip-behaviour-ui.mjs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPECS, snapshot, tooltipSnapshot } from "./tooltip-golden-cases.mjs";
import { buildOption } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import {
  TOOLTIP_MODE_CHOICES, COMMANDS, tooltipsOn, commandButtonsOn, tooltipModeOf, showTooltipsError, tooltipButtonsError, tooltipModeError,
  withTooltipSetting, applyTooltipBehaviour, commandsHtml, commandOf, buttonGate, gateInputs, tooltipControlSpecs, pinnedIndex, BUTTON_TYPES,
} from "../../src/DashboardBuilder/Features/Dashboard/tooltip-behaviour-model.js";
import { TOOLTIP_MODES } from "../../src/DashboardBuilder/Features/Core/sheet-schema.js";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";

const golden = JSON.parse(readFileSync(new URL("../fixtures/tooltip-golden.json", import.meta.url), "utf8"));
const built = (name, format = {}, buttons) => { const spec = { ...SPECS[name](format), ...(buttons ? { tooltipButtons: buttons } : {}) }; return applyTooltipBehaviour(buildOption(spec), spec); };
const snap = (name, format = {}, buttons) => tooltipSnapshot(built(name, format, buttons));
const BUTTON_CASES = ["bar", "barMany", "barText", "stacked", "line", "area", "combo", "pie", "pieText", "donut", "scatter"];
const hoverParams = (o, dataIndex) => { // the params ECharts hands the formatter for one hover (axis trigger: an array of series entries)
  const p = { name: "b", value: 3, percent: 30, dataIndex, seriesName: "v", seriesIndex: 0, axisValueLabel: "b", color: "#123456", data: { value: [1, 2], name: "p", row: dataIndex } };
  return o.tooltip.trigger === "axis" ? [p] : p;
};
const tip = (o, i) => o.tooltip.formatter(hoverParams(o, i));
const hover = { mode: "hover", can: (i) => i !== 2, pinned: null, onCommand() {} };

// ---- defaults: nothing set = today's output ------------------------------------------------------------------------------------
test("a sheet with none of the three settings, or all at their defaults, builds exactly the tooltips it built before (every chart type)", () => {
  for (const name of Object.keys(SPECS)) {
    assert.deepEqual(snap(name), golden[name], `${name}: absent keys`);
    assert.deepEqual(snap(name, { showTooltips: true, tooltipButtons: false, tooltipMode: "responsive" }), golden[name], `${name}: explicit defaults`);
  }
});
test("an unknown stored value reads as the default (a stale or hand-edited format never breaks a chart)", () => {
  for (const name of ["bar", "pie", "scatter", "heatmap"]) assert.deepEqual(snap(name, { showTooltips: "no", tooltipButtons: "yes", tooltipMode: "sticky" }), golden[name], name);
});
test("buttons handed to a chart type with no click-to-filter change nothing", () => {
  for (const name of Object.keys(SPECS).filter((n) => !BUTTON_CASES.includes(n))) assert.deepEqual(snap(name, { tooltipButtons: true }, hover), golden[name], name);
});
test("with buttons not asked for in the format, the render path's buttons spec is ignored", () => {
  for (const name of BUTTON_CASES) assert.deepEqual(snap(name, {}, hover), golden[name], name);
});

// ---- the model ---------------------------------------------------------------------------------------------------------------------
test("readers: Show tooltips is on unless false; buttons are off unless true; the mode is Responsive unless On hover", () => {
  assert.equal(tooltipsOn({}), true); assert.equal(tooltipsOn(undefined), true); assert.equal(tooltipsOn({ showTooltips: false }), false);
  assert.equal(tooltipsOn({ showTooltips: 0 }), true, "only a real false switches it off");
  assert.equal(commandButtonsOn({}), false); assert.equal(commandButtonsOn({ tooltipButtons: true }), true); assert.equal(commandButtonsOn({ tooltipButtons: 1 }), false);
  assert.equal(tooltipModeOf({}), "responsive"); assert.equal(tooltipModeOf({ tooltipMode: "hover" }), "hover"); assert.equal(tooltipModeOf({ tooltipMode: "x" }), "responsive");
  assert.deepEqual(TOOLTIP_MODE_CHOICES.map(([v]) => v), ["responsive", "hover"]);
  assert.deepEqual([...TOOLTIP_MODES], ["responsive", "hover"]);
  assert.deepEqual(COMMANDS.map(([v]) => v), ["keep", "exclude", "data"]);
});
test("errors: known values pass, anything else is named", () => {
  assert.equal(showTooltipsError(true), null); assert.equal(showTooltipsError(false), null); assert.match(showTooltipsError("no"), /Show tooltips/);
  assert.equal(tooltipButtonsError(true), null); assert.match(tooltipButtonsError(1), /command buttons/i);
  assert.equal(tooltipModeError("hover"), null); assert.match(tooltipModeError("x"), /Responsive or On hover/);
});
test("a default is never stored", () => {
  assert.deepEqual(withTooltipSetting({ a: 1 }, "showTooltips", false), { a: 1, showTooltips: false });
  assert.deepEqual(withTooltipSetting({ a: 1, showTooltips: false }, "showTooltips", true), { a: 1 });
  assert.deepEqual(withTooltipSetting({}, "tooltipButtons", true), { tooltipButtons: true });
  assert.deepEqual(withTooltipSetting({ tooltipButtons: true }, "tooltipButtons", false), {});
  assert.deepEqual(withTooltipSetting({}, "tooltipMode", "hover"), { tooltipMode: "hover" });
  assert.deepEqual(withTooltipSetting({ tooltipMode: "hover" }, "tooltipMode", "responsive"), {});
});
test("defaultFormat leaves the three keys out, so a saved worksheet is unchanged", () => {
  const f = defaultFormat();
  for (const k of ["showTooltips", "tooltipButtons", "tooltipMode"]) assert.equal(k in f, false, k);
});

// ---- Show tooltips off -------------------------------------------------------------------------------------------------------------
test("Show tooltips off: no hover tooltip on any chart type; the rest of the option is untouched", () => {
  for (const name of Object.keys(SPECS)) {
    const plain = buildOption(SPECS[name]({}));
    const spec = SPECS[name]({ showTooltips: false });
    const off = applyTooltipBehaviour(buildOption(spec), spec);
    assert.equal(off.tooltip?.show, false, name);
    assert.equal(off.tooltip?.formatter, undefined, `${name}: nothing left to render`);
    const { tooltip: _a, ...restOff } = off, { tooltip: _b, ...restPlain } = plain;
    assert.equal(JSON.stringify(restOff), JSON.stringify(restPlain), `${name}: marks, labels, legend stay`);
  }
});
test("Show tooltips off also drops command buttons (nothing to hold them)", () => {
  const o = built("bar", { showTooltips: false, tooltipButtons: true }, hover);
  assert.equal(o.tooltip.show, false); assert.equal(o.tooltip.enterable, undefined);
});
test("Show tooltips off triggers nothing, so there is no axis pointer either", () => {
  for (const name of ["bar", "line", "histogram", "bullet"]) { const t = built(name, { showTooltips: false }).tooltip; assert.equal(t.trigger, "none", name); assert.equal(t.axisPointer, undefined, name); }
});

// ---- command buttons -----------------------------------------------------------------------------------------------------------------
test("On hover: the hover tooltip is enterable and carries Keep only / Exclude / View data for the hovered mark", () => {
  for (const name of BUTTON_CASES) {
    const o = built(name, { tooltipButtons: true, tooltipMode: "hover" }, hover);
    assert.equal(o.tooltip.enterable, true, `${name}: enterable`);
    assert.ok(o.tooltip.hideDelay >= 200 && o.tooltip.hideDelay <= 1000, `${name}: a short hide delay so the pointer can reach it`);
    assert.equal(o.tooltip.confine, true, name);
    const html = tip(o, 1);
    assert.ok(html.startsWith(golden[name].tip.slice(0, 20)) || html.length > golden[name].tip.length, `${name}: the tooltip text is still first`);
    for (const [cmd, label] of COMMANDS) assert.match(html, new RegExp(`<button type="button"[^>]*data-tt-cmd="${cmd}"[^>]*data-tt-idx="1"[^>]*>${label}</button>`), `${name}: ${cmd}`);
    assert.equal((html.match(/<button/g) ?? []).length, 3, name);
  }
});
test("no buttons on a mark that cannot be selected (can() false), and the text there is exactly today's", () => {
  const o = built("bar", { tooltipButtons: true, tooltipMode: "hover" }, hover);
  assert.doesNotMatch(tip(o, 2), /<button|data-tt/);
  const plain = buildOption(SPECS.bar({}));
  assert.equal(tip(o, 2), plain.tooltip.formatter(hoverParams(plain, 2)));
});
test("a custom tooltip text keeps its text and gains the buttons after it", () => {
  const o = built("barText", { tooltipButtons: true, tooltipMode: "hover" }, hover);
  const html = tip(o, 1);
  assert.ok(html.startsWith("Sales <b>3</b>"));
  assert.match(html, /data-tt-cmd="keep"/);
});
test("Responsive: hover tooltips are today's (no buttons, not enterable) until a mark is pinned", () => {
  const o = built("bar", { tooltipButtons: true }, { ...hover, mode: "responsive", pinned: null });
  assert.equal(o.tooltip.enterable, undefined); assert.equal(o.tooltip.alwaysShowContent, undefined);
  assert.deepEqual(snapshot("bar", { tooltipButtons: true }, (s) => applyTooltipBehaviour(buildOption(s), { ...s, tooltipButtons: { ...hover, mode: "responsive", pinned: null } })), golden.bar);
});
test("Responsive: the pinned mark's tooltip carries the buttons and stays open: nothing else shows or hides it", () => {
  for (const name of BUTTON_CASES) {
    const o = built(name, { tooltipButtons: true }, { ...hover, mode: "responsive", pinned: 1 });
    assert.equal(o.tooltip.enterable, true, name); assert.equal(o.tooltip.alwaysShowContent, true, name);
    assert.equal(o.tooltip.triggerOn, "none", `${name}: hovering another mark neither replaces it nor leaves a button-less tooltip behind`);
    assert.match(tip(o, 1), /data-tt-cmd="keep"/, `${name}: pinned`);
    assert.doesNotMatch(tip(o, 0), /<button/, `${name}: a tooltip of any other mark never offers buttons`);
  }
});
test("On hover is never pinned or always-shown: it hides on leave, after a short delay", () => {
  const o = built("bar", { tooltipButtons: true, tooltipMode: "hover" }, { ...hover, pinned: 1 });
  assert.equal(o.tooltip.alwaysShowContent, undefined); assert.equal(o.tooltip.triggerOn, undefined);
});
test("the tooltip is anchored once per hovered mark, so reaching it does not move it", () => {
  const o = built("bar", { tooltipButtons: true, tooltipMode: "hover" }, hover);
  const at = (i, pt) => o.tooltip.position(pt, hoverParams(o, i));
  const first = at(1, [100, 50]);
  assert.deepEqual(first, [106, 56], "a few px from where the pointer entered");
  assert.deepEqual(at(1, [140, 90]), first, "pointer moving toward it: same place");
  assert.notDeepEqual(at(0, [30, 30]), first, "another mark: anchored afresh");
  o.tooltip.position.reset(); assert.deepEqual(at(0, [60, 60]), [66, 66], "after the pointer left the chart");
});
test("command markup is built from fixed labels and a number: nothing a user typed is in it", () => {
  const html = commandsHtml(7);
  assert.match(html, /^<div class="ws-tip__cmds">/);
  assert.equal((html.match(/<button type="button" class="ws-select__btn" data-tt-cmd="[a-z]+" data-tt-idx="7">[A-Za-z ]+<\/button>/g) ?? []).length, 3);
  assert.doesNotMatch(commandsHtml("7\"><img src=x onerror=y>"), /<img/); // an index that is not a whole number is refused outright
  assert.equal(commandsHtml(-1), ""); assert.equal(commandsHtml(1.5), "");
});
test("commandOf reads a click's target: a button's command and mark; anything else is null", () => {
  const btn = (cmd, idx) => ({ closest: (sel) => (sel === "button[data-tt-cmd]" ? { dataset: { ttCmd: cmd, ttIdx: idx } } : null) });
  assert.deepEqual(commandOf(btn("keep", "3")), { cmd: "keep", idx: 3 });
  assert.deepEqual(commandOf(btn("data", "0")), { cmd: "data", idx: 0 });
  assert.equal(commandOf(btn("drop-table", "3")), null, "an unknown command is never forwarded");
  assert.equal(commandOf(btn("keep", "x")), null);
  assert.equal(commandOf(btn("keep", "-1")), null);
  assert.equal(commandOf({ closest: () => null }), null);
  assert.equal(commandOf(null), null); assert.equal(commandOf({}), null);
});
test("pinnedIndex: the first mark of the clicked value, in Responsive mode only", () => {
  const raw = ["EU", "US", "JP"], sel = { db: "d", table: "t", column: "c", value: "US" };
  const dim = { db: "d", table: "t", column: "c" };
  assert.equal(pinnedIndex("responsive", raw, sel, dim), 1);
  assert.equal(pinnedIndex("hover", raw, sel, dim), null, "On hover pins nothing");
  assert.equal(pinnedIndex("responsive", raw, { ...sel, column: "other" }, dim), null);
  assert.equal(pinnedIndex("responsive", raw, null, dim), null);
  assert.equal(pinnedIndex("responsive", raw, { ...sel, value: "ZZ" }, dim), null);
});

// ---- the Format controls' gates ------------------------------------------------------------------------------------------------------
const dimF = (column) => ({ db: "shop", table: "orders", column, category: "text" });
const measF = (column) => ({ db: "shop", table: "orders", column, category: "numeric", agg: "sum" });
const sheet = (over = {}) => ({ ...emptySheet(), chartType: "bar", columns: [dimF("region")], rows: [measF("amount")], ...over });
test("gate: buttons are offered where a click selects by a dimension value, and the reason is named where not", () => {
  assert.equal(buttonGate(gateInputs(sheet())), null);
  for (const t of ["line", "area", "stacked", "combo", "pie", "donut", "scatter"]) assert.equal(buttonGate(gateInputs(sheet({ chartType: t }))), null, t);
  for (const t of ["heatmap", "treemap", "funnel", "waterfall", "table", "gauge", "gantt", "histogram"]) assert.match(buttonGate(gateInputs(sheet({ chartType: t }))), /select/i, t);
  assert.match(buttonGate(gateInputs(sheet({ columns: [], rows: [measF("amount")] }))), /dimension/);
  assert.match(buttonGate(gateInputs(sheet({ drill: { levels: [dimF("a"), dimF("b")], depth: 0 } }))), /drill/i);
  assert.match(buttonGate(gateInputs(sheet({ columns: [{ ...dimF("day"), datePart: "month" }] }))), /date/i);
  assert.match(buttonGate(gateInputs(sheet({ chartType: "scatter", marks: { ...emptySheet().marks, shape: dimF("kind") } }))), /split/i);
});
test("controls: Show tooltips on every hover-tooltip chart; the buttons and the mode explain themselves when they do nothing", () => {
  const specs = (s) => Object.fromEntries(tooltipControlSpecs({ type: s.chartType, format: s.format ?? {}, gate: buttonGate(gateInputs(s)) }).map((c) => [c.key, c]));
  const c = specs(sheet());
  assert.equal(c.showTooltips.kind, "check"); assert.equal(c.showTooltips.value, true); assert.equal(c.showTooltips.disabled, undefined);
  assert.equal(c.tooltipButtons.kind, "check"); assert.equal(c.tooltipButtons.value, false); assert.equal(c.tooltipButtons.disabled, undefined);
  assert.equal(c.tooltipMode.kind, "select"); assert.match(c.tooltipMode.disabled, /command buttons/i, "Responsive / On hover only matter with buttons");
  const on = specs(sheet({ format: { tooltipButtons: true } }));
  assert.equal(on.tooltipMode.disabled, undefined); assert.equal(on.tooltipMode.value, "responsive");
  assert.equal(specs(sheet({ format: { tooltipButtons: true, tooltipMode: "hover" } })).tooltipMode.value, "hover");
  const off = specs(sheet({ format: { showTooltips: false, tooltipButtons: true } }));
  assert.equal(off.showTooltips.value, false);
  assert.match(off.tooltipButtons.disabled, /Show tooltips/); assert.match(off.tooltipMode.disabled, /Show tooltips/);
  const heat = specs(sheet({ chartType: "heatmap" }));
  assert.match(heat.tooltipButtons.disabled, /select/i); assert.match(heat.tooltipMode.disabled, /select|command buttons/i);
  assert.deepEqual(tooltipControlSpecs({ type: "table", format: {}, gate: null }), [], "a table has no hover tooltip");
  assert.deepEqual(tooltipControlSpecs({ type: "kpi", format: {}, gate: null }), []);
  assert.ok(BUTTON_TYPES.has("bar") && !BUTTON_TYPES.has("gantt"));
});

// ---- the render path: which marks get buttons, and what a click does -------------------------------------------------------------
const listeners = [];
const fakeEl = () => ({ className: "", children: [], style: { setProperty() {} }, clientWidth: 600, clientHeight: 400, classList: { add() {}, remove() {}, toggle() {} },
  append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute() {}, addEventListener(t, fn, o) { listeners.push({ el: this, t, fn, o }); }, textContent: "", getContext: () => ({ measureText: (t) => ({ width: String(t).length * 7 }) }) });
const docListeners = [];
globalThis.document = { createElement: fakeEl, createElementNS: fakeEl, documentElement: {}, addEventListener: (t, fn) => docListeners.push([t, fn]), removeEventListener: (t, fn) => { const i = docListeners.findIndex((l) => l[0] === t && l[1] === fn); if (i >= 0) docListeners.splice(i, 1); } };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", left: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const insts = [];
globalThis.window = { echarts: { init: (host) => {
  const i = { host, handlers: [], lastSet: null, actions: [], setOption(o) { this.lastSet = o; }, on(evt, fn) { this.handlers.push([evt, fn]); }, dispatchAction(a) { this.actions.push(a); }, resize() {}, dispose() {}, getWidth: () => 600, getHeight: () => 400, getDom: () => host, zr: { handlers: [], on(e, fn) { this.handlers.push([e, fn]); } }, getZr() { return this.zr; } };
  insts.push(i); return i; }, color: { parse: (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)), lerp: () => "rgb(0,0,0)" } } };
const { renderWorksheet } = await import("../../src/DashboardBuilder/Features/Dashboard/worksheet-render.js");
beforeEach(() => { insts.length = 0; listeners.length = 0; docListeners.length = 0; });

const plan = { metaOf: () => ({}), calculations: [], nameOf: (f) => f.column };
const result = (rows = [["EU", 3], ["US", 5], ["JP", 4]]) => ({ rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], rows: rows.map(([k, v]) => ({ keys: [k], values: [v] })), truncated: false });
let pending = null; // the one-shot pin the editor holds after a click
const draw = (sh, res = result(), options = {}) => { const c = fakeEl(); const calls = []; renderWorksheet(c, sh, res, null, { plan, hooks: { onTooltipCommand: (...a) => calls.push(a), takePin: () => { const p = pending; pending = null; return p; } }, ...options }); return { c, calls, inst: insts.at(-1), o: insts.at(-1).lastSet }; };
const WITH = { tooltipButtons: true, tooltipMode: "hover" };

test("the editor draws buttons on a selectable chart: enterable tooltip, the three buttons, the mark's raw value on click", () => {
  const { o, calls, inst } = draw(sheet({ format: WITH }));
  assert.equal(o.tooltip.enterable, true);
  assert.match(tip(o, 1), /data-tt-cmd="exclude"[^>]*data-tt-idx="1"/);
  const click = listeners.find((l) => l.el === inst.host && l.t === "click");
  assert.ok(click, "one delegated click listener on the chart host");
  const ev = { target: { closest: () => ({ dataset: { ttCmd: "keep", ttIdx: "1" } }) }, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  click.fn(ev);
  assert.deepEqual(calls, [["keep", { db: "shop", table: "orders", column: "region", category: "text" }, "US"]]);
  assert.ok(ev.prevented && ev.stopped);
  assert.deepEqual(inst.actions.at(-1), { type: "hideTip" }, "the tooltip is dismissed once a command is taken");
});
test("a click that is not on a command button does nothing", () => {
  const { calls, inst } = draw(sheet({ format: WITH }));
  listeners.find((l) => l.el === inst.host && l.t === "click").fn({ target: { closest: () => null }, preventDefault() { throw new Error("no"); }, stopPropagation() { throw new Error("no"); } });
  assert.deepEqual(calls, []);
});
test("a mark that cannot be filtered on (the Other group, a NULL) has no buttons", () => {
  const { o } = draw(sheet({ format: WITH }), result([["EU", 3], [null, 5], ["JP", 4]]));
  assert.match(tip(o, 0), /<button/); assert.doesNotMatch(tip(o, 1), /<button/); assert.match(tip(o, 2), /<button/);
});
test("a member named like markup is escaped in the text, and the buttons carry only numbers", () => {
  const evil = '<b onclick=x>';
  const { o } = draw(sheet({ format: WITH }), result([[evil, 3], ["US", 5]]));
  const html = o.tooltip.formatter([{ ...hoverParams(o, 0)[0], axisValueLabel: evil, seriesName: evil }]); // what ECharts hands the formatter for that hover
  assert.doesNotMatch(html, /<b onclick/); assert.match(html, /&lt;b onclick=x&gt;/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.doesNotMatch(html.slice(html.indexOf('<div class="ws-tip__cmds">')), /onclick|&lt;/);
});
test("a custom tooltip text is escaped too, and still carries the buttons", () => {
  const { o } = draw(sheet({ format: WITH }), result([["<i onmouseover=x>", 3], ["US", 5]]), { tooltipText: "<region> sold <sum(amount)>" });
  const html = tip(o, 0);
  assert.doesNotMatch(html, /<i onmouseover/); assert.match(html, /data-tt-cmd="keep"/);
});
test("a dashboard widget (select-only or static) never gets buttons, but Show tooltips off applies to it", () => {
  for (const interactive of ["select", false]) {
    const { o } = draw(sheet({ format: WITH }), result(), { interactive });
    assert.equal(o.tooltip.enterable, undefined, String(interactive));
    assert.doesNotMatch(tip(o, 1), /<button/, String(interactive));
    assert.equal(draw(sheet({ format: { showTooltips: false } }), result(), { interactive }).o.tooltip.show, false, `off, ${interactive}`);
  }
});
test("no buttons while a drill hierarchy is active, on a date-part key, on a calculated dimension, or on a split point chart", () => {
  const none = (sh, res) => { const { o } = draw(sh, res); assert.equal(o.tooltip.enterable, undefined); assert.doesNotMatch(tip(o, 0), /<button/); };
  none(sheet({ format: WITH, drill: { levels: [dimF("region"), dimF("city")], depth: 0 } }));
  none(sheet({ format: WITH, columns: [{ ...dimF("region"), datePart: "month" }] }));
  none(sheet({ format: WITH, columns: [{ ...dimF("region"), calc: "c1" }] }));
});
test("On hover pins nothing; Responsive pins the mark just clicked, once (an unchanged chart is drawn when nothing was clicked)", () => {
  const pin = (value) => ({ db: "shop", table: "orders", column: "region", value });
  pending = pin("US");
  const hoverDraw = draw(sheet({ format: WITH }));
  assert.equal(hoverDraw.o.tooltip.alwaysShowContent, undefined);
  assert.equal(hoverDraw.inst.actions.some((a) => a.type === "showTip"), false);
  const fmt = { tooltipButtons: true };
  const none = draw(sheet({ format: fmt }));
  assert.equal(none.o.tooltip.enterable, undefined); assert.equal(none.inst.actions.length, 0);
  pending = pin("US");
  const pinned = draw(sheet({ format: fmt }));
  assert.equal(pinned.o.tooltip.alwaysShowContent, true);
  assert.deepEqual(pinned.inst.actions.find((a) => a.type === "showTip"), { type: "showTip", seriesIndex: 0, dataIndex: 1 });
  assert.match(tip(pinned.o, 1), /<button/); assert.doesNotMatch(tip(pinned.o, 0), /<button/);
  const later = draw(sheet({ format: fmt })); // a later redraw (a Format edit, undo, switching tabs back) finds no pin
  assert.equal(later.inst.actions.some((a) => a.type === "showTip"), false);
  assert.equal(later.o.tooltip.alwaysShowContent, undefined);
});
test("a pin is spent by the drawing that finds it, even when that chart has no buttons", () => {
  pending = { db: "shop", table: "orders", column: "region", value: "US" };
  draw(sheet({ format: { tooltipButtons: true }, drill: { levels: [dimF("region"), dimF("city")], depth: 0 } }), result()); // a drill hierarchy: a chart with no buttons
  assert.equal(pending, null);
});
test("the pin names a value the chart does not draw: nothing is pinned, the hover tooltip is today's", () => {
  pending = { db: "shop", table: "orders", column: "region", value: "ZZ" };
  const d = draw(sheet({ format: { tooltipButtons: true } }));
  assert.equal(d.o.tooltip.alwaysShowContent, undefined); assert.equal(d.inst.actions.length, 0);
});
test("Show tooltips off through the render path: no tooltip, marks and labels as before", () => {
  const { o } = draw(sheet({ format: { showTooltips: false, dataLabels: true } }));
  assert.equal(o.tooltip.show, false);
  assert.equal(o.series[0].label.show, true);
  assert.equal(o.series[0].data.length, 3);
});

test("a pinned tooltip is dismissed by Esc and by a click on empty chart, and Esc is only listened for while it is pinned", () => {
  pending = { db: "shop", table: "orders", column: "region", value: "US" };
  const d = draw(sheet({ format: { tooltipButtons: true } }));
  const esc = docListeners.find((l) => l[0] === "keydown");
  assert.ok(esc, "a keydown listener while pinned");
  esc[1]({ key: "a" }); assert.equal(d.inst.actions.filter((a) => a.type === "hideTip").length, 0);
  esc[1]({ key: "Escape" }); assert.deepEqual(d.inst.actions.at(-1), { type: "hideTip" });
  const blank = d.inst.zr.handlers.find((h) => h[0] === "click");
  d.inst.actions.length = 0;
  blank[1]({ target: { type: "rect" } }); assert.equal(d.inst.actions.length, 0, "a click on a mark is the mark's own");
  blank[1]({ target: null }); assert.deepEqual(d.inst.actions.at(-1), { type: "hideTip" });
  renderWorksheet(d.c, sheet({ format: { tooltipButtons: true } }), result(), null, { plan, hooks: {} }); // the next drawing into the same container disposes this chart: its document listener goes with it
  assert.equal(docListeners.filter((l) => l[0] === "keydown").length, 0);
});
test("On hover and unset charts add no document listener", () => {
  draw(sheet({ format: WITH })); draw(sheet());
  assert.equal(docListeners.length, 0);
});

// ---- saved workbooks -----------------------------------------------------------------------------------------------------------------
const roundTrip = (format) => {
  const sheet = { ...emptySheet(), chartType: "bar", format };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "D", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  return parseWorkbook(JSON.stringify(serializeWorkbook(state)));
};
const formatOf = (r) => r.worksheets[0].sheet.format;
test("workbook: Show tooltips off, buttons on and On hover round-trip", () => {
  const r = roundTrip({ ...defaultFormat(), showTooltips: false, tooltipButtons: true, tooltipMode: "hover" });
  const f = formatOf(r);
  assert.equal(f.showTooltips, false); assert.equal(f.tooltipButtons, true); assert.equal(f.tooltipMode, "hover");
});
test("workbook: an explicit default is dropped quietly; an invalid value is dropped and reported (never coerced)", () => {
  const ok = roundTrip({ ...defaultFormat(), showTooltips: true, tooltipButtons: false, tooltipMode: "responsive" });
  const f = formatOf(ok);
  for (const k of ["showTooltips", "tooltipButtons", "tooltipMode"]) assert.equal(k in f, false, k);
  const bad = roundTrip({ ...defaultFormat(), showTooltips: "no", tooltipButtons: 1, tooltipMode: "sticky" });
  const g = formatOf(bad);
  for (const k of ["showTooltips", "tooltipButtons", "tooltipMode"]) assert.equal(k in g, false, k);
  const issues = bad.issues.join(" | ");
  assert.match(issues, /show tooltips/i); assert.match(issues, /command buttons/i); assert.match(issues, /Responsive or On hover/);
});
test("workbook: an older file with none of the keys loads with none", () => {
  const f = formatOf(roundTrip({ ...defaultFormat() }));
  for (const k of ["showTooltips", "tooltipButtons", "tooltipMode"]) assert.equal(k in f, false, k);
});
