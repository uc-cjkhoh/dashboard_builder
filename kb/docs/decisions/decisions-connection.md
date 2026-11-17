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


### D89 — Withdrawn: the start screen lists recent workbooks
**Withdrawn 2026-11-10.** The start screen was removed at the user's request. While disconnected, the Data Source view shows its
own empty state again, and autosave no longer writes the recent-workbooks list. The original text is kept below for the record.

The start screen (shown while disconnected) listed the workbooks this browser has autosaved, from a small
`localStorage` list written beside each autosave: server, user, TLS flags, saved-at time and counts of tables,
worksheets, dashboards and stories (max 5, one per host/port/user), following D21 and D70.
- **Why metadata, not the workbook:** the list needs no parsing of large workbooks and holds no data, names or password (golden rule 4).
- **Why a row refills the connection form:** a workbook is bound to its server + user and restores on connect; there is no application database and a workbook has no name of its own.
- **Trade-off:** not shared across browsers; forgetting a row leaves the autosave in place (the next save lists it again).
- Now: [connection.md](../concepts/data-source/connection.md#while-disconnected).


### D98 — Secure and Trust are visible switches; the certificate note waits
The connection form shows **Secure (TLS)** and **Trust self-signed certificate** as always-visible switches (no Advanced section). The defaults stay: TLS on ([D10](decisions-platform.md#d10--connect-over-tls-only-https-port-8443)) and trust on ([D11](decisions-platform.md#d11--tls-certificate-trust-self-signed-is-accepted-by-default-untick-to-verify)). Switching Secure off clears Trust and switching it on restores the earlier value.
- **Why:** a beginner test found a plain-HTTP server (port 8123) hidden behind Advanced, and a brown "Certificate validation is off" warning on a first visit, before the user had done anything.
- **The note:** the warning shows only once the user presses Connect with Trust on or has touched the switch, as a quiet inline note beside the switch — honest, but not alarming on arrival.
- **Failures:** a failed connect names its cause and shows it next to the form: wrong user or password (401, Password field), unreachable host or port (Host field), a TLS setting that does not match the port, or an untrusted certificate ([api.md](../reference/api.md#connect-errors)).
- **Amends:** the presentation of D10 and D11 only; the defaults and the server rules do not change.
- Detail: [connection.md](../concepts/data-source/connection.md#the-form).

### D99 — The connect form lives on the start card

- **Decision:** while disconnected, the connect form (fields, Secure / Trust switches, Connect) sits on the Data Source start card, right of Recent connections; the sidebar narrows to its brand rail. Once connected, the sidebar's Connection tile keeps the status row (dot, host, Change, Disconnect).
- **Why:** the form and the recent list answer the same question (which server?), so they belong on one surface; the start card used to repeat a second Connect button that only pointed back at the sidebar.
- **Change connection** re-opens the card over the canvas (scrim over any cards), with Cancel / Esc back; the session stays connected until a new connect succeeds.
- **Not moved:** the connected status row — the start card hides once tables are on the canvas, so Change / Disconnect and the liveness dot would vanish with it.
- Detail: [connection.md](../concepts/data-source/connection.md#while-disconnected).

### D135 — The connect form reaches only allowed hosts, and not too often

- **Decision:** `POST /api/connection` checks the host against `ClickHouse:AllowedHosts` (host names or IP addresses as typed, case-insensitive; `[::1]` and a trailing dot are normalised) before any network. Any other host gets 400 on the host field: "This server can't connect to that host. Ask the administrator to add it to the allowed ClickHouse hosts." Unset or empty = any host, with a startup warning. Link-local and unspecified addresses (169.254.x.x, fe80::/10, 0.0.0.0, ::, and IPv4-mapped forms) are refused even without a list. Connect attempts are rate-limited per client address (`ClickHouse:ConnectPerMinute`, default 20; 429 in the `{ error }` shape). Behind Apache the client address comes from `X-Forwarded-For`, trusted from loopback proxies only.
- **Why:** the app has no login, and the connect messages say which host:port answers, refuses, or speaks TLS (they are meant to help a user fix a typo). Without a list, anyone who can open the page can scan the network the app sits on from the build host. The list stops that at the source, and the rate limit slows a scan where no list is set.
- **Kept:** the detailed failure messages for allowed hosts — they are the user's best help, and an allowed host is one the operator chose.
- **Gap:** a host name that resolves to a link-local address is not refused (only a typed address is checked); the allowlist is the real fix, so set it on any shared server.
- **Rejected:** refusing private and loopback addresses outright (ClickHouse servers here are internal); one vague message for every failure (users lose the typo help); resolving DNS before connecting (a second lookup can differ from the connection's).
- Code: `ClickHouse/ConnectPolicy.cs`, `Program.cs`. Detail: [connection.md](../concepts/data-source/connection.md#server-side). Review: [backlog/data-source-hardening.md](../development/backlog/data-source-hardening.md).

### D137 — A writable account never runs without `readonly=2`

- **Decision:** the guard step-down at connect (`NextGuards`) goes Full → NoTimeLimit (code 452) → ReadOnly (a second 452: `readonly=2` alone) and stops: a refusal at ReadOnly fails the connect, on the user field, with "This account's settings profile refuses read-only mode (readonly=2), so it can't be used here. Connect with an account limited to reading." Code 164 at any level still goes to None (the account is read-only on the server, which guards it). At ReadOnly and None a query adds no SETTINGS of its own (`TakesQuerySettings`): no `join_use_nulls`, `max_threads` or profile backstops.
- **Why:** the old step-down went NoTimeLimit → None on a second 452, so an account whose profile pinned, say, `join_use_nulls` ran with no `readonly` at all. Golden rule 1 then rested on the app's own SQL alone.
- **Cost:** a ReadOnly connection has no server-side time limit (the 15 s HTTP timeout still ends the wait) and no cancel-on-close; right and full joins are refused as at None.
- Detail: [clickhouse-integration.md](../reference/clickhouse-integration.md#step-down-when-the-server-refuses-a-setting).
