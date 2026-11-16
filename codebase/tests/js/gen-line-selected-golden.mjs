// Writes tests/fixtures/line-selected-golden.json. Run ONCE, against unmodified main code (before Line markers "Selected points"):
//   node tests/js/gen-line-selected-golden.mjs
// It records what every line / area / combo case builds with Line markers Automatic, All and None (and beside Label marks Selected, which hands the chart its
// selected marks), plus tuneForSize's sampling for each, so tests/js/line-selected.test.mjs can prove those choices are unchanged byte for byte.
import { writeFileSync } from "node:fs";
import { CASES, snapshot } from "./line-golden-cases.mjs";
import { buildCartesian, tuneForSize } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { MATRIX, LABEL_SELECTED_CASES, sampled } from "./line-selected-cases.mjs";

const out = { matrix: {}, labelSelected: {}, sampling: {} };
for (const name of Object.keys(CASES)) for (const [key, f] of MATRIX) (out.matrix[name] ??= {})[key] = snapshot(name, f);
for (const [name, make] of Object.entries(LABEL_SELECTED_CASES)) for (const [key, f] of MATRIX) (out.labelSelected[name] ??= {})[key] = JSON.parse(JSON.stringify(make(f)));
for (const [key, f] of MATRIX) out.sampling[key] = sampled(buildCartesian, tuneForSize, f);
writeFileSync(new URL("../fixtures/line-selected-golden.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
