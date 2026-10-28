// Undo / redo for the dashboard tab — pure (tests/js/board-history.test.mjs). Reuses Dashboard/history.js (snapshots keyed by id —
// here the dashboard's id, the snapshot its widget list). In memory only: a reload or a workbook open starts with no history.
import { createHistory } from "../Dashboard/history.js";

export const createBoardHistory = () => createHistory();

/** A snapshot to restore, minus worksheet widgets whose worksheet was closed since (`sheetExists(sheetId)`); other widgets are unchanged. */
export const restorable = (widgets, sheetExists) => widgets.filter((w) => w.kind !== "sheet" || sheetExists(w.sheetId));
