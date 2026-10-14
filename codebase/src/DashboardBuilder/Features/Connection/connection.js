import { api } from "../Core/api.js";
import { show, hide, toggle, toast, setPill, fieldError, checkField } from "../Core/ui.js";
import { host, port, text, LIMITS } from "../Core/validate.js";
import { advancedShouldOpen } from "./connection-rules.js";

// The sidebar connection flow (P2, refined). Drives the indicator pill and gates the schema
// browser + canvas. Once connected the form is replaced by a compact summary showing the
// ClickHouse host, with icon actions to change the connection (re-open the form) or disconnect.
export function initConnection() {
  const form = document.getElementById("conn-form");
  if (!form) return;

  const pill = document.getElementById("conn-status");
  const summary = document.getElementById("conn-summary");
  const hostLabel = document.getElementById("conn-host-label");
  const metaLabel = document.getElementById("conn-meta");
  const connectBtn = document.getElementById("conn-connect");
  const cancelBtn = document.getElementById("conn-cancel");
  const changeBtn = document.getElementById("conn-change");
  const disconnectBtn = document.getElementById("conn-disconnect");
  const schemaSection = document.getElementById("schema-section");
  const tablesSection = document.getElementById("tables-section");

  const hostEl = document.getElementById("conn-host");
  const portEl = document.getElementById("conn-port");
  const userEl = document.getElementById("conn-user");
  const passEl = document.getElementById("conn-password");
  const secureEl = document.getElementById("conn-secure");
  const allowCertEl = document.getElementById("conn-allowcert");
  const allowCertRow = document.getElementById("conn-allowcert-row");
  const allowCertWarn = document.getElementById("conn-allowcert-warn");
  const advancedEl = document.getElementById("conn-advanced");

  let current = null; // last connected view, for Cancel-back-to-summary

  // Certificate validation is on by default (P8 hardening). The "trust invalid cert" opt-in only
  // applies to a TLS connection, so hide it when Secure is off; warn while it's checked.
  function syncCertControls() {
    const secure = secureEl.checked;
    toggle(allowCertRow, secure);
    if (!secure) allowCertEl.checked = false;
    toggle(allowCertWarn, secure && allowCertEl.checked);
  }
  secureEl.addEventListener("change", syncCertControls);
  allowCertEl.addEventListener("change", syncCertControls);
  syncCertControls();

  // Advanced stays collapsed for the common (TLS, verified) case; open it when it holds a deviation.
  function syncAdvanced() {
    if (advancedEl) advancedEl.open = advancedShouldOpen({ secure: secureEl.checked, allowInvalidCert: allowCertEl.checked });
  }

  function showForm({ cancellable }) {
    syncAdvanced();
    hide(summary);
    show(form);
    toggle(cancelBtn, cancellable);
    hostEl.focus();
  }

  function applyState(view) {
    const connected = Boolean(view && view.connected);
    current = connected ? view : null;

    if (connected) {
      setPill(pill, "connected", "Connected");
      hostLabel.textContent = view.host;
      hostLabel.title = view.host;
      // Flag a bypassed-certificate connection so the risk stays visible after connecting.
      const transport = view.secure
        ? (view.allowInvalidCertificate ? "TLS, cert unverified" : "TLS")
        : "plain";
      metaLabel.textContent = `${view.user} · ${transport} · :${view.port}`;
      metaLabel.title = view.allowInvalidCertificate
        ? "This connection does not validate the server's TLS certificate." : "";
      // Keep the form controls in step for a later "change connection".
      secureEl.checked = Boolean(view.secure);
      allowCertEl.checked = Boolean(view.allowInvalidCertificate);
      syncCertControls();
      hide(form);
      show(summary);
      hide(cancelBtn);
    } else {
      setPill(pill, "idle", "Idle");
      syncAdvanced();
      show(form);
      hide(summary);
      hide(cancelBtn);
    }

    toggle(schemaSection, connected);
    if (!connected) hide(tablesSection);

    document.dispatchEvent(new CustomEvent("connection:changed", {
      detail: view ?? { connected: false },
    }));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fields = { host: hostEl, port: portEl, user: userEl, password: passEl };
    const values = {
      host: checkField(hostEl, host(hostEl.value)),
      port: checkField(portEl, port(portEl.value)),
      user: checkField(userEl, text(userEl.value, { label: "User", max: LIMITS.user, required: true })),
      password: checkField(passEl, text(passEl.value, { label: "Password", max: LIMITS.password, trim: false })),
    };
    const firstBad = Object.values(fields).find((i) => i.getAttribute("aria-invalid") === "true");
    if (firstBad) { firstBad.focus(); return; }
    // allowInvalidCert only matters under TLS; the server also gates it on `secure`.
    const payload = { ...values, secure: secureEl.checked, allowInvalidCert: secureEl.checked && allowCertEl.checked };

    setPill(pill, "connecting");
    connectBtn.disabled = true;
    try {
      const view = await api.connect(payload);
      applyState(view);
      toast(`Connected to ${view.host}.`, "ok");
    } catch (err) {
      setPill(pill, "failed", "Failed");
      if (err.field && fields[err.field]) fieldError(fields[err.field], err.message);
      else toast(err.message, "danger");
    } finally {
      connectBtn.disabled = false;
    }
  });

  // edit icon: change connection — reveal the form (still connected until a new connect succeeds).
  changeBtn?.addEventListener("click", () => showForm({ cancellable: true }));

  // Cancel out of "change" mode, back to the active connection's summary.
  cancelBtn?.addEventListener("click", () => { if (current) applyState(current); });

  // power icon: disconnect.
  disconnectBtn?.addEventListener("click", async () => {
    try {
      const view = await api.disconnect();
      applyState(view);
      passEl.value = "";
      toast("Disconnected — your tables and dashboards come back when you reconnect.", "info");
    } catch (err) {
      toast(err.message, "danger");
    }
  });

  // Restore state on load: the session may already hold a connection.
  api.getConnection().then(applyState).catch(() => applyState({ connected: false }));
}
