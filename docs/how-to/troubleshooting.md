---
components: [src/DashboardBuilder/Features/]
---
# Troubleshooting

Common dev-loop failures and their fixes.

- No ClickHouse reachable → connect fails by design; check the container / `curl` first.
- New CSS/JS outside `Features/` won't be served or published.
- If the UI goes inert after rebuilding, check that the page's asset URLs carry the current `/features/v-<hash>/` prefix (view source) and that no module is imported by an absolute `/features/…` path; a hard refresh clears any stale copy.
- More: [sharp-edges.md](../development/sharp-edges.md).
