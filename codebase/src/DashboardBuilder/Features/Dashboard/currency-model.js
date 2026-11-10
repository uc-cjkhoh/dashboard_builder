// Dashboard/currency-model.js — the Currency number format's symbol (pure, DOM-free). A short list plus a custom symbol of 1–3 characters typed in the Custom box;
// a stored symbol (up to 8 characters, as before) is kept and shown as custom, never cut.
export const DEFAULT_CURRENCY = "$";
export const CURRENCY_CHOICES = Object.freeze([["$", "$"], ["€", "€"], ["£", "£"], ["¥", "¥"], ["RM", "RM"], ["S$", "S$"], ["custom", "Custom…"]]);
export const CURRENCY_MAX = 3;

/** The message for a symbol that can't be used, or null when it can: 1–3 visible characters. */
export function currencyError(v) {
  const s = String(v ?? "");
  if ([...s].length < 1 || [...s].length > CURRENCY_MAX) return `A currency symbol is 1 to ${CURRENCY_MAX} characters.`;
  if (/[\p{Cc}\p{Cf}\s]/u.test(s)) return "A currency symbol must be visible characters, no spaces.";
  return null;
}
/** What the select shows for a stored symbol: itself when it is in the list, else "custom". */
export const currencyChoice = (sym) => {
  const s = sym ?? DEFAULT_CURRENCY;
  return CURRENCY_CHOICES.some(([v]) => v === s && v !== "custom") ? s : "custom";
};
