---
components: [src/DashboardBuilder/Features/Rows/UnionController.cs, src/DashboardBuilder/Features/Rows/UnpivotController.cs, src/DashboardBuilder/ClickHouse/ClickHouseGateway.cs, src/DashboardBuilder/ClickHouse/RequestValidation.cs]
---
# API: union and unpivot rows

The two row reads that reshape tables, both answered in the [`/api/rows`](api.md#rows) shape. The rest of the API: [api.md](api.md); errors and limits: [api.md § Errors](api.md#errors), [§ Limits](api.md#limits).

## Union

Controller: `Features/Rows/UnionController.cs`. `POST /api/union` stacks the **first rows of 2–5 tables of one database**
(`UNION ALL`) and answers in the `/api/rows` shape. The first column is `Source table` (the table's name, bound as a
parameter), followed by the shared columns. No ordering, no aggregation, no filters.

| Field | Rule |
|---|---|
| `db`, `tables` | `db` required; `tables` 2–5 names (`ApiLimits.MaxUnionTables`, mirrored by `LIMITS.unionTables`), each blank → 400 (`tables[i]`), unknown → 400/404 |
| `columns` | optional, ≤ 200. Default: the columns **every** table has with the same name **and kind** (text / number / date …), in the first table's order; none shared → 400 (`tables`). A requested column missing from a table is an unknown identifier; one whose kind differs between tables is a 400 (`columns[i]`). Types shown are the first table's |
| `limit` | 1–1000, default 100, never clamped; (columns + 1) × rows ≤ 50,000. Each table gets an even share (`ceil(limit / tables)`) and is read to share + 1 inside ClickHouse, so every table shows; `truncated` = some table (or the total) had more; `columnsTruncated` when more than 200 columns are shared |

Cells are cut in SQL like `/api/rows`. The data preview of an existing union card reads it; no UI button calls it directly any more ([D138](../decisions/decisions-custom-sql.md#d138--union-and-unpivot-are-written-in-edit-sql-not-built-in-the-sidebar)).

## Unpivot

Controller: `Features/Rows/UnpivotController.cs`. `POST /api/unpivot` turns **wide columns of one table into rows**: each source row becomes
one row per chosen column, answered in the `/api/rows` shape. No ordering, no aggregation, no filters.

- **Columns:** the `keep` columns, then `Field` (the column's name, bound as a parameter) and `Value`
  (the cell as text, typed `String`; NULL stays `null`). A kept column already named `Field` or `Value`
  turns ours into `Field_` / `Value_`.
- Helper aliases in the SQL (here and in the union) use a prefix (`__u`, grown with `_`) that no table column starts with, because ClickHouse resolves a select alias ahead of a same-named column.

| Field | Rule |
|---|---|
| `db`, `table` | required; unknown → 400/404 |
| `columns` | 2–50 distinct names (`ApiLimits.MaxUnpivotColumns`, mirrored by `LIMITS.unpivotColumns`); blank or repeated → 400 (`columns[i]`); unknown → unknown identifier; all must be the **same kind** (text / number / date …), else 400 (`columns[i]`) |
| `keep` | optional, ≤ 5 (`MaxUnpivotKeep` / `LIMITS.unpivotKeep`); blank → 400 (`keep[i]`); also in `columns` → 400 (`keep[i]`) |
| `limit` | 1–1000, default 100, never clamped. The statement has one `LIMIT limit + 1`, which ClickHouse applies **after** the `arrayJoin`, so it bounds the unpivoted rows (a source row is read only as far as needed); `truncated` = more existed |
| `offset` | optional, 0–100,000, as in `/api/rows`: `OFFSET n` on the same inner `LIMIT`, so it counts **unpivoted** rows; when sent, the statement ends `SETTINGS max_threads = 1` (checked on ClickHouse 26.8 under `readonly=2`) |

Cells are cut in SQL like `/api/rows`. The data preview of an existing unpivot card reads it; no UI button calls it directly any more.
