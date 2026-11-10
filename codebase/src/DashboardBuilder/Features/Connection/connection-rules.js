// Pure connection-form rules (no DOM).

/** Secure / Trust switches as one state { secure, trust, remembered }: Trust only applies under TLS, so Secure off clears it
 *  and Secure back on restores what it was (`remembered`). */
export const secureToggled = (st, secure) => (secure
  ? { secure: true, trust: st.remembered, remembered: st.remembered }
  : { secure: false, trust: false, remembered: st.secure ? st.trust : st.remembered });
export const trustToggled = (st, trust) => ({ ...st, trust, remembered: trust });

/** The "certificate is not checked" note: only once the user is about to connect with Trust on, or has touched the switch. */
export const certNoteVisible = ({ secure, trust, attempted, touched }) => Boolean(secure && trust && (attempted || touched));

/** User and port, shown beside the host on the connected card. */
export const summaryDetail = (v) => `${v.user} · :${v.port}`;

const transport = (v) => (v.secure ? (v.allowInvalidCertificate ? "TLS, certificate not verified" : "TLS") : "plain");
/** Tooltip for the connected summary: who, over what, on which port (kept out of the visible layout). */
export const summaryTitle = (v) => `${v.user} · ${transport(v)} · :${v.port}`;
/** Form fields for the active connection, so "change" shows what was entered. */
export const formFromView = (v) => ({ host: v.host, port: String(v.port), user: v.user, secure: Boolean(v.secure), allowInvalidCert: Boolean(v.secure && v.allowInvalidCertificate) });
