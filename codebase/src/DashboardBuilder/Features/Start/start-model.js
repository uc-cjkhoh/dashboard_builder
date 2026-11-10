// Pure start-screen rules (no DOM): the recent-workbooks list. An entry is METADATA only — the server, the user,
// when it was last saved and how many tables / worksheets / dashboards / stories it holds. No data, no names, no
// password (golden rule 4). The workbook itself stays in its own autosave entry (Workbook/workbook.js).
export const MAX_WORKBOOKS = 5;
const PARTS = ["tables", "worksheets", "dashboards", "stories"];
const num = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);

export const summarize = (wb) => ({
  tables: wb?.entities?.length ?? 0, worksheets: wb?.worksheets?.length ?? 0,
  dashboards: wb?.dashboards?.length ?? 0, stories: wb?.stories?.length ?? 0,
});

const validServer = (o) => o && typeof o === "object"
  && typeof o.host === "string" && o.host.trim() !== "" && o.host.length <= 253
  && typeof o.user === "string" && o.user !== "" && o.user.length <= 64
  && Number.isInteger(Number(o.port)) && Number(o.port) >= 1 && Number(o.port) <= 65535;

const pick = (o, savedAt, sum) => ({
  host: o.host, port: Number(o.port), user: o.user,
  secure: o.secure !== false,
  allowInvalidCert: o.secure !== false && Boolean(o.allowInvalidCert ?? o.allowInvalidCertificate),
  savedAt: Number.isFinite(savedAt) ? savedAt : 0,
  tables: num(sum.tables), worksheets: num(sum.worksheets), dashboards: num(sum.dashboards), stories: num(sum.stories),
});

export const workbookKey = (e) => `${e.host}|${e.port}|${e.user}`;
const isEmpty = (s) => PARTS.every((p) => !s[p]);

/** Clean whatever was stored: drop malformed entries and any field that is not part of an entry. */
export const sanitizeWorkbooks = (list) => (Array.isArray(list)
  ? list.filter((o) => validServer(o) && Number.isFinite(o.savedAt)).map((o) => pick(o, o.savedAt, o)).filter((e) => !isEmpty(e)).slice(0, MAX_WORKBOOKS)
  : []);

/** The latest save for a connected view, at the front (one per host/port/user). An empty workbook removes its entry. */
export function rememberWorkbook(list, view, sum, savedAt) {
  const rest = sanitizeWorkbooks(list);
  if (!validServer(view)) return rest;
  const e = pick(view, savedAt, sum);
  const others = rest.filter((x) => workbookKey(x) !== workbookKey(e));
  return (isEmpty(e) ? others : [e, ...others]).slice(0, MAX_WORKBOOKS);
}

export const forgetWorkbook = (list, key) => sanitizeWorkbooks(list).filter((e) => workbookKey(e) !== key);

export function ago(then, now) {
  const s = Math.max(0, (now - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "yesterday";
  return d < 31 ? `${d} days ago` : "over a month ago";
}

const NOUN = { tables: "table", worksheets: "worksheet", dashboards: "dashboard", stories: "story" };
export const describe = (sum) => PARTS.filter((p) => sum[p] > 0).map((p) => `${sum[p]} ${sum[p] === 1 ? NOUN[p] : p === "stories" ? "stories" : NOUN[p] + "s"}`).join(" · ");
