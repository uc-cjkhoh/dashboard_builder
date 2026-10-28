import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// chart.js keeps one ECharts instance per container (P24a). A tiny fake DOM + fake echarts is enough to prove it.
const made = [];
const fakeEl = () => ({ className: "", children: [], style: { setProperty() {} }, clientWidth: 600, clientHeight: 400,
  append(c) { this.children.push(c); } });
globalThis.document = { createElement: fakeEl, documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", left: "0" });
globalThis.ResizeObserver = class { constructor() { this.live = true; made.push(this); } observe() {} disconnect() { this.live = false; } };
const insts = [];
globalThis.window = { echarts: { init: (host, _t, opts) => {
  const i = { host, opts, disposed: false, sizes: [], setOption() {}, on() {}, dispatchAction() {}, resize(s) { this.sizes.push(s); },
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
