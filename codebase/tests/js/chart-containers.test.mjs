import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// chart.js keeps one ECharts instance per container. A tiny fake DOM + fake echarts is enough to prove it.
const made = [];
const fakeEl = () => ({ className: "", children: [], style: { setProperty() {} }, clientWidth: 600, clientHeight: 400,
  append(c) { this.children.push(c); } });
globalThis.document = { createElement: fakeEl, documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", left: "0" });
globalThis.ResizeObserver = class { constructor() { this.live = true; made.push(this); } observe() {} disconnect() { this.live = false; } };
const insts = [];
globalThis.window = { echarts: { init: (host, _t, opts) => {
  const i = { host, opts, disposed: false, sizes: [], setOption(o) { this.lastSet = o; }, on() {}, dispatchAction() {}, resize(s) { this.sizes.push(s); },
    dispose() { this.disposed = true; }, getWidth: () => 600, getHeight: () => 400, getDom: () => host };
  insts.push(i); return i; } } };

const { renderChart, disposeChart, hasChartInstance, sizeChart, animateNextChart } =
  await import("../../src/DashboardBuilder/Features/Dashboard/chart.js");
const spec = () => ({ type: "bar", categories: ["a", "b"], series: [{ name: "v", data: [1, 2] }] });
beforeEach(() => { insts.length = 0; });

test("two containers hold two live charts; rendering into one never disposes the other", () => {
  const a = fakeEl(), b = fakeEl();
  renderChart(a, spec()); renderChart(b, spec());
  assert.ok(hasChartInstance(a) && hasChartInstance(b));
  assert.equal(insts.length, 2);
  renderChart(a, spec());
  assert.equal(insts[0].disposed, true, "a's previous chart is disposed");
  assert.equal(insts[1].disposed, false, "b's chart is untouched");
  assert.ok(hasChartInstance(b));
});
test("disposeChart(container) tears down only that container; an unknown container is a no-op", () => {
  const a = fakeEl(), b = fakeEl();
  renderChart(a, spec()); renderChart(b, spec());
  disposeChart(a);
  assert.equal(hasChartInstance(a), false);
  assert.equal(hasChartInstance(b), true);
  disposeChart(fakeEl());
});
test("sizeChart and animateNextChart address one container", () => {
  const a = fakeEl(), b = fakeEl();
  renderChart(a, spec()); renderChart(b, spec());
  sizeChart(a, { width: 10, height: 20 });
  assert.equal(insts[0].sizes.length, 1);
  assert.equal(insts[1].sizes.length, 0);
  animateNextChart(a, false); // no throw; state is per container
});

// The palette order and the member colours belong to the container being drawn (not module-level
// variables overwritten by every render).
const sliceColour = (inst, name) => inst.lastSet.series[0].data.find((d) => d.name === name).itemStyle?.color;
test("member colours are per container and never leak into the next chart", () => {
  const pie = (colours) => ({ type: "pie", categories: ["a", "b"], series: [{ name: "v", data: [1, 2] }], memberColors: colours && new Map(colours), format: {} });
  const a = fakeEl(), b = fakeEl(), c = fakeEl();
  renderChart(a, pie([["a", "#111111"]]));
  renderChart(b, pie([["a", "#222222"], ["b", "#333333"]]));
  renderChart(c, pie(null));
  assert.equal(sliceColour(insts[0], "a"), "#111111");
  assert.equal(sliceColour(insts[0], "b"), undefined, "b's colours do not reach a");
  assert.equal(sliceColour(insts[1], "a"), "#222222");
  assert.equal(sliceColour(insts[1], "b"), "#333333");
  assert.equal(sliceColour(insts[2], "a"), undefined, "a chart without member colours draws none");
});

test("a bar whose Colour field is its own axis field: each bar wears its member's colour (user colour first); without the flag one colour", () => {
  const bars = (extra) => ({ type: "bar", categories: ["a", "b", "c"], series: [{ name: "v", data: [1, 2, 3] }], format: {}, ...extra });
  const fills = (inst) => inst.lastSet.series[0].data.map((d) => d?.itemStyle?.color);
  renderChart(fakeEl(), bars({ colorByCategory: true, memberColors: new Map([["b", "#123456"]]) }));
  const f = fills(insts[0]);
  assert.equal(f[1], "#123456", "a member's own colour");
  assert.ok(f.every(Boolean) && f[0] !== f[2], "every bar coloured, one per member: " + JSON.stringify(f));
  renderChart(fakeEl(), bars({}));
  assert.ok(fills(insts[1]).every((x) => x === undefined), "no flag, no per-bar colour");
});
