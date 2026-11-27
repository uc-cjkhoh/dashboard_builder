# Tableau Detail Marks

In Tableau, dragging a field to **Detail** on the Marks card increases the granularity (level of detail) of the visualization by splitting marks according to the dimension's members without adding new headers to Rows or Columns.

## How Detail Works

* **Splits marks by member:** Dropping a dimension (such as *Category* or *Customer Name*) onto **Detail** creates a separate mark for each member of that dimension.
* **Preserves table structure:** Unlike placing a dimension on **Rows** or **Columns**, **Detail** breaks down marks inside the existing chart layout rather than creating new row or column headers.
* **Supports multiple fields:** You can place more than one field on **Detail** to break marks down across multiple dimensions at once.
* **Exposes data to tooltips and calculations:** Fields on **Detail** become available in the tooltip and affect how view-level aggregations and table calculations are computed.

## Common Use Cases

* **Scatter plots:** A single mark showing overall *Sales* vs. *Profit* splits into individual points for each *Customer Name* or *Sub-Category* when that field is added to **Detail**.
* **Stacked bars or segmented marks:** Adding a dimension to **Detail** divides a bar or mark into smaller segments without altering the axis headers.
* **Uncluttered breakdowns:** When you want finer granularity or hover context without adding extra colors, shapes, or table headers, **Detail** keeps the visual encoding minimal.

