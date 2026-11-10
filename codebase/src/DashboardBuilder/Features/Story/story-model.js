// Stories — pure, DOM-free (tests/js/story-model.test.mjs). A story tab is an ordered list of steps; each step is
// { caption, target } where `target` is the id of a worksheet or dashboard tab the step shows. The saved form points at the tab
// by { kind, index } (like a navigation button). Limits are client-side only: a story never reaches the server.
import { LIMITS, text } from "../Core/validate.js";

const STEP_KINDS = new Set(["worksheet", "dashboard"]);

/** A caption as typed → { ok, value } | { ok, error }. Empty is fine; over the limit is refused, never cut. */
export function validateCaption(raw) {
  if (typeof raw !== "string") return { ok: false, error: "The caption must be text." };
  const r = text(raw, { label: "The caption", max: LIMITS.stepCaption });
  return r.ok ? r : { ok: false, error: `The caption must be at most ${LIMITS.stepCaption} characters (it has ${raw.trim().length}).` };
}

const full = () => `A story holds at most ${LIMITS.storySteps} steps — remove one first.`;

/** Append a step showing tab `target`. → { ok, steps, index } (index = the new step) | { ok: false, error }. */
export function addStep(steps, target, caption) {
  if (!target) return { ok: false, error: "Choose a worksheet or dashboard for the step." };
  if (steps.length >= LIMITS.storySteps) return { ok: false, error: full() };
  const c = validateCaption(caption);
  if (!c.ok) return c;
  return { ok: true, steps: [...steps, { caption: c.value, target }], index: steps.length };
}

/** The steps without step `i` (the same array when `i` is outside the story). */
export function removeStep(steps, i) {
  return Number.isInteger(i) && i >= 0 && i < steps.length ? steps.filter((_, j) => j !== i) : steps;
}

/** Swap step `i` with its neighbour (dir -1 earlier, +1 later). → { steps, index }; at an end nothing changes. */
export function moveStep(steps, i, dir) {
  const j = i + dir;
  if (!(i >= 0 && i < steps.length) || j < 0 || j >= steps.length) return { steps, index: i };
  const next = steps.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return { steps: next, index: j };
}

/** Replace step `i`'s caption. → { ok, steps } | { ok: false, error }. */
export function setCaption(steps, i, raw) {
  if (!(Number.isInteger(i) && i >= 0 && i < steps.length)) return { ok: false, error: "That step no longer exists." };
  const c = validateCaption(raw);
  if (!c.ok) return c;
  return { ok: true, steps: steps.map((s, j) => (j === i ? { ...s, caption: c.value } : s)) };
}

/** The step index after a move: "prev" | "next" | "first" | "last" | an index. Never wraps; an index outside the story is refused. */
export function goTo(index, count, how) {
  if (!count) return 0;
  if (how === "next") return Math.min(index + 1, count - 1);
  if (how === "prev") return Math.max(index - 1, 0);
  if (how === "first") return 0;
  if (how === "last") return count - 1;
  return Number.isInteger(how) && how >= 0 && how < count ? how : index;
}

/** The steps without those showing tab `tabId` (the same array when none do) — a closed tab leaves its steps. */
export const dropTarget = (steps, tabId) => (steps.some((s) => s.target === tabId) ? steps.filter((s) => s.target !== tabId) : steps);

/** The tabs a step may show: worksheets and dashboards (never another story). */
export const offeredTargets = (tabs) => tabs.filter((t) => STEP_KINDS.has(t.kind)).map((t) => ({ id: t.id, name: t.name, kind: t.kind }));

/** "worksheet" | "dashboard" for a step's tab, null when it no longer exists. */
export const targetKind = (tabs, id) => { const k = tabs.find((t) => t.id === id)?.kind; return STEP_KINDS.has(k) ? k : null; };

export const stepName = (tabs, step) => tabs.find((t) => t.id === step.target)?.name ?? "Closed tab";

/** Store steps → the saved form. `wsIndex` / `dbIndex` map tab ids to their saved index; a step of an unknown tab is dropped. */
export function savedSteps(steps, wsIndex, dbIndex) {
  const out = [];
  for (const s of steps) {
    if (wsIndex.has(s.target)) out.push({ caption: s.caption ?? "", target: { kind: "worksheet", index: wsIndex.get(s.target) } });
    else if (dbIndex.has(s.target)) out.push({ caption: s.caption ?? "", target: { kind: "dashboard", index: dbIndex.get(s.target) } });
  }
  return out;
}

/** A saved step list → clean steps; each bad step is skipped and reported (nothing is cut or guessed). `where` names the story in messages. */
export function cleanSteps(raw, { worksheetCount, dashboardCount, where }, issues) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { issues.push(`${where}: the steps weren't a list — none were opened.`); return []; }
  const out = [];
  let past = 0;
  for (const s of raw) {
    if (!s || typeof s !== "object") { issues.push(`${where}: skipped a step that wasn't a step.`); continue; }
    if (typeof s.caption !== "string") { issues.push(`${where}: skipped a step whose caption wasn't text.`); continue; }
    if (s.caption.trim().length > LIMITS.stepCaption) { issues.push(`${where}: skipped a step whose caption was over ${LIMITS.stepCaption} characters.`); continue; }
    const t = s.target, count = t?.kind === "worksheet" ? worksheetCount : t?.kind === "dashboard" ? dashboardCount : 0;
    if (!(t && typeof t === "object" && Number.isInteger(t.index) && t.index >= 0 && t.index < count)) { issues.push(`${where}: removed a step whose worksheet or dashboard is missing.`); continue; }
    if (out.length >= LIMITS.storySteps) { past++; continue; }
    out.push({ caption: s.caption.trim(), target: { kind: t.kind, index: t.index } });
  }
  if (past) issues.push(`${where}: only the first ${LIMITS.storySteps} steps were opened.`);
  return out;
}

/** The story tabs that show tab `tabId`. */
export const storiesUsing = (tabs, tabId) => tabs.filter((t) => t.kind === "story" && t.steps.some((s) => s.target === tabId));

/** After a move, which tool gets focus: the same role ("earlier" | "later"), or the enabled opposite when that one is now disabled. `disabled` = { earlier, later }. */
export function refocusTarget(role, disabled) {
  const other = role === "earlier" ? "later" : "earlier";
  return disabled[role] && !disabled[other] ? other : role;
}
