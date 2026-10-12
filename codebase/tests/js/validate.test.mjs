import { test } from "node:test";
import assert from "node:assert/strict";
import { host, port, text, number, dateTime, filterValue, range, HOST_MESSAGES, LIMITS }
  from "../../src/DashboardBuilder/Features/Core/validate.js";

const err = (r) => (assert.equal(r.ok, false), r.error);
test("valid hosts pass trimmed", () => {
  for (const h of ["clickhouse.example.com", "10.168.49.13", "localhost", "::1", "[::1]", "ch_1.internal"]) assert.equal(host(h).ok, true, h);
  assert.equal(host("  padded.host ").value, "padded.host");
});
test("invalid hosts say why, with the server's wording", () => {
  assert.equal(err(host("https://h")), HOST_MESSAGES.scheme);
  assert.equal(err(host("h:8443")), HOST_MESSAGES.port);
  assert.equal(err(host("[::1]:8443")), HOST_MESSAGES.port);
  assert.equal(err(host("h/db")), HOST_MESSAGES.path);
  assert.equal(err(host("bad host")), HOST_MESSAGES.invalid);
  assert.equal(err(host("   ")), "Host is required.");
  assert.equal(err(host("a".repeat(LIMITS.host + 1))), "Host must be at most 253 characters.");
});
test("port is a required whole number 1–65535", () => {
  assert.equal(port(" 8443 ").value, 8443);
  assert.equal(err(port("")), "Port is required.");
  for (const p of ["0", "65536", "84.5", "abc", "-1", "1e3"]) assert.equal(err(port(p)), "Port must be a whole number from 1 to 65535.", p);
});
test("text trims, requires and caps", () => {
  assert.equal(text("  Sales ", { label: "Tab name", max: 60, required: true }).value, "Sales");
  assert.equal(err(text("   ", { label: "Tab name", max: 60, required: true })), "Tab name is required.");
  assert.equal(err(text("x".repeat(61), { label: "Tab name", max: 60 })), "Tab name must be at most 60 characters.");
  assert.equal(text(" p ", { label: "Password", max: 256, trim: false }).value, " p ");
});
test("numbers are plain — no locale separators, hex or words", () => {
  assert.equal(number(" -1.5 ").value, -1.5);
  assert.equal(number("1e3").value, 1000);
  for (const n of ["1,5", "1,000", "1 000", "0x10", "NaN", "Infinity", "", "  "]) assert.equal(number(n).ok, false, n);
});
test("dates are ISO and real calendar days", () => {
  assert.equal(dateTime("2024-02-29").value, "2024-02-29");
  assert.equal(dateTime("2024-01-31T10:20").value, "2024-01-31 10:20:00");
  for (const d of ["2023-02-29", "31/01/2024", "2024-13-01", "2024-01-01 25:00"]) assert.equal(dateTime(d).ok, false, d);
});
test("filter values are checked by column category, naming the column", () => {
  assert.match(err(filterValue("numeric", "abc", "amount")), /amount/);
  assert.equal(filterValue("boolean", "TRUE", "flag").value, "true");
  assert.equal(filterValue("text", " a ", "name").value, " a ");
  assert.equal(filterValue("compound", "x", "tags").ok, false);
  assert.equal(filterValue("text", " ", "name").ok, false); // whitespace-only counts as empty
});
test("a range needs From ≤ To", () => {
  assert.match(err(range("numeric", "9", "1", "amount")), /From must be less than or equal to To/);
  assert.deepEqual(range("temporal", "2024-01-01", "2024-02-01", "d").value, ["2024-01-01", "2024-02-01"]);
});
test("a drill hierarchy is capped at 6 levels", () => assert.equal(LIMITS.drillLevels, 6));
