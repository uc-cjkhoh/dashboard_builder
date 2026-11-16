import { colorsByName, fieldColorKey } from "./colour-model.js";
import { shapesByName } from "./shape-model.js";
import { isDrillActive } from "./sheet-plan.js";
import { focusSeries } from "./chart.js";
import { CLICK_TYPES } from "./result-model.js";
import { BUTTON_TYPES, commandButtonsOn, tooltipsOn, tooltipModeOf, pinnedIndex } from "./tooltip-behaviour-model.js";
import { selectionRefusal } from "./dashboard-select.js";
import { hint } from "./render-dom.js";
import { DATE_GROUPED_NOTE } from "./tooltip-behaviour-model.js";

// The interaction wiring of a drawn worksheet (click-to-filter, drill, legend, member colours), kept
// apart from the drawing. Every function reads the render context `rc` (worksheet-render.js): when `rc.interactive` is
// false none of the editor handlers exist, so a widget draws marks that cannot be drilled or legend-clicked; `rc.select`
// (interactive true or "select") additionally lets a mark click select (a dashboard widget selects, never drills). The
// behaviour itself is the host's: rc.hooks = { onSelect(dimField, raw), onDrill(raw), onLegend({ sheet, field, name, raw,
// bucketed }), legendFocus(), onTooltipFields(sheet, list), onMemberColors(sheet, field, members), onTooltipCommand(cmd, dimField, raw),
// takePin() }.

/**
 * The ECharts click handler that turns a mark click into a selection on the primary dimension — or, on a drill
 * hierarchy, a step down. undefined when the view is not interactive or the chart type / field mapping can't
 * support click-to-filter (a date-grouped first key has no value a filter could match).
 */
export function selectHandler(rc, sheet, dimField, type, rawByIndex) {
  if (!rc.select || !dimField || !CLICK_TYPES.has(type) || rc.bucketedKey === 0) return undefined;
  // A dashboard widget (select-only) sends the raw column with the selected value, so a data type cast on the field would filter
  // the cast value against the raw column: such a field can't start a cross-filter (the editor's own selection handles casts).
  if (!rc.interactive && rc.plan?.metaOf?.(dimField)?.cast) return undefined;
  const drilling = rc.interactive && isDrillActive(sheet); // a select-only view selects the current level, even on a hierarchy
  return (params) => {
    const raw = rawByIndex[params.dataIndex];
    if (raw === undefined || raw === null) { if (!rc.interactive) rc.hooks.onUnselectable?.(); return; } // can't cleanly filter/drill a null value (nor the "Other" group)
    if (drilling) rc.hooks.onDrill?.(raw);
    else rc.hooks.onSelect?.(dimField, raw);
  };
}

/**
 * The tooltip's command buttons (Format → Command buttons): { tooltipButtons: { can, pinned, onCommand } } for chart.js, or {} where they would do nothing —
 * not in the editor (a dashboard widget's selection is a cross-filter, not Keep only), not where a click would not select (selectHandler's own rules), not
 * while a drill hierarchy is active (a click steps down), not on a calculated dimension. `can(i)`: the mark has a value a filter could match (not Other, not NULL).
 */
export function tooltipButtonsSpec(rc, sheet, dimField, type, rawByIndex, format, container = null) {
  if (!commandButtonsOn(format) || !tooltipsOn(format) || rc.interactive !== true || typeof rc.hooks.onTooltipCommand !== "function") return {};
  if (!BUTTON_TYPES.has(type) || isDrillActive(sheet) || !dimField || selectionRefusal(dimField)) return {};
  if (rc.bucketedKey === 0) { container?.append(hint(`Command buttons are not shown: ${DATE_GROUPED_NOTE}`)); return {}; } // the data decided the grouping (Group dates: Auto), which the Format panel could not know
  if (!selectHandler(rc, sheet, dimField, type, rawByIndex)) return {};
  const can = (i) => rawByIndex[i] !== undefined && rawByIndex[i] !== null;
  return { tooltipButtons: {
    can,
    pinned: pinnedIndex(tooltipModeOf(format), rawByIndex, rc.pin, dimField),
    onCommand: (cmd, i) => { if (can(i)) rc.hooks.onTooltipCommand(cmd, dimField, rawByIndex[i]); }, // re-checked: the markup is only a hint of what may be run
  } };
}

/**
 * Legend interaction for chart.js: { onLegend, focus }. A click highlights that item (a second click clears it);
 * when the legend lists a dimension's members (`field` + `rawByName`) the host may also select the member. A static
 * (non-interactive) view is highlight-only: no host hook, no selection, and no series is ever hidden.
 */
export function legendSpec(rc, sheet, field, rawByName) {
  if (!rc.interactive) { // false and "select" alike: the legend never selects
    // Static widget: the legend highlights (a second click clears) and never hides a series or reaches a host hook.
    // Registering a handler is what makes chart.js re-select every item after ECharts' default toggle.
    let focus = null;
    return { onLegend: (name) => { focus = focus === name ? null : name; focusSeries(rc.container, focus, sheet.chartType); } };
  }
  return {
    focus: rc.hooks.legendFocus?.() ?? null,
    onLegend: (name) => rc.hooks.onLegend?.({ sheet, field, name, raw: rawByName.get(name), bucketed: rc.bucketedKey }),
  };
}

/**
 * The chart spec's name -> colour map for a sheet's member field; also tells the host which members the chart colours
 * (its member-colour editor lists them).
 */
export function memberSpec(rc, sheet, field, members) {
  rc.hooks.onMemberColors?.(sheet, field, members);
  return { memberColors: colorsByName(sheet.memberColors?.[fieldColorKey(field)], members) };
}

/**
 * The chart spec's displayed member name -> shape key map for the sheet's Shape field (Format → Edit member shapes); also tells the host which members
 * the chart draws (its editor lists them). A host that never learns of members gets the shapes all the same.
 */
export function memberShapeSpec(rc, sheet, field, members) {
  rc.hooks.onMemberShapes?.(sheet, field, members);
  return { memberShapes: shapesByName(sheet.memberShapes?.[fieldColorKey(field)], members) };
}
