import { test } from "node:test";
import assert from "node:assert/strict";
import { PATHS } from "../../src/DashboardBuilder/Features/Core/icons.js";
const REQUIRED = ["connection", "database", "table", "key", "link", "filter", "color", "size", "label", "tooltip", "detail",
  "shape", "path", "angle", "drill", "pages", "sort", "format", "export", "import", "more", "grip", "search", "close", "sidebar", "chevron",
  "check", "warning", "error", "info", "refresh", "edit", "power", "plus", "dot",
  "type-number", "type-text", "type-date", "type-bool", "type-other"];
test("every icon the UI needs exists", () => { for (const n of REQUIRED) assert.ok(PATHS[n], n); });
test("paths are plain SVG path data", () => { for (const [n, d] of Object.entries(PATHS)) assert.match(d, /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/, n); });
