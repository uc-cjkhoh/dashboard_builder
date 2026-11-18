---
components: [src/DashboardBuilder/Features/]
---
# Deployment — live on `10.168.49.20`

How the live service is hosted, released and operated. Read it before deploying or touching the live
service. The Dashboard Builder runs as a permanent **systemd** service behind **Apache httpd**, following
the host's per-webapp convention (decision
[D20](../decisions/decisions-platform.md#d20--apache-reverse-proxy--pathbase--systemd)). For the dev
loop see [quickstart.md](../getting-started/quickstart.md).

## At a glance

| Item | Value |
|---|---|
| Public URL | `https://10.168.49.20:8443/dashboardbuilder` (self-signed TLS → one-time browser warning) |
| Apache vhost | `:8443` dev/test vhost (`/etc/httpd/conf.d/webui-dev.conf`), which includes `conf.d/webapps-dev/*.conf` |
| Proxy conf | `/etc/httpd/conf.d/webapps-dev/5105-dashboardbuilder.conf` |
| systemd unit | `webapps-dev.dashboardbuilder.service` (`/etc/systemd/system/`) |
| Kestrel | `0.0.0.0:5105`, `PathBase=/dashboardbuilder`, `ASPNETCORE_ENVIRONMENT=Production` |
| Deploy dir | `/var/www/webapps-dev/dashboardbuilder/` (owned by `unified`) |
| Logs | `journalctl -u webapps-dev.dashboardbuilder` (`SyslogIdentifier=dashboardbuilder`) |

Port `5105` is this app's slot in the host convention: each app gets one Apache conf and one Kestrel
port (`5100-ucbizview` … `5105-dashboardbuilder`, `5106-mnpwebportal`, …). The firewall exposes only the Apache
ports. The production `:443` vhost (`conf.d/webapps/`) does **not** serve this app.

## Topology

```
Browser ── https://10.168.49.20:8443/dashboardbuilder
  ▼
Apache httpd :8443 (TLS) ── 5105-dashboardbuilder.conf
  │  ProxyPass /dashboardbuilder → http://127.0.0.1:5105/dashboardbuilder
  ▼
Kestrel: dotnet DashboardBuilder.dll ── webapps-dev.dashboardbuilder.service
  ▼
ClickHouse (HTTPS 8443) — per-session connection; credentials only in session state
```

## systemd unit

```ini
[Unit]
Description=ASP.NET Core Web App - DashboardBuilder
After=network.target

[Service]
WorkingDirectory=/var/www/webapps-dev/dashboardbuilder
ExecStart=/usr/bin/dotnet /var/www/webapps-dev/dashboardbuilder/DashboardBuilder.dll
Restart=always
RestartSec=10
KillSignal=SIGINT
SyslogIdentifier=dashboardbuilder
User=unified
Environment=ASPNETCORE_ENVIRONMENT=Production
Environment=ASPNETCORE_URLS=http://0.0.0.0:5105
Environment=PathBase=/dashboardbuilder

[Install]
WantedBy=multi-user.target
```

To change the public path, change it in **both** the unit's `PathBase` and the Apache conf.

## Apache proxy conf

```apache
ProxyPreserveHost On

ProxyPass /dashboardbuilder http://127.0.0.1:5105/dashboardbuilder
ProxyPassReverse /dashboardbuilder http://127.0.0.1:5105/dashboardbuilder

<Location /dashboardbuilder>
   Require all granted
</Location>
```

Reload with `sudo systemctl reload httpd` after edits (root-owned; `sudo` needs a password).

**The proxy 403s `DELETE` and any request without a body** before Kestrel sees it. Every
state-changing call must be a `POST` with JSON ([sharp edges](../development/sharp-edges.md#hosting--deploy)).

## Runtime

- **.NET 10**, framework-dependent (`net10.0`), Kestrel launched directly by systemd. The `web.config` in
  the deploy dir is for IIS and unused here.
- **Config:** `appsettings.json` (logging, `AllowedHosts: *`). No secrets on disk.
- **ClickHouse hosts (D135):** the live unit should set `Environment=ClickHouse__AllowedHosts__0=<host>` (one line per host, `__1`, `__2` …) to the ClickHouse servers users connect to. Unset, the connect form may reach any host and the app logs a warning at startup. Not set on the live unit yet: it needs the host list from the operator.
- **Sessions:** in-memory (`AddDistributedMemoryCache`), so **every restart drops every session's
  ClickHouse connection**. Users must reconnect.
- **Data Protection keys** persist to `keys/` under the content root
  (`/var/www/webapps-dev/dashboardbuilder/keys/`; override with `DataProtection:KeyRingPath`) with
  `SetApplicationName("DashboardBuilder")`. Session cookies from before a restart therefore decrypt
  cleanly instead of logging `CryptographicException`. The dir must stay writable by `unified` and
  survive redeploys. Don't delete it, and keep it out of git.
- **Static assets** are linked as `/features/v-<content hash>/…` and served `public, max-age=31536000, immutable`; the hash changes
  whenever any `.js` / `.css` changes, so a deploy needs no cache flush. The page (`/`) and unversioned `/features/…` URLs revalidate
  (`no-cache`). Brotli copies of every asset are built in memory in the first seconds after start-up.
  Apache serves HTTP/1.1 on `:8443` (six parallel requests); `Protocols h2 http/1.1` on the vhost would speed a cold load further ([resource-usage.md](resource-usage.md)).

## SQL translator (MySQL syntax in Edit SQL)

The Edit SQL dialog's MySQL option ([D106](../decisions/decisions-custom-sql.md#d106--mysql-syntax-in-edit-sql-translated-to-clickhouse)) runs `python3 -I Tools/sql_translate.py` as the service user.

- **Needs** `python3` on the service's `PATH` (3.9 on this host; no `pip install` and no root — sqlglot is vendored in `Tools/vendor/` and published with the app). Check: `python3 --version`.
- **Deploy:** `Tools/` is part of the publish output; copy it with the rest (stop → copy → start, step 3 is for assets only). It is never served over HTTP.
- **Config:** `Translate:Python` (environment `Translate__Python`) names another interpreter.
- **If Python is missing** the MySQL option is switched off in the dialog (503 from `/api/sql/translate`); everything else works.
- Python writes `__pycache__` next to the vendored library on first use (git-ignored); the service user must be able to write there, or each call compiles the library again (about 0.3 s).

## Deployed build vs. source

The live bundle matches the source: MVC feature folders
([D19](../decisions/decisions-platform.md#d19--mvc-in-feature-folders)) with assets under `Features/`, the
database-level query guards with their step-down, the truncation notice, the query cache and the browser
workbook. Asset-only changes can use the no-restart copy (step 3 below).

## Operations

```bash
systemctl status webapps-dev.dashboardbuilder
sudo systemctl restart webapps-dev.dashboardbuilder     # drops all sessions
journalctl -u webapps-dev.dashboardbuilder -f
ss -ltnp | grep 5105                                    # Kestrel bound?
```
