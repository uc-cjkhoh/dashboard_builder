// Pure connection-form rules (no DOM).
export const advancedShouldOpen = ({ secure, allowInvalidCert }) => !secure || Boolean(allowInvalidCert);
