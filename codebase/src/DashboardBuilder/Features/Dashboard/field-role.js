// Dashboard/field-role.js — the default role of a newly placed field (pure, DOM-free; D96). A number that is really an identifier
// (id, order_id, line_no, sku_key, zip_code, orderId…) groups as a dimension instead of being summed. Only the default changes:
// a role the user set, and every role already stored in a workbook, stays as it is (roleOf in show-me-rules.js).
const ID_WORD = /^(id|uid|uuid|pk|key|code)$/i;
const ID_SUFFIX = /[_\s-](id|no|num|number|nbr|key|code|ref)$/i;
const CAMEL_ID = /[a-z0-9]Id$|[a-z0-9]ID$/;

/** Does a column name read like an identifier? */
export function isIdLike(name) {
  const n = String(name ?? "").trim();
  return Boolean(n) && (ID_WORD.test(n) || ID_SUFFIX.test(n) || CAMEL_ID.test(n));
}

/** The role a field starts with: numeric, non-identifier columns are measures; everything else is a dimension. */
export const defaultRole = (column, category) => (category === "numeric" && !isIdLike(column) ? "measure" : "dimension");
