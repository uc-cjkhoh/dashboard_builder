// What a worksheet field's ⋯ menu can copy to the clipboard (pure). A column field: its name (the display name when renamed)
// and, then, the column name. A calculated field: its name and its formula (not for a group, which has none).
export function fieldCopies(f) {
  if (f.column !== undefined) {
    const out = [{ label: "Copy name", text: f.alias || f.column, what: "the field name" }];
    if (f.alias) out.push({ label: "Copy column name", text: f.column, what: "the column name" });
    return out;
  }
  const out = [{ label: "Copy name", text: f.name, what: "the field name" }];
  if (f.formula && !f.group) out.push({ label: "Copy formula", text: f.formula, what: "the formula" });
  return out;
}
