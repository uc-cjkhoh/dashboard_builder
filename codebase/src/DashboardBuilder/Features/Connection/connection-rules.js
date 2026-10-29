// Pure connection-form rules (no DOM).
export const advancedShouldOpen = ({ secure, allowInvalidCert }) => !secure || Boolean(allowInvalidCert);

const transport = (v) => (v.secure ? (v.allowInvalidCertificate ? "TLS, certificate not verified" : "TLS") : "plain");
/** Tooltip for the connected summary: who, over what, on which port (kept out of the visible layout). */
export const summaryTitle = (v) => `${v.user} · ${transport(v)} · :${v.port}`;
/** A bypassed certificate check stays visible after connecting (icon + tooltip). */
export const summaryWarns = (v) => Boolean(v.secure && v.allowInvalidCertificate);
/** Form fields for the active connection, so "change" shows what was entered. */
export const formFromView = (v) => ({ host: v.host, port: String(v.port), user: v.user, secure: Boolean(v.secure), allowInvalidCert: Boolean(v.secure && v.allowInvalidCertificate) });
