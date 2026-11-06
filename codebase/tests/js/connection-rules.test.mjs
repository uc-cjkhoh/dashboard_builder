import { test } from "node:test";
import assert from "node:assert/strict";
import { advancedShouldOpen, summaryTitle, formFromView } from "../../src/DashboardBuilder/Features/Connection/connection-rules.js";

const view = (o = {}) => ({ connected: true, host: "ch1", port: 8443, user: "ann", secure: true, allowInvalidCertificate: false, ...o });

test("advancedShouldOpen only for a deviation", () => {
  assert.equal(advancedShouldOpen({ secure: true, allowInvalidCert: false }), false);
  assert.equal(advancedShouldOpen({ secure: false, allowInvalidCert: false }), true);
});
test("summaryTitle carries user, transport and port for the tooltip", () => {
  assert.equal(summaryTitle(view()), "ann · TLS · :8443");
  assert.equal(summaryTitle(view({ secure: false })), "ann · plain · :8443");
  assert.equal(summaryTitle(view({ allowInvalidCertificate: true })), "ann · TLS, certificate not verified · :8443");
});
test("formFromView restores the entered host, port and user", () => {
  assert.deepEqual(formFromView(view({ host: "My.Host", port: 9440 })), { host: "My.Host", port: "9440", user: "ann", secure: true, allowInvalidCert: false });
});
