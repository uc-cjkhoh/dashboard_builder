---
components: []
---
# Decisions — connection

Continues [decisions-platform.md](decisions-platform.md). Behaviour: [connection.md](../concepts/data-source/connection.md). Edit an entry in place when it changes.

### D70 — Recent connection sources are non-secret and kept in the browser
After a successful connect, the browser remembers host, port, user, Secure and the cert opt-in in
`localStorage` (max 5, one per host/port/user), following the D21 precedent. The password and any token
are never stored. Picking a source refills the form, and the user types the password again (golden rule 4).
- **Why the cert opt-in is remembered:** it is the user's earlier explicit choice for that server, so one
  click restores "Trust invalid certificate". It is not silent: the switch refills as on, the form shows
  its note once Connect is pressed, and Connect is still a deliberate press with the password typed.
- **Trade-off:** not shared across browsers; cleared with site data. Entries are re-sanitised on load.
- Detail: [connection.md](../concepts/data-source/connection.md#recent-connections).


### D89 — The start screen lists recent workbooks as browser-held metadata
The start screen (shown while disconnected) lists the workbooks this browser has autosaved, from a small
`localStorage` list written beside each autosave: server, user, TLS flags, saved-at time and counts of tables,
worksheets, dashboards and stories (max 5, one per host/port/user), following D21 and D70.
- **Why metadata, not the workbook:** the list needs no parsing of large workbooks and holds no data, names or password (golden rule 4).
- **Why a row refills the connection form:** a workbook is bound to its server + user and restores on connect; there is no application database and a workbook has no name of its own.
- **Trade-off:** not shared across browsers; forgetting a row leaves the autosave in place (the next save lists it again).
- Detail: [connection.md](../concepts/data-source/connection.md#start-screen).


### D98 — Secure and Trust are visible switches; the certificate note waits
The connection form shows **Secure (TLS)** and **Trust self-signed certificate** as always-visible switches (no Advanced section). The defaults stay: TLS on ([D10](decisions-platform.md#d10--connect-over-tls-only-https-port-8443)) and trust on ([D11](decisions-platform.md#d11--tls-certificate-trust-self-signed-is-accepted-by-default-untick-to-verify)). Switching Secure off clears Trust and switching it on restores the earlier value.
- **Why:** a beginner test found a plain-HTTP server (port 8123) hidden behind Advanced, and a brown "Certificate validation is off" warning on a first visit, before the user had done anything.
- **The note:** the warning shows only once the user presses Connect with Trust on or has touched the switch, as a quiet inline note beside the switch — honest, but not alarming on arrival.
- **Failures:** a failed connect names its cause and shows it next to the form: wrong user or password (401, Password field), unreachable host or port (Host field), a TLS setting that does not match the port, or an untrusted certificate ([api.md](../reference/api.md#connect-errors)).
- **Amends:** the presentation of D10 and D11 only; the defaults and the server rules do not change.
- Detail: [connection.md](../concepts/data-source/connection.md#the-form).
