import { test } from "node:test";
import assert from "node:assert/strict";
import { summaryTitle, formFromView, secureToggled, trustToggled, certNoteVisible, summaryDetail } from "../../src/DashboardBuilder/Features/Connection/connection-rules.js";

const view = (o = {}) => ({ connected: true, host: "ch1", port: 8443, user: "ann", secure: true, allowInvalidCertificate: false, ...o });

test("summaryTitle carries user, transport and port for the tooltip", () => {
  assert.equal(summaryTitle(view()), "ann · TLS · :8443");
  assert.equal(summaryTitle(view({ secure: false })), "ann · plain · :8443");
  assert.equal(summaryTitle(view({ allowInvalidCertificate: true })), "ann · TLS, certificate not verified · :8443");
});
test("formFromView restores the entered host, port and user", () => {
  assert.deepEqual(formFromView(view({ host: "My.Host", port: 9440 })), { host: "My.Host", port: "9440", user: "ann", secure: true, allowInvalidCert: false });
});

test("Secure off clears Trust, Secure on brings the earlier Trust back", () => {
  let st = { secure: true, trust: true, remembered: true };
  st = secureToggled(st, false);
  assert.deepEqual(st, { secure: false, trust: false, remembered: true });
  st = secureToggled(st, true);
  assert.deepEqual(st, { secure: true, trust: true, remembered: true });
});
test("a Trust the user switched off stays off after Secure goes off and on", () => {
  let st = trustToggled({ secure: true, trust: true, remembered: true }, false);
  assert.deepEqual(st, { secure: true, trust: false, remembered: false });
  st = secureToggled(secureToggled(st, false), true);
  assert.equal(st.trust, false);
});
test("the unchecked-certificate note waits until the user is about to connect or has touched the switch", () => {
  assert.equal(certNoteVisible({ secure: true, trust: true, attempted: false, touched: false }), false);
  assert.equal(certNoteVisible({ secure: true, trust: true, attempted: true, touched: false }), true);
  assert.equal(certNoteVisible({ secure: true, trust: true, attempted: false, touched: true }), true);
  assert.equal(certNoteVisible({ secure: true, trust: false, attempted: true, touched: true }), false);
  assert.equal(certNoteVisible({ secure: false, trust: false, attempted: true, touched: true }), false);
});
test("summaryDetail shows user and port", () => {
  assert.equal(summaryDetail(view()), "ann · :8443");
});
