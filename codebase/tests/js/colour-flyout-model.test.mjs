import { test } from "node:test";
import assert from "node:assert/strict";
import { colourFlyoutGroups } from "../../src/DashboardBuilder/Features/Dashboard/colour-flyout-model.js";

const base = { chartType: "bar", isChart: true, mode: "discrete", borderOn: false, scale: null, steps: false };
const g = (over) => colourFlyoutGroups({ ...base, ...over });

test("a categorical bar: member colours under Color, Opacity alone, Border under Effects", () => {
  assert.deepEqual(g({}), { colour: ["members"], opacity: ["opacity"], effects: ["border"] });
});

test("Colour by category and Reverse palette are gone: no chart or colour mode offers them", () => {
  for (const chartType of ["bar", "scatter", "pie", "heatmap"]) for (const mode of ["none", "discrete", "continuous"]) {
    const c = g({ chartType, mode }).colour;
    assert.ok(!c.includes("colourByCategory") && !c.includes("reverse"), `${chartType}/${mode}`);
  }
});

test("Border colour follows Border once a border is set", () => {
  assert.deepEqual(g({ borderOn: true }).effects, ["border", "borderColour"]);
});

test("Line markers (Effects) only on line, area and combo; Opacity stays its own section", () => {
  for (const chartType of ["line", "area", "combo"]) assert.ok(g({ chartType }).effects.includes("lineMarkers"), chartType);
  const line = g({ chartType: "line" });
  assert.deepEqual(line.effects, ["lineMarkers"]);
  assert.deepEqual(line.opacity, ["opacity"]);
  assert.ok(!g({ chartType: "bar" }).effects.includes("lineMarkers"));
});

test("a measure on Color (sequential): scale block, Limits; no member colours", () => {
  assert.deepEqual(g({ mode: "continuous", scale: "sequential" }).colour, ["scale", "steps", "ramp", "limits"]);
});

test("a diverging scale swaps the ramp for the pair and offers the full range unless Steps is on", () => {
  assert.deepEqual(g({ mode: "continuous", scale: "diverging" }).colour, ["scale", "steps", "pair", "fullRange", "limits"]);
  assert.deepEqual(g({ mode: "continuous", scale: "diverging", steps: true }).colour, ["scale", "steps", "pair", "limits"]);
});

test("a heatmap with nothing on Color still has the scale block and the member colours", () => {
  const r = g({ chartType: "heatmap", mode: "none", scale: "sequential" });
  assert.deepEqual(r.colour, ["scale", "steps", "ramp", "limits", "members"]);
});

test("a pie has Opacity and Border but no Line markers", () => {
  const r = g({ chartType: "pie" });
  assert.deepEqual(r.opacity, ["opacity"]);
  assert.deepEqual(r.effects, ["border"]);
});

test("a table (not a chart) has no Colour controls at all", () => {
  const r = g({ chartType: "table", isChart: false, mode: "none" });
  assert.deepEqual(r, { colour: [], opacity: [], effects: [] });
});
