// Pure recent-source rules (no DOM). A recent source keeps ONLY non-secret connection fields — never the
// password (golden rule 4) — so picking one refills the form and the user types the password again.
export const MAX_RECENT = 5;

const pick = (o) => ({
  host: o.host, port: Number(o.port), user: o.user,
  secure: o.secure !== false,
  allowInvalidCert: o.secure !== false && Boolean(o.allowInvalidCert ?? o.allowInvalidCertificate),
});
const valid = (o) => o && typeof o === "object"
  && typeof o.host === "string" && o.host.trim() !== "" && o.host.length <= 253
  && typeof o.user === "string" && o.user !== "" && o.user.length <= 64
  && Number.isInteger(Number(o.port)) && Number(o.port) >= 1 && Number(o.port) <= 65535;

export const sourceKey = (e) => `${e.host}|${e.port}|${e.user}`;

/** Clean whatever was stored: drop anything malformed and any field that isn't part of a source. */
export const sanitize = (list) => (Array.isArray(list) ? list.filter(valid).map(pick).slice(0, MAX_RECENT) : []);

/** Add a connected view to the front (deduplicated by host/port/user), capped. */
export function remember(list, view) {
  if (!valid(view)) return sanitize(list);
  const e = pick(view);
  return [e, ...sanitize(list).filter((x) => sourceKey(x) !== sourceKey(e))].slice(0, MAX_RECENT);
}

export const forget = (list, key) => sanitize(list).filter((e) => sourceKey(e) !== key);

/** The form fields a source refills — the host exactly as it was entered, never derived. */
export const formValues = (e) => ({ host: e.host, port: String(e.port), user: e.user, secure: e.secure, allowInvalidCert: e.allowInvalidCert });
