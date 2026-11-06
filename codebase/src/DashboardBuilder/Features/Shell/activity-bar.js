// The activity chip: while any API request is in flight it says, in words, what the app is waiting on and for how long
// ("Loading tables in sales… · 3 s"). It appears only after a short delay (no flash on fast requests), updates once a second,
// and is a polite live region, so a screen reader hears it too. Labels come from Core/activity-model.js (never a request body).
import { activity, activityLine } from "../Core/activity-model.js";
import { icon } from "../Core/icons.js";

const SHOW_AFTER_MS = 300;

export function initActivityBar() {
  const root = document.getElementById("activity");
  const text = document.getElementById("activity-text");
  if (!root || !text) return;
  const glyph = document.getElementById("activity-glyph");
  glyph?.replaceChildren(icon("refresh", { size: 14 }));
  let showTimer = null, tickTimer = null;

  const paint = () => {
    const snap = activity.snapshot();
    if (!snap.count) return;
    text.textContent = activityLine(snap);
    if (snap.oldestMs >= SHOW_AFTER_MS) root.hidden = false;
  };
  const stop = () => {
    clearTimeout(showTimer); clearInterval(tickTimer); showTimer = tickTimer = null;
    root.hidden = true; text.textContent = "";
  };
  activity.subscribe(() => {
    if (!activity.snapshot().count) return stop();
    paint();
    if (!showTimer && root.hidden) showTimer = setTimeout(() => { showTimer = null; paint(); }, SHOW_AFTER_MS);
    if (!tickTimer) tickTimer = setInterval(paint, 1000);
  });
}
