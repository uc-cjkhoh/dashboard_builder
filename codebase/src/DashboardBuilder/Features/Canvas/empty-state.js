// Canvas/empty-state.js — the empty Data Source's one sentence + one action, by state (pure).
export function emptyState({ connected, databaseOpen }) {
  if (!connected) return { text: "Connect to a ClickHouse server to begin.", action: "Connect", focusId: "conn-host" };
  if (!databaseOpen) return { text: "Open a database in the sidebar.", action: "Open a database", focusId: "db-first" };
  return { text: "Drag a table here from the sidebar to start your data source.", action: "Find a table", focusId: "table-search" };
}
