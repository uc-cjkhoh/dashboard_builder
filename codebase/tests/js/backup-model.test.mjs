// Auto-backup, the pure part. Run: node --test tests/js/backup-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_INTERVAL_MS, BACKUP_KEEP, safeSegment, connectionFolder, backupName, isBackupName, newestFirst, namesToPrune, nameLabel,
  hashText, contentHash, decideWrite, parseSettings, serializeSettings, unsupportedReason, describeError,
} from "../../src/DashboardBuilder/Features/Workbook/backup-model.js";

test("the defaults are 10 minutes and 5 copies", () => {
  assert.equal(BACKUP_INTERVAL_MS, 600000);
  assert.equal(BACKUP_KEEP, 5);
});

test("safeSegment keeps letters, digits, dot, dash and underscore only", () => {
  assert.equal(safeSegment("cj_khoh"), "cj_khoh");
  assert.equal(safeSegment("a b/c\\d:e"), "a_b_c_d_e");
  assert.equal(safeSegment("../../etc"), "__.._etc"); // no slash and no leading dot: one harmless name, never ".." itself
  assert.equal(safeSegment(".."), "_");
  assert.equal(safeSegment(""), "_");
  assert.equal(safeSegment(null), "_");
  assert.equal(safeSegment("x".repeat(200)).length, 60);
});

test("a path character in a user name never reaches the folder name", () => {
  const f = connectionFolder({ host: "10.0.0.5", port: 8123, user: "../root/x" });
  assert.ok(!f.includes("/") && !f.includes("\\"));
  assert.ok(!f.startsWith("."));
  assert.equal(connectionFolder({ host: "db.example.com", port: 8443, user: "cj_khoh" }), "db.example.com-8443-cj_khoh");
});

test("backupName is workbook-YYYYMMDD-HHmmss.json in the given zone", () => {
  const ms = Date.UTC(2026, 10, 20, 2, 30, 5); // 02:30:05 UTC
  assert.equal(backupName(ms, "UTC"), "workbook-20261120-023005.json");
  assert.equal(backupName(ms, "Asia/Kuala_Lumpur"), "workbook-20261120-103005.json");
});

test("isBackupName accepts only the app's own names", () => {
  assert.ok(isBackupName("workbook-20261120-103005.json"));
  for (const n of ["workbook-2026-11-20.json", "workbook-20261120-1030.json", "notes.txt", "workbook-20261120-103005.json.bak", "x/workbook-20261120-103005.json", ""]) {
    assert.ok(!isBackupName(n), n);
  }
});

const sample = (n) => Array.from({ length: n }, (_, i) => `workbook-20261120-10${String(i).padStart(2, "0")}00.json`);

test("newestFirst sorts descending and drops names the app didn't write", () => {
  const names = ["readme.txt", ...sample(3), "workbook-2026.json"];
  assert.deepEqual(newestFirst(names), ["workbook-20261120-100200.json", "workbook-20261120-100100.json", "workbook-20261120-100000.json"]);
});

test("namesToPrune keeps the newest 5 and removes the oldest", () => {
  const names = sample(7);
  assert.deepEqual(namesToPrune(names), ["workbook-20261120-100100.json", "workbook-20261120-100000.json"]);
  assert.deepEqual(namesToPrune(sample(5)), []);
  assert.deepEqual(namesToPrune(sample(2)), []);
});

test("namesToPrune never lists a file the app didn't write", () => {
  const names = [...sample(7), "my-notes.json", "workbook-final.json", "photo.png", "workbook-20261120-100000.json.bak"];
  const doomed = namesToPrune(names);
  assert.ok(doomed.every(isBackupName));
  assert.ok(!doomed.includes("my-notes.json") && !doomed.includes("workbook-final.json"));
});

test("nameLabel reads the time out of a name", () => {
  assert.equal(nameLabel("workbook-20261120-103005.json"), "2026-11-20 10:30:05");
  assert.equal(nameLabel("other.json"), "other.json");
});

test("hashText is stable, and differs for different text", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
  assert.notEqual(hashText("abc"), hashText("abc "));
  assert.notEqual(hashText(""), hashText("a"));
});

