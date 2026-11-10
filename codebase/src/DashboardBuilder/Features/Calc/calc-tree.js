// Reading a compiled calculation tree (pure, DOM-free; tests/js/calc-tree.test.mjs). A node is { k, … }; a field node is
// { k: "field", db, table, column } and every other node holds its children as object / array values.

/** Every field node in the tree, in order. */
export function treeFields(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => treeFields(n, out));
  else if (node && typeof node === "object") {
    if (node.k === "field") out.push(node);
    else Object.values(node).forEach((v) => treeFields(v, out));
  }
  return out;
}

/** Does every field the calculation reads sit on `db.table`? A calculation with no field (a constant) does; a tree that
 *  isn't an object doesn't. The single-table endpoints (histogram, View data) evaluate only such a calculation. */
export const calcOnTable = (calc, db, table) => Boolean(calc) && typeof calc === "object" && treeFields(calc).every((f) => f.db === db && f.table === table);
