// Canvas/empty-state.js — the empty Data Model's one sentence + one action, by state (pure).
export function emptyState({ connected, databaseSelected }) {
  if (!connected) return { text: "Connect to a ClickHouse server to begin.", action: "Connect", focusId: "conn-host" };
  if (!databaseSelected) return { text: "Choose a database in the sidebar.", action: "Choose a database", focusId: "db-select" };
  return { text: "Drag a table here from the sidebar to start your data model.", action: "Find a table", focusId: "table-search" };
}
