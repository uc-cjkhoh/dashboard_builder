---
components: []
---
# Configuration

The settings the app reads at startup. Set them as environment variables (systemd `Environment=` or the shell) or in `appsettings.json`.

| Key | Default | Effect |
|---|---|---|
| `ASPNETCORE_URLS` | launch profile: `http://localhost:5080`; live: `http://0.0.0.0:5105` | Kestrel listen address. Avoid the live port `5105` for dev runs |
| `ASPNETCORE_ENVIRONMENT` | `Development` (launch profile) · `Production` (live) | .NET environment |
| `PathBase` | unset | URL prefix the app is served under, e.g. `/dashboardbuilder` behind Apache. With it set, `/` itself is not served |
| `DataProtection:KeyRingPath` | `keys/` under the content root | Where Data Protection keys persist so session cookies survive a restart. Keep it writable and out of git |
| `Display:TimeZone` | the host machine's zone; Malaysia time (`Asia/Kuala_Lumpur`, UTC+8) when that is UTC or unknown | The zone clock times and "today" use ([time-zone.md](../reference/time-zone.md)) |
| `Logging:LogLevel` | `Default: Information`, `Microsoft.AspNetCore: Warning` | `appsettings.json` |
| `AllowedHosts` | `*` | `appsettings.json` (ASP.NET's own Host-header filter — not the ClickHouse list below) |
| `ClickHouse:AllowedHosts` | unset = any host, with a startup warning | The ClickHouse hosts the connect form may reach (array; env `ClickHouse__AllowedHosts__0=ch.internal`, `__1=…`). Any other host is refused before any network. **Set it on a shared server** ([D135](../decisions/decisions-connection.md#d135--the-connect-form-reaches-only-allowed-hosts-and-not-too-often)) |
| `ClickHouse:ConnectPerMinute` | `20` | Connect attempts per client address per minute; over it, 429 |

- **No secrets on disk.** ClickHouse credentials are entered in the UI and live only in the server session ([coding-standards.md](../development/coding-standards.md#4-credentials-live-in-the-session-and-nowhere-else)).
- **Changing the public path** means changing `PathBase` in the systemd unit and the Apache conf together ([live-service.md](../operations/live-service.md)).
