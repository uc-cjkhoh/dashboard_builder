// Calculated fields — the calculation model helpers (pure, DOM-free; tests/js/calc-model.test.mjs).
// A calculation may refer to another by name (parsed as `{ k: "calc", name }`); the client expands every
// reference into one tree before anything is sent (design E9), so the server only ever sees plain trees.
import { CALC_LIMITS } from "./calc-types.js";

const TOO_LARGE = "That formula is too large.";

class ExpandError extends Error {}

/**
 * Replaces every `{ k: "calc", name }` node by that calculation's own tree. `calcsByName` is a
 * `Map<string, { ast }>` (each tree may itself hold calc nodes). Returns `{ ast }` — a NEW tree, the inputs are
 * never mutated — or `{ error: { message } }` for an unknown name, a cycle, or an expansion over the node cap
 * (counted like check()'s limit: every node once). Recursion is bounded by that cap and by a cap on a chain of
 * bare references, so hostile input stops with "too large" rather than blowing the stack.
 */
export function expandCalcs(ast, calcsByName) {
  let nodes = 0;
  const stack = []; // names being expanded, outermost first

  const walk = (n) => {
    if (n === null || typeof n !== "object") { count(); return n; }
    switch (n.k) {
      case "calc": {
        const at = stack.indexOf(n.name);
        if (at !== -1) {
          const chain = [...stack.slice(at), n.name].join(" → ");
          throw new ExpandError(`Calculation '${n.name}' refers to itself (${chain}).`);
        }
        const target = calcsByName.get(n.name);
        if (target === undefined) throw new ExpandError(`Unknown calculation [${n.name}].`);
        // A bare reference adds no node, so a long reference chain is bounded by its own depth.
        if (stack.length >= CALC_LIMITS.nodes) throw new ExpandError(TOO_LARGE);
        stack.push(n.name);
        const expanded = walk(target.ast);
        stack.pop();
        return expanded;
      }
      case "un": count(); return { ...n, arg: walk(n.arg) };
      case "agg": count(); return { ...n, arg: walk(n.arg) };
      case "bin": case "cmp": case "logic": case "ifnull": count(); return { ...n, l: walk(n.l), r: walk(n.r) };
      case "not": case "isnull": count(); return { ...n, arg: walk(n.arg) };
      case "case": {
        count();
        const out = { ...n, whens: Array.isArray(n.whens) ? n.whens.map((w) => ({ c: walk(w?.c), t: walk(w?.t) })) : n.whens };
        if (n.else !== undefined) out.else = walk(n.else);
        return out;
      }
      default: count(); return { ...n }; // num, field (and anything unknown — check() will name it)
    }
  };

  const count = () => { if (++nodes > CALC_LIMITS.nodes) throw new ExpandError(TOO_LARGE); };

  try {
    return { ast: walk(ast) };
  } catch (e) {
    if (e instanceof ExpandError) return { error: { message: e.message } };
    throw e;
  }
}

/**
 * The pill role of a calculation, from the object check() returned (`{ type, isAggregate }`): an aggregate or a
 * row-level number is a measure; a row-level text, date or boolean is a dimension. `override`
 * (`"dimension"` | `"measure"`) only ever applies to a row-level number — anything else ignores it.
 */
export function roleOfCalc(info, override = null) {
  if (info.isAggregate) return "measure";
  if (info.type === "number") return override === "dimension" ? "dimension" : "measure";
  return "dimension";
}
