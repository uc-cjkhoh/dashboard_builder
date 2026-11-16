import { icon } from "../Core/icons.js";
import { api } from "../Core/api.js";
import { show, hide, toggle, toast, fieldError, clearFieldError, checkField, confirmDialog } from "../Core/ui.js";
import { host, port, text, LIMITS } from "../Core/validate.js";
import { summaryTitle, summaryDetail, formFromView, secureToggled, trustToggled, certNoteVisible } from "./connection-rules.js";
import { nextHealth, initialHealth, readProbe, HEALTH_TEXT, PING_EVERY_MS } from "./connection-health.js";
import { remember, forget, sanitize, sourceKey, formValues } from "./recent-sources.js";

// Recent sources live in this browser only (localStorage) and hold no secrets — see recent-sources.js.
const RECENT_KEY = "dashboardbuilder.recent-sources";
const loadRecent = () => { try { return sanitize(JSON.parse(localStorage.getItem(RECENT_KEY))); } catch { return []; } };
const saveRecent = (list) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* not remembered — fine */ } };

// The connection flow. Gates the schema browser + canvas. The form sits on the Data Source start card (with recent connections
// beside it) while disconnected; failures show as a field error or a toast. Once connected, the sidebar's Connections tile shows a
// compact summary — the ClickHouse host (user, transport and port in its tooltip), with icon buttons to change the connection
// (re-opens the start card over the canvas, with Cancel / Esc back) or disconnect.
export function initConnection() {
  const form = document.getElementById("conn-form");
  if (!form) return;

  const section = document.getElementById("conn-section");
  const sectionTitle = document.getElementById("conn-title");
  const summary = document.getElementById("conn-summary");
  const hostLabel = document.getElementById("conn-host-label");
  const statusEl = document.getElementById("conn-status");
  const healthText = document.getElementById("conn-health-text");
  const lostRow = document.getElementById("conn-lost");
  const retryBtn = document.getElementById("conn-retry");
  const connectBtn = document.getElementById("conn-connect");
  const cancelBtn = document.getElementById("conn-cancel");
  const changeBtn = document.getElementById("conn-change");
  const disconnectBtn = document.getElementById("conn-disconnect");
  const schemaSection = document.getElementById("schema-section");
  const tablesSection = document.getElementById("tables-section");
  const divider = document.getElementById("sidebar-divider");
  const dbHeading = document.getElementById("db-heading");

  const hostEl = document.getElementById("conn-host");
  const portEl = document.getElementById("conn-port");
  const userEl = document.getElementById("conn-user");
  const passEl = document.getElementById("conn-password");
  const secureEl = document.getElementById("conn-secure");
  const allowCertEl = document.getElementById("conn-allowcert");
  const allowCertRow = document.getElementById("conn-allowcert-row");
  const allowCertWarn = document.getElementById("conn-allowcert-warn");
  const detailLabel = document.getElementById("conn-detail-label");
  const errorEl = document.getElementById("conn-error");

  // Recent connections sit on the Data Source start card's left panel (Canvas/_Canvas.cshtml), shown whenever the form is.
  const recentPanel = document.getElementById("start-recent-panel");
  const recentEl = document.getElementById("conn-recent");
  const recentNone = document.getElementById("conn-recent-none");
  let recent = loadRecent();

  function renderRecent() {
    if (!recentEl) return;
    recentEl.replaceChildren(...recent.map((e) => {
      const li = document.createElement("li");
      li.className = "conn-recent__item";
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "conn-recent__pick";
      pick.dataset.key = sourceKey(e);
      const h = document.createElement("span");
      h.className = "conn-summary__host"; h.textContent = e.host;
      const m = document.createElement("span");
      m.className = "conn-recent__meta"; m.textContent = `${e.user} · ${e.port}`;
      pick.title = `${e.host} · ${e.user} · :${e.port}`;
      pick.append(h, m);
      pick.addEventListener("click", () => {
        fillForm(formValues(e));
        for (const i of [hostEl, portEl, userEl, passEl]) clearFieldError(i);
        syncCertControls();
        passEl.value = ""; passEl.focus();
      });
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "iconbtn conn-summary__btn conn-recent__remove";
      rm.setAttribute("aria-label", `Remove ${e.host} from recent`);
      rm.title = "Remove from recent";
      rm.append(icon("close"));
      rm.addEventListener("click", () => { recent = forget(recent, sourceKey(e)); saveRecent(recent); renderRecent(); });
      li.append(pick, rm);
      return li;
    }));
    const open = !form.hidden;
    toggle(recentPanel, open);
    toggle(recentEl, open && recent.length > 0);
    toggle(recentNone, open && recent.length === 0);
  }

  function fillForm(v) {
    hostEl.value = v.host; portEl.value = v.port; userEl.value = v.user;
    secureEl.checked = v.secure; allowCertEl.checked = v.allowInvalidCert;
    sw = { secure: v.secure, trust: v.allowInvalidCert, remembered: v.secure ? v.allowInvalidCert : sw.remembered };
  }

  // Liveness: the dot reflects the last probe. Probes run on a timer while the tab is visible, on returning to the tab,
  // on regaining network, and on Retry. A session the server has forgotten sends us back to the form.
  let health = initialHealth();
  let pingTimer = null;
  let pinging = false;

  function renderHealth() {
    summary.dataset.health = health.state;
    statusEl.replaceChildren(...(health.state === "lost" ? [icon("error", { size: 16 })] : []));
    healthText.textContent = HEALTH_TEXT[health.state];
    toggle(lostRow, health.state === "lost" && !summary.hidden);
  }

  async function probe() {
    if (!current || pinging) return;
    pinging = true;
    let result;
    try { result = readProbe(await api.pingConnection()); } catch { result = "unreachable"; }
    pinging = false;
    if (!current) return; // disconnected while the probe ran
    if (result === "gone") {
      applyState({ connected: false });
      toast("Your session ended. Connect again — your tables and dashboards come back.", "info");
      return;
    }
    health = nextHealth(health, result);
    renderHealth();
  }

  function startPinging() { stopPinging(); pingTimer = setInterval(() => { if (!document.hidden) probe(); }, PING_EVERY_MS); }
  function stopPinging() { clearInterval(pingTimer); pingTimer = null; }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) probe(); });
  window.addEventListener("online", probe);
  window.addEventListener("offline", () => { if (current) { health = { state: "lost", failures: 2 }; renderHealth(); } });
  retryBtn?.addEventListener("click", () => { health = { state: "checking", failures: 1 }; renderHealth(); probe(); });

  let current = null; // last connected view, for Cancel-back-to-summary

  // Trust is on by default and only applies to a TLS connection: Secure off hides and clears it, Secure on brings back what it was.
  // Its note ("not checked") waits until the user is about to connect with it on, or has touched the switch (D98).
  let sw = { secure: true, trust: true, remembered: true };
  let attempted = false, touched = false;
  function syncCertControls() {
    sw = { ...sw, secure: secureEl.checked, trust: allowCertEl.checked };
    toggle(allowCertRow, sw.secure);
    toggle(allowCertWarn, certNoteVisible({ ...sw, attempted, touched }));
  }
  secureEl.addEventListener("change", () => {
    sw = secureToggled(sw, secureEl.checked);
    allowCertEl.checked = sw.trust;
    syncCertControls();
  });
  allowCertEl.addEventListener("change", () => { touched = true; sw = trustToggled(sw, allowCertEl.checked); syncCertControls(); });
  syncCertControls();

  function showError(message) {
    errorEl.replaceChildren(icon("error", { size: 16 }), document.createTextNode(message));
    show(errorEl);
  }
  function clearError() { hide(errorEl); errorEl.replaceChildren(); }
  for (const i of [hostEl, portEl, userEl, passEl, secureEl, allowCertEl]) i.addEventListener("input", clearError);

  // The canvas shows the start card whenever the form is open (Canvas/canvas.js listens).
  const formToggled = () => document.dispatchEvent(new CustomEvent("connection:form", { detail: { open: !form.hidden } }));

  // "Change connection": the summary stays in the sidebar (still connected until a new connect succeeds); the start card opens over the canvas.
  function showForm({ cancellable }) {
    clearError();
    show(form);
    renderRecent();
    toggle(cancelBtn, cancellable);
    formToggled();
    hostEl.focus();
  }

  function applyState(view) {
    const connected = Boolean(view && view.connected);
    const sameConnection = connected && view === current; // Cancel re-applies the same view: keep what the last probe proved
    current = connected ? view : null;

    if (connected) {
      hostLabel.textContent = view.host;
      hostLabel.title = summaryTitle(view);
      detailLabel.textContent = summaryDetail(view);
      detailLabel.title = summaryTitle(view);
      // The form keeps what was entered (host included) for a later "change connection".
      fillForm(formFromView(view));
      syncCertControls();
      hide(form);
      renderRecent();
      show(section); show(sectionTitle);
      show(summary);
      hide(cancelBtn);
      if (!sameConnection) health = initialHealth();
      renderHealth();
      startPinging();
    } else {
      stopPinging();
      show(form);
      renderRecent();
      hide(section); hide(sectionTitle);
      hide(summary);
      hide(lostRow);
      hide(cancelBtn);
    }

    hide(document.getElementById("app-loading"));
    document.querySelector(".app")?.removeAttribute("data-connecting"); // first answer is in: the right empty state / card shows
    document.querySelector(".app")?.toggleAttribute("data-disconnected", !connected); // the sidebar narrows to its brand rail (shell.css)
    toggle(schemaSection, connected);
    toggle(divider, connected);
    toggle(dbHeading, connected);
    if (!connected) hide(tablesSection);

    document.dispatchEvent(new CustomEvent("connection:changed", {
      detail: view ?? { connected: false },
    }));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    clearError();
    attempted = true; syncCertControls();
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

    connectBtn.setAttribute("aria-busy", "true");
    connectBtn.disabled = true;
    try {
      const view = await api.connect(payload);
      recent = remember(recent, { ...view, host: payload.host }); // the host as entered
      saveRecent(recent);
      applyState(view);
      toast(`Connected to ${view.host}.`, "ok");
    } catch (err) {
      // Next to the form, never only a toast: on the field it belongs to (host, password), else a line above Connect.
      if (err.field && fields[err.field]) { fieldError(fields[err.field], err.message); fields[err.field].focus(); }
      else showError(err.message);
    } finally {
      connectBtn.disabled = false;
      connectBtn.removeAttribute("aria-busy");
    }
  });

  // edit icon: change connection — reveal the form (still connected until a new connect succeeds).
  changeBtn?.addEventListener("click", () => { if (form.hidden) showForm({ cancellable: true }); else if (current) applyState(current); });

  // Cancel (or Esc) out of "change" mode, back to the active connection's summary — focus returns to the edit button.
  const cancelChange = () => { if (!current || form.hidden) return; applyState(current); changeBtn?.focus(); };
  cancelBtn?.addEventListener("click", cancelChange);
  form.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); cancelChange(); } });

  disconnectBtn?.addEventListener("click", async () => {
    // Every tab closes on disconnect, so say first that nothing is lost.
    const ok = await confirmDialog(`Disconnect from ${current?.host ?? "this server"}? Your workbook is saved in this browser and comes back when you reconnect.`, { confirmText: "Disconnect" });
    if (!ok) return;
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
