using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The bounded row-level endpoint (POST /api/rows): input rules, SQL shape, result shape.</summary>
public class RowsTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public RowsTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static RowsRequest R(int? limit = null, string[]? columns = null, StatFilter[]? filters = null, string db = "d", string table = "t")
        => new(db, table, columns, filters, limit);
    private static string? FieldOf(RowsRequest r) { try { RequestRules.ValidateRows(r); return null; } catch (RequestValidationException e) { return e.Field; } }

    [Fact] public void Limit_defaults_to_100_and_the_cap_is_1000()
    {
        Assert.Equal(100, ApiLimits.DefaultRowsLimit);
        Assert.Equal(1000, ApiLimits.MaxRowsLimit);
        Assert.Equal(101, ClickHouseGateway.RowsProbeLimit(null));
        Assert.Equal(1001, ClickHouseGateway.RowsProbeLimit(1000));
    }
    [Theory] [InlineData(0)] [InlineData(-5)] [InlineData(1001)] [InlineData(100000)]
    public void An_out_of_range_limit_is_rejected_not_clamped(int limit) => Assert.Equal("limit", FieldOf(R(limit)));
    [Theory] [InlineData(null)] [InlineData(1)] [InlineData(1000)]
    public void A_limit_in_range_is_accepted(int? limit) => Assert.Null(FieldOf(R(limit)));
    [Fact] public void Db_and_table_are_required()
    {
        Assert.Equal("db", FieldOf(R(db: "")));
        Assert.Equal("table", FieldOf(R(table: " ")));
    }
    [Fact] public void Too_many_or_blank_columns_are_rejected()
    {
        Assert.Equal("columns", FieldOf(R(columns: Enumerable.Range(0, ApiLimits.MaxRowsColumns + 1).Select(i => "c" + i).ToArray())));
        Assert.Equal("columns[1]", FieldOf(R(columns: ["a", ""])));
        Assert.Equal("columns[0]", FieldOf(R(columns: [null!])));
    }
    [Fact] public void Filters_are_capped_and_top_n_is_refused()
    {
        var many = Enumerable.Range(0, ApiLimits.MaxFilters + 1).Select(_ => new StatFilter("a", "=", "1")).ToArray();
        Assert.Equal("filters", FieldOf(R(filters: many)));
        Assert.Equal("filters[0].op", FieldOf(R(filters: [new StatFilter("a", "top", "5")])));
        Assert.Equal("filters[0].op", FieldOf(R(filters: [new StatFilter("a", "drop", "5")])));
    }

    [Fact] public void The_sql_quotes_every_identifier_and_limits_to_the_probe()
    {
        var sql = ClickHouseGateway.BuildRowsSql("d`b", "t", ["a`; DROP TABLE x; --", "b"], " WHERE `b` = {p0:String}", 101);
        Assert.Equal("SELECT if(isNull(`a\\`; DROP TABLE x; --`), NULL, left(toString(`a\\`; DROP TABLE x; --`), 1001)), if(isNull(`b`), NULL, left(toString(`b`), 1001)) FROM `d\\`b`.`t` WHERE `b` = {p0:String} LIMIT 101", sql);
        Assert.DoesNotContain("ORDER BY", sql);
    }
    [Fact] public void An_offset_is_0_to_100000_and_never_clamped()
    {
        Assert.Null(FieldOf(new RowsRequest("db", "t", null, null, 100, null, 0)));
        Assert.Null(FieldOf(new RowsRequest("db", "t", null, null, 100, null, ApiLimits.MaxRowsOffset)));
        Assert.Equal("offset", FieldOf(new RowsRequest("db", "t", null, null, 100, null, -1)));
        Assert.Equal("offset", FieldOf(new RowsRequest("db", "t", null, null, 100, null, ApiLimits.MaxRowsOffset + 1)));
    }

    [Fact] public void A_paged_read_skips_its_offset_and_reads_a_stored_table_on_one_thread()
    {
        Assert.Equal(("", ""), ClickHouseGateway.PageClause(null, true, QueryGuards.Full));                 // every other caller: unchanged
        Assert.Equal(("", " SETTINGS max_threads = 1"), ClickHouseGateway.PageClause(0, true, QueryGuards.Full)); // page 1 reads in the same order as page 2
        Assert.Equal((" OFFSET 200", " SETTINGS max_threads = 1"), ClickHouseGateway.PageClause(200, true, QueryGuards.NoTimeLimit));
        Assert.Equal((" OFFSET 200", ""), ClickHouseGateway.PageClause(200, false, QueryGuards.Full));       // custom SQL: read as written
        Assert.Equal((" OFFSET 200", ""), ClickHouseGateway.PageClause(200, true, QueryGuards.None));        // a server that takes no settings
        var (skip, settings) = ClickHouseGateway.PageClause(100, true, QueryGuards.Full);
        Assert.EndsWith("LIMIT 101 OFFSET 100 SETTINGS max_threads = 1", ClickHouseGateway.BuildRowsSql("db", "t", ["a"], "", 101, null, skip + settings));
        var unpivot = ClickHouseGateway.BuildUnpivotSql("db", "t", [], ["a", "b"], 101, null, skip, settings);
        Assert.EndsWith("LIMIT 101 OFFSET 100) SETTINGS max_threads = 1", unpivot); // the offset counts unpivoted rows; SETTINGS ends the statement
    }

    [Fact] public void Filters_bind_values_through_the_existing_typed_rules()
    {
        var cols = new Dictionary<string, ColumnInfo> { ["n"] = new("n", "Float64", "numeric") };
        var p = new List<(string Name, string Type, object Value)>();
        var where = ClickHouseGateway.BuildSingleTableFilters([new StatFilter("n", "=", "1")], cols, p);
        Assert.Equal(" WHERE `n` = {p0:Float64}", where);
        Assert.Equal([("p0", "Float64", (object)1.0)], p);
        Assert.Throws<RequestValidationException>(() => ClickHouseGateway.BuildSingleTableFilters([new StatFilter("n", "=", "1; DROP")], cols, []));
    }
    [Fact] public void A_filter_on_an_unknown_column_is_an_unknown_identifier()
    {
        var cols = new Dictionary<string, ColumnInfo> { ["n"] = new("n", "Float64", "numeric") };
        Assert.Throws<UnknownIdentifierException>(() => ClickHouseGateway.BuildSingleTableFilters([new StatFilter("zz", "=", "1")], cols, []));
    }

    [Fact] public void The_cell_cut_happens_in_sql_and_keeps_null()
    {
        var e = ClickHouseGateway.RowSelectExpr("v");
        Assert.Equal("if(isNull(`v`), NULL, left(toString(`v`), 1001))", e);
    }
    [Fact] public void Rows_times_columns_is_capped()
    {
        Assert.Equal(50_000, ApiLimits.MaxRowsCells);
        Assert.Equal("limit", FieldOf(R(limit: 1000, columns: Enumerable.Range(0, 51).Select(i => "c" + i).ToArray())));
        Assert.Null(FieldOf(R(limit: 1000, columns: Enumerable.Range(0, 50).Select(i => "c" + i).ToArray())));
        var ex = Assert.Throws<RequestValidationException>(() => RequestRules.ValidateRowCells(1000, 200, "limit"));
        Assert.Equal("limit", ex.Field); Assert.Contains("250 rows", ex.Message);
        RequestRules.ValidateRowCells(250, 200, "limit");
    }
    [Fact] public void A_cell_is_text_or_null_and_a_long_one_is_cut()
    {
        Assert.Null(ClickHouseGateway.RowCell(null));
        Assert.Null(ClickHouseGateway.RowCell(DBNull.Value));
        Assert.Equal("5", ClickHouseGateway.RowCell(5L));
        var cut = ClickHouseGateway.RowCell(new string('x', ApiLimits.MaxCellLength + 50))!;
        Assert.Equal(ApiLimits.MaxCellLength + 1, cut.Length);
        Assert.EndsWith("…", cut);
    }
    [Fact] public void The_default_column_set_is_capped()
    {
        var all = Enumerable.Range(0, ApiLimits.MaxRowsColumns + 5).Select(i => new ColumnInfo("c" + i, "String", "text")).ToList();
        var (picked, truncated) = ClickHouseGateway.PickRowColumns(all, null);
        Assert.Equal(ApiLimits.MaxRowsColumns, picked.Count); Assert.True(truncated);
        var (two, t2) = ClickHouseGateway.PickRowColumns(all, ["c3", "c1"]);
        Assert.Equal(["c3", "c1"], two.Select(c => c.Name)); Assert.False(t2);
        Assert.Throws<UnknownIdentifierException>(() => ClickHouseGateway.PickRowColumns(all, ["nope"]));
    }
    [Fact] public void The_result_tells_the_client_it_was_truncated()
    {
        var json = JsonSerializer.Serialize(new RowsResult([new RowColumn("a", "String")], [["x"], [null]], true, 100, false), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Contains("\"truncated\":true", json);
        Assert.Contains("\"rows\":[[\"x\"],[null]]", json);
        Assert.Contains("\"columns\":[{\"name\":\"a\",\"type\":\"String\"}]", json);
    }

    [Fact] public async Task Rows_without_a_connection_returns_409()
    {
        var resp = await _factory.CreateClient().PostAsJsonAsync("/api/rows", new { db = "d", table = "t" });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
    [Fact] public async Task Rows_only_accepts_post()
    {
        var resp = await _factory.CreateClient().GetAsync("/api/rows");
        Assert.Equal(HttpStatusCode.MethodNotAllowed, resp.StatusCode);
    }
}
