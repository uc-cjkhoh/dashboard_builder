---
components: [src/DashboardBuilder/Features/Tabs/, src/DashboardBuilder/Features/Core/store.js, src/DashboardBuilder/Features/Workbook/]
---
# Decisions: the tab strip

## D152 — The tab strip is one row: tabs shrink, then the list scrolls inside the bar

- **Chosen:** the strip never wraps. `tabs.js` measures the inactive tabs at natural width and sets one shared cap (`--tab-w`, from the pure `fitTabWidth`): short tabs keep their width, longer ones share the rest. The active tab is never capped. Under 96px an inactive tab drops its duplicate and close buttons; under 60px its label collapses to the icon; the floor is 36px. Past it the tab list scrolls sideways inside the bar (the page never scrolls), with the active tab scrolled into view and a vertical wheel turn scrolling it sideways. Data Source and `[+]` sit outside the scroller.
- **Why not CSS flex-shrink alone:** a group wrapper shrinks below the minimum its tabs need, so tabs overlap. Width observers per tab flip the buttons on and off and oscillate. Measuring natural widths first and deciding from that cannot loop.
- **Not built:** an overflow menu listing every tab; a close button on hover for narrow inactive tabs (activate first, as in Chrome).
- **Cost:** one forced reflow per strip redraw or resize.

## D153 — A dashboard that holds worksheets is a derived group on the strip

- **Chosen:** a group is a dashboard plus the worksheets its widgets show; a worksheet on several dashboards belongs to the first in stored order; a dashboard that owns no worksheet and every story stay ordinary. The strip's order is derived (the group at its dashboard's slot, dashboard first, worksheets in stored order); `store.tabs` and the saved tab order never change, so a widget edit never rewrites the workbook. Closing the active tab opens its neighbour **as drawn**.
- **Colour and state:** `groupSlot` 1–7 of `--chart-cat-*` (slot 8 is grey), the lowest least-used at creation and then stored, so closing one dashboard repaints nothing; `collapsed` is stored too. Both are optional dashboard fields (no version bump). The group is headed by the dashboard's own tab, which carries the fold button and, when collapsed, the count of hidden tabs, so the name is drawn once and sits beside its colour (rule 9); a header tab is never width-capped. A collapsed group keeps its header and still shows the active worksheet.
- **Why derived, not manual:** the user chose groups tied to dashboards, which needs no menu, no drag-to-reorder and cannot drift from the dashboard.
- **Not built:** manual groups, drag-to-reorder, groups of stories.
