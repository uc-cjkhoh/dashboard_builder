// Writes tests/fixtures/crosstab-totals-golden.json. Run ONCE, against unmodified main code (before "Include totals"):
//   node tests/js/gen-crosstab-golden.mjs
import { writeFileSync } from "node:fs";
import { everyCombo, html } from "./crosstab-cases.mjs";

const out = {};
for (const [k, o] of Object.entries(everyCombo())) out[k] = html(o.name, o);
writeFileSync(new URL("../fixtures/crosstab-totals-golden.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`${Object.keys(out).length} cases written`);
