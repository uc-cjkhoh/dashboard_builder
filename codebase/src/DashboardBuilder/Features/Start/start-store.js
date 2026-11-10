// Browser storage for the recent-workbooks metadata (no DOM). Blocked or full storage just means nothing is remembered.
import { sanitizeWorkbooks } from "./start-model.js";
export const WORKBOOKS_KEY = "dashboardbuilder.recent-workbooks";
export const loadWorkbooks = () => { try { return sanitizeWorkbooks(JSON.parse(localStorage.getItem(WORKBOOKS_KEY))); } catch { return []; } };
export const saveWorkbooks = (list) => { try { localStorage.setItem(WORKBOOKS_KEY, JSON.stringify(list)); } catch { /* not remembered — fine */ } };
