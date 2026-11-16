// Writes tests/fixtures/gantt-size-golden.json. Run ONCE, against unmodified main code (before "Gantt bar size from Size"):
//   node tests/js/gen-gantt-golden.mjs
import { writeFileSync } from "node:fs";
import { SPECS, snapshot } from "./gantt-golden-cases.mjs";

const out = {};
for (const [k, make] of Object.entries(SPECS)) { out[k] = snapshot(make()); out[`${k}Tall`] = snapshot(make(), 120); }
writeFileSync(new URL("../fixtures/gantt-size-golden.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`${Object.keys(out).length} cases written`);
