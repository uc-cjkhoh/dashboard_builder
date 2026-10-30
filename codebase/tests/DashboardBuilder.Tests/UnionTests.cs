using System.Net;
using System.Net.Http.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The bounded UNION ALL of tables (POST /api/union): input rules, column matching, SQL shape.</summary>
public class UnionTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public UnionTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static UnionRequest U(string[]? tables = null, string[]? columns = null, int? limit = null, string db = "d")
        => new(db, tables ?? ["a", "b"], columns, limit);
    private static string? FieldOf(UnionRequest r) { try { RequestRules.ValidateUnion(r); return null; } catch (RequestValidationException e) { return e.Field; } }

    [Fact] public void A_valid_request_passes() => Assert.Null(FieldOf(U()));
    [Fact] public void Db_is_required() => Assert.Equal("db", FieldOf(U(db: " ")));
    [Fact] public void Two_to_five_tables_are_required()
    {
        Assert.Equal(5, ApiLimits.MaxUnionTables);
        Assert.Equal("tables", FieldOf(U(tables: ["a"])));
        Assert.Equal("tables", FieldOf(U(tables: [])));
        Assert.Equal("tables", FieldOf(U(tables: ["a", "b", "c", "d", "e", "f"])));
        Assert.Null(FieldOf(U(tables: ["a", "b", "c", "d", "e"])));
        Assert.Equal("tables[1]", FieldOf(U(tables: ["a", ""])));
    }
    [Theory] [InlineData(0)] [InlineData(1001)] [InlineData(-1)]
    public void An_out_of_range_limit_is_rejected_not_clamped(int limit) => Assert.Equal("limit", FieldOf(U(limit: limit)));
    [Fact] public void Columns_are_bounded_and_not_blank()
    {
        Assert.Equal("columns", FieldOf(U(columns: Enumerable.Range(0, ApiLimits.MaxRowsColumns + 1).Select(i => "c" + i).ToArray())));
        Assert.Equal("columns[0]", FieldOf(U(columns: [""])));
        Assert.Equal("limit", FieldOf(U(limit: 1000, columns: Enumerable.Range(0, 50).Select(i => "c" + i).ToArray())));
    }

    private static List<ColumnInfo> C(params (string, string, string)[] c) => c.Select(x => new ColumnInfo(x.Item1, x.Item2, x.Item3)).ToList();

    [Fact] public void The_default_columns_are_those_every_table_shares_by_name_and_kind()
    {
        var a = C(("id", "UInt64", "numeric"), ("name", "String", "text"), ("only_a", "String", "text"), ("when", "Date", "date"));
        var b = C(("name", "Nullable(String)", "text"), ("id", "Int32", "numeric"), ("when", "String", "text"));
        var cols = ClickHouseGateway.PickUnionColumns([a, b], null);
        Assert.False(cols.Truncated);
        Assert.Equal(["id", "name"], cols.Columns.Select(c => c.Name));
    }
    [Fact] public void No_shared_column_is_a_400()
    {
        var ex = Assert.Throws<RequestValidationException>(() => ClickHouseGateway.PickUnionColumns([C(("x", "String", "text")), C(("y", "String", "text"))], null));
        Assert.Equal("tables", ex.Field);
    }
    [Fact] public void A_requested_column_must_exist_in_every_table_with_the_same_kind()
    {
        var a = C(("id", "UInt64", "numeric"), ("t", "String", "text"));
        var b = C(("id", "UInt64", "numeric"), ("t", "Date", "date"));
        Assert.Equal(["id"], ClickHouseGateway.PickUnionColumns([a, b], ["id"]).Columns.Select(c => c.Name));
        var ex = Assert.Throws<RequestValidationException>(() => ClickHouseGateway.PickUnionColumns([a, b], ["t"]));
        Assert.Equal("columns[0]", ex.Field);
        Assert.Throws<UnknownIdentifierException>(() => ClickHouseGateway.PickUnionColumns([a, b], ["nope"]));
    }
    [Fact] public void A_wide_shared_set_is_cut_and_says_so()
    {
        var wide = Enumerable.Range(0, ApiLimits.MaxRowsColumns + 3).Select(i => new ColumnInfo("c" + i, "String", "text")).ToList();
        var (cols, truncated) = ClickHouseGateway.PickUnionColumns([wide, wide], null);
        Assert.Equal(ApiLimits.MaxRowsColumns, cols.Count); Assert.True(truncated);
    }
    [Theory] [InlineData(100, 2, 50)] [InlineData(20, 3, 7)] [InlineData(1, 5, 1)] [InlineData(1000, 5, 200)]
    public void Each_table_gets_an_even_share_rounded_up(int limit, int tables, int share) => Assert.Equal(share, ClickHouseGateway.UnionShare(limit, tables));
    [Fact] public void The_sql_quotes_every_identifier_binds_the_source_and_bounds_every_branch()
    {
        var sql = ClickHouseGateway.BuildUnionSql("d`b", ["a`x", "b"], ["c`; DROP TABLE x; --"], 11);
        Assert.Equal(
            "SELECT * FROM (" +
            "(SELECT {s0:String} AS `__usrc`, if(isNull(`c\\`; DROP TABLE x; --`), NULL, left(toString(`c\\`; DROP TABLE x; --`), 1001)) AS `__uc0` FROM `d\\`b`.`a\\`x` LIMIT 11) UNION ALL " +
            "(SELECT {s1:String} AS `__usrc`, if(isNull(`c\\`; DROP TABLE x; --`), NULL, left(toString(`c\\`; DROP TABLE x; --`), 1001)) AS `__uc0` FROM `d\\`b`.`b` LIMIT 11)" +
            ")", sql);
        Assert.DoesNotContain("ORDER BY", sql);
    }
    [Fact] public void Helper_aliases_never_shadow_a_source_column_named_like_them()
    {
        var sql = ClickHouseGateway.BuildUnionSql("d", ["a", "b"], ["x", "c0"], 5, ["x", "c0", "__usrc", "__uc0", "__uc1"]);
        Assert.Contains("AS `__u_c0`", sql); Assert.Contains("AS `__u_c1`", sql); Assert.Contains("AS `__u_src`", sql);
        Assert.DoesNotContain("AS `c0`", sql);
    }

    [Fact] public async Task Union_without_a_connection_returns_409()
    {
        var resp = await _factory.CreateClient().PostAsJsonAsync("/api/union", new { db = "d", tables = new[] { "a", "b" } });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
    [Fact] public async Task Union_only_accepts_post()
        => Assert.Equal(HttpStatusCode.MethodNotAllowed, (await _factory.CreateClient().GetAsync("/api/union")).StatusCode);
}
