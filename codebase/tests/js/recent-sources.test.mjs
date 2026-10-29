import { test } from "node:test";
import assert from "node:assert/strict";
import { remember, forget, sanitize, sourceKey, formValues, MAX_RECENT } from "../../src/DashboardBuilder/Features/Connection/recent-sources.js";

const view = (o = {}) => ({ connected: true, host: "ch1", port: 8443, user: "ann", secure: true, allowInvalidCertificate: false, ...o });

test("remember keeps only non-secret fields, never a password", () => {
  const out = remember([], { ...view(), password: "hunter2", token: "x" });
  assert.deepEqual(out, [{ host: "ch1", port: 8443, user: "ann", secure: true, allowInvalidCert: false }]);
  assert.ok(!JSON.stringify(out).includes("hunter2"));
});
test("most recent first; reconnecting moves the entry to the front without duplicating", () => {
  let l = remember([], view({ host: "a" }));
  l = remember(l, view({ host: "b" }));
  l = remember(l, view({ host: "a" }));
  assert.deepEqual(l.map((e) => e.host), ["a", "b"]);
});
test("same host with another user is a separate source", () => {
  const l = remember(remember([], view()), view({ user: "bob" }));
  assert.equal(l.length, 2);
});
test("capped at MAX_RECENT", () => {
  let l = [];
  for (let i = 0; i < MAX_RECENT + 3; i++) l = remember(l, view({ host: "h" + i }));
  assert.equal(l.length, MAX_RECENT);
  assert.equal(l[0].host, "h" + (MAX_RECENT + 2));
});
test("forget removes by key", () => {
  const l = remember(remember([], view({ host: "a" })), view({ host: "b" }));
  assert.deepEqual(forget(l, sourceKey(l[0])).map((e) => e.host), ["a"]);
});
test("sanitize drops junk, extra fields and out-of-range ports from stored data", () => {
  const out = sanitize([{ host: "ok", port: 1, user: "u", secure: false, allowInvalidCert: true, password: "p" }, { host: "", port: 1, user: "u" }, null, { host: "x", port: 70000, user: "u" }, "str"]);
  assert.deepEqual(out, [{ host: "ok", port: 1, user: "u", secure: false, allowInvalidCert: false }]);
  assert.deepEqual(sanitize("nope"), []);
});
test("allowInvalidCert is only kept under TLS", () => {
  assert.equal(remember([], view({ secure: false, allowInvalidCertificate: true }))[0].allowInvalidCert, false);
  assert.equal(remember([], view({ allowInvalidCertificate: true }))[0].allowInvalidCert, true);
});

test("formValues refills the form with the host exactly as it was entered", () => {
  const l = remember([], view({ host: "My-CH.Example.com", port: 9440, user: "ann", secure: false }));
  assert.deepEqual(formValues(l[0]), { host: "My-CH.Example.com", port: "9440", user: "ann", secure: false, allowInvalidCert: false });
});
test("formValues never returns a blank host for a stored source", () => {
  for (const host of ["10.168.49.13", "[::1]", "ch1"]) assert.equal(formValues(remember([], view({ host }))[0]).host, host);
});
test("a whitespace-only host is not remembered", () => {
  assert.deepEqual(remember([], view({ host: "   " })), []);
});
test("sanitize keeps the stored host verbatim", () => {
  const raw = [{ host: "ch.Example.COM", port: 8443, user: "ann", secure: true, allowInvalidCert: false }];
  assert.equal(sanitize(raw)[0].host, "ch.Example.COM");
});
