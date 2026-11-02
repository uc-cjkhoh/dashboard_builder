import { icon } from "../Core/icons.js";
import { api } from "../Core/api.js";
import { show, hide, toggle, toast, fieldError, clearFieldError, checkField } from "../Core/ui.js";
import { host, port, text, LIMITS } from "../Core/validate.js";
import { advancedShouldOpen, summaryTitle, summaryWarns, formFromView } from "./connection-rules.js";
import { remember, forget, sanitize, sourceKey, formValues } from "./recent-sources.js";

// Recent sources live in this browser only (localStorage) and hold no secrets — see recent-sources.js.
const RECENT_KEY = "dashboardbuilder.recent-sources";
const loadRecent = () => { try { return sanitize(JSON.parse(localStorage.getItem(RECENT_KEY))); } catch { return []; } };
const saveRecent = (list) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* not remembered — fine */ } };

// The sidebar connection flow. Gates the schema browser + canvas. Failures show as a
// field error or a toast. Once connected the form is collapsed into a compact summary showing the
// ClickHouse host (user, transport and port in its tooltip), with icon actions to change the connection (re-open the form) or disconnect.
export function initConnection() {
  const form = document.getElementById("conn-form");
  if (!form) return;

  const summary = document.getElementById("conn-summary");
  const hostLabel = document.getElementById("conn-host-label");
  const warnIcon = document.getElementById("conn-warn");
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

  const recentEl = document.getElementById("conn-recent");
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
      m.className = "conn-recent__meta"; m.textContent = `${e.user} · :${e.port}`;
      pick.title = `${e.host} · ${e.user} · :${e.port}`;
      pick.append(h, m);
      pick.addEventListener("click", () => {
        fillForm(formValues(e));
        for (const i of [hostEl, portEl, userEl, passEl]) clearFieldError(i);
        syncCertControls(); syncAdvanced();
        passEl.value = ""; passEl.focus();
      });
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "iconbtn conn-summary__btn";
      rm.setAttribute("aria-label", `Remove ${e.host} from recent`);
      rm.title = "Remove from recent";
      rm.append(icon("close"));
      rm.addEventListener("click", () => { recent = forget(recent, sourceKey(e)); saveRecent(recent); renderRecent(); });
      li.append(pick, rm);
      return li;
    }));
    toggle(recentEl, recent.length > 0 && !form.hidden);
  }

  function fillForm(v) {
    hostEl.value = v.host; portEl.value = v.port; userEl.value = v.user;
    secureEl.checked = v.secure; allowCertEl.checked = v.allowInvalidCert;
  }

  let current = null; // last connected view, for Cancel-back-to-summary

  // Certificate validation is on by default. The "trust invalid cert" opt-in only
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
    renderRecent();
    toggle(cancelBtn, cancellable);
    changeBtn?.setAttribute("aria-expanded", "true");
    hostEl.focus();
  }

  function applyState(view) {
    const connected = Boolean(view && view.connected);
    current = connected ? view : null;

    if (connected) {
      hostLabel.textContent = view.host;
      hostLabel.title = summaryTitle(view);
      toggle(warnIcon, summaryWarns(view));
      // The form keeps what was entered (host included) for a later "change connection".
      fillForm(formFromView(view));
      syncCertControls();
      changeBtn?.setAttribute("aria-expanded", "false");
      hide(form);
      renderRecent();
      show(summary);
      hide(cancelBtn);
    } else {
      syncAdvanced();
      show(form);
      renderRecent();
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

    connectBtn.setAttribute("aria-busy", "true");
    connectBtn.disabled = true;
    try {
      const view = await api.connect(payload);
      recent = remember(recent, { ...view, host: payload.host }); // the host as entered
      saveRecent(recent);
      applyState(view);
      toast(`Connected to ${view.host}.`, "ok");
    } catch (err) {
      if (err.field && fields[err.field]) fieldError(fields[err.field], err.message);
      else toast(err.message, "danger");
    } finally {
      connectBtn.disabled = false;
      connectBtn.removeAttribute("aria-busy");
    }
  });

  // edit icon: change connection — reveal the form (still connected until a new connect succeeds).
  changeBtn?.addEventListener("click", () => { if (form.hidden) showForm({ cancellable: true }); else if (current) applyState(current); });

  // Cancel out of "change" mode, back to the active connection's summary.
  cancelBtn?.addEventListener("click", () => { if (current) applyState(current); });

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