test("decideWrite: an empty workbook never writes, not even when forced", () => {
  assert.equal(decideWrite({ now: 1, hash: "h", empty: true }).write, false);
  assert.equal(decideWrite({ now: 1, hash: "h", empty: true, force: true }).write, false);
  assert.equal(decideWrite({ now: 1, hash: "h", empty: true }).reason, "empty");
});

test("decideWrite: the same content as the last backup doesn't write, so an idle session rotates nothing", () => {
  const r = decideWrite({ now: 10 * BACKUP_INTERVAL_MS, lastAt: 1, lastHash: "h", hash: "h" });
  assert.deepEqual([r.write, r.reason], [false, "unchanged"]);
});

test("decideWrite: changed content inside the interval waits, and says how long", () => {
  const r = decideWrite({ now: 100000, lastAt: 40000, lastHash: "a", hash: "b" });
  assert.deepEqual([r.write, r.reason, r.wait], [false, "too-soon", BACKUP_INTERVAL_MS - 60000]);
});

test("decideWrite: changed content after the interval writes", () => {
  const r = decideWrite({ now: BACKUP_INTERVAL_MS + 5, lastAt: 5, lastHash: "a", hash: "b" });
  assert.deepEqual([r.write, r.reason], [true, "due"]);
});

test("decideWrite: the first backup ever (no last time) writes at once", () => {
  assert.equal(decideWrite({ now: 5, hash: "b" }).write, true);
});

test("decideWrite: a clock that moved back doesn't hold a backup forever", () => {
  assert.equal(decideWrite({ now: 100, lastAt: 5000, lastHash: "a", hash: "b" }).write, true);
});

test("decideWrite: Back up now writes even unchanged and inside the interval", () => {
  const r = decideWrite({ now: 100, lastAt: 90, lastHash: "h", hash: "h", force: true });
  assert.deepEqual([r.write, r.reason], [true, "forced"]);
});

test("settings round-trip, and a bad entry reads as the defaults", () => {
  const s = { enabled: true, last: { "h-1-u": { at: 5, hash: "x-1" } } };
  assert.deepEqual(parseSettings(serializeSettings(s)), s);
  for (const bad of [null, "", "not json", "[]", "42", '{"enabled":"yes"}']) {
    assert.deepEqual(parseSettings(bad), { enabled: false, last: {} }, String(bad));
  }
  assert.deepEqual(parseSettings('{"enabled":true,"last":{"a":{"at":"x","hash":1},"b":{"at":2,"hash":"y"}}}'), { enabled: true, last: { b: { at: 2, hash: "y" } } });
});

test("unsupportedReason names the missing piece", () => {
  assert.equal(unsupportedReason({ hasPicker: true, secure: true }), "");
  assert.match(unsupportedReason({ hasPicker: false, secure: true }), /Chrome or Edge/);
  assert.match(unsupportedReason({ hasPicker: true, secure: false }), /https/);
});

test("describeError: cancelling the picker is silent, others have words", () => {
  assert.equal(describeError({ name: "AbortError" }), "");
  assert.match(describeError({ name: "NotAllowedError" }), /allow/);
  assert.match(describeError({ name: "SecurityError" }), /pick another/);
  assert.match(describeError({ name: "QuotaExceededError" }), /full/);
  assert.equal(describeError(new Error("odd thing.")), "odd thing");
});

test("contentHash ignores savedAt and the Data Source view, so zooming or panning is not a change worth a backup", () => {
  const wb = (savedAt, view) => JSON.stringify({ format: "x", version: 2, savedAt, entities: [], tabs: [], ...(view ? { view } : {}), theme: { accent: "signal" } });
  const base = contentHash(wb("2026-11-25T01:00:00.000Z", { zoom: 1, pan: { x: 0, y: 0 } }));
  assert.equal(contentHash(wb("2026-11-25T09:30:00.000Z", { zoom: 0.5, pan: { x: -40, y: 12 } })), base);
  assert.equal(contentHash(wb("2026-11-25T09:30:00.000Z")), base);
  assert.notEqual(contentHash(wb("2026-11-25T01:00:00.000Z").replace('"entities":[]', '"entities":[{"id":"a"}]')), base);
  assert.notEqual(contentHash(wb("2026-11-25T01:00:00.000Z").replace("signal", "teal")), base);
});
