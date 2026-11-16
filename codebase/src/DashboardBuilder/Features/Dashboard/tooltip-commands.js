// The DOM side of the tooltip's command buttons (the pure rules are tooltip-behaviour-model.js): one delegated click listener on the chart host (the tooltip
// is a child of it, rebuilt on every hover, so no handler is ever bound to a button), and the Responsive pin. Called by chart.js `renderChart` once the option is set.
import { commandOf } from "./tooltip-behaviour-model.js";

/**
 * Wire `instance` (drawn into `host` from `option`) for `spec.tooltipButtons` = { pinned, onCommand(cmd, idx) }. Does nothing unless the option's tooltip is
 * enterable (the model only makes it so where buttons apply). Returns a function that undoes the document-level listener.
 */
export function wireTooltipCommands(host, instance, option, spec) {
  const tb = spec.tooltipButtons;
  if (!tb || !option?.tooltip?.enterable || typeof tb.onCommand !== "function") return () => {};
  const hide = () => instance.dispatchAction({ type: "hideTip" });
  host.addEventListener("click", (e) => {
    const c = commandOf(e.target);
    if (!c) return;
    e.preventDefault(); e.stopPropagation(); // not a click on the chart behind it
    hide();
    tb.onCommand(c.cmd, c.idx);
  });
  instance.on("globalout", () => option.tooltip.position?.reset?.()); // the next mark is anchored afresh
  if (!Number.isInteger(tb.pinned)) return () => {};
  // Responsive: the clicked mark's tooltip stays open (nothing else shows or hides it) until Esc, a click on empty chart, a command, or the chart is redrawn.
  instance.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: tb.pinned });
  const onKey = (e) => { if (e.key === "Escape") hide(); };
  document.addEventListener("keydown", onKey);
  instance.getZr?.().on("click", (e) => { if (!e.target) hide(); });
  return () => document.removeEventListener("keydown", onKey);
}
