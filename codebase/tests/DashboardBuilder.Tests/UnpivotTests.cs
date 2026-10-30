using System.Net;
using System.Net.Http.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The bounded unpivot preview (POST /api/unpivot): input rules, column picking, SQL shape.</summary>
public class UnpivotTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public UnpivotTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static UnpivotRequest U(string[]? columns = null, string[]? keep = null, int? limit = null, string db = "d", string table = "t")
        => new(db, table, columns ?? ["a", "b"], keep, limit);
    private static string? FieldOf(UnpivotRequest r) { try { RequestRules.ValidateUnpivot(r); return null; } catch (RequestValidationException e) { return e.Field; } }

    [Fact] public void A_valid_request_passes() => Assert.Null(FieldOf(U()));
    [Fact] public void Db_and_table_are_required()
    {
        Assert.Equal("db", FieldOf(U(db: " ")));
        Assert.Equal("table", FieldOf(U(table: "")));
    }
    [Fact] public void Two_to_fifty_columns_are_required()
    {
        Assert.Equal(50, ApiLimits.MaxUnpivotColumns);
        Assert.Equal("columns", FieldOf(U(columns: ["a"])));
        Assert.Equal("columns", FieldOf(U(columns: Enumerable.Range(0, 51).Select(i => "c" + i).ToArray())));
        Assert.Null(FieldOf(U(columns: Enumerable.Range(0, 50).Select(i => "c" + i).ToArray())));
        Assert.Equal("columns[1]", FieldOf(U(columns: ["a", " "])));
    }
    [Fact] public void A_column_twice_or_also_kept_is_refused()
    {
        Assert.Equal("columns[1]", FieldOf(U(columns: ["a", "a"])));
        Assert.Equal("keep[0]", FieldOf(U(keep: ["a"])));
    }
    [Fact] public void At_most_five_kept_columns_none_blank()
    {
        Assert.Equal(5, ApiLimits.MaxUnpivotKeep);
        Assert.Equal("keep", FieldOf(U(keep: ["k1", "k2", "k3", "k4", "k5", "k6"])));
        Assert.Equal("keep[0]", FieldOf(U(keep: [""])));
        Assert.Null(FieldOf(U(keep: ["k1", "k2", "k3", "k4", "k5"])));
    }
    [Theory] [InlineData(0)] [InlineData(1001)] [InlineData(-1)]
    public void An_out_of_range_limit_is_rejected_not_clamped(int limit) => Assert.Equal("limit", FieldOf(U(limit: limit)));
    private static List<ColumnInfo> C(params (string, string, string)[] c) => c.Select(x => new ColumnInfo(x.Item1, x.Item2, x.Item3)).ToList();

    [Fact] public void The_unpivoted_columns_must_exist_and_share_a_kind()
    {
        var cols = C(("id", "UInt64", "numeric"), ("q1", "Int32", "numeric"), ("q2", "Float64", "numeric"), ("note", "String", "text"));
        ClickHouseGateway.CheckUnpivot(cols, ["q1", "q2"], ["id"]);
        var ex = Assert.Throws<RequestValidationException>(() => ClickHouseGateway.CheckUnpivot(cols, ["q1", "note"], ["id"]));
        Assert.Equal("columns[1]", ex.Field);
        Assert.Throws<UnknownIdentifierException>(() => ClickHouseGateway.CheckUnpivot(cols, ["q1", "nope"], []));
        Assert.Throws<UnknownIdentifierException>(() => ClickHouseGateway.CheckUnpivot(cols, ["q1", "q2"], ["nope"]));
    }
    [Fact] public void The_sql_quotes_every_identifier_binds_the_field_names_and_bounds_the_unpivoted_rows()
    {
        var sql = ClickHouseGateway.BuildUnpivotSql("d`b", "t`x", ["k`1"], ["q`1", "q2"], 5);
        var cell = "if(isNull(`q\\`1`), NULL, left(toString(`q\\`1`), 1001))";
        var cell2 = "if(isNull(`q2`), NULL, left(toString(`q2`), 1001))";
        var keep = "if(isNull(`k\\`1`), NULL, left(toString(`k\\`1`), 1001))";
        Assert.Equal(
            $"SELECT `k0`, tupleElement(`__p`, 1) AS `__n`, tupleElement(`__p`, 2) AS `__v` FROM (" +
            $"SELECT {keep} AS `k0`, arrayJoin([({{n0:String}}, {cell}), ({{n1:String}}, {cell2})]) AS `__p` FROM `d\\`b`.`t\\`x` LIMIT 5)", sql);
        Assert.DoesNotContain("ORDER BY", sql);
    }

    [Fact] public async Task Unpivot_without_a_connection_returns_409()
    {
        var resp = await _factory.CreateClient().PostAsJsonAsync("/api/unpivot", new { db = "d", table = "t", columns = new[] { "a", "b" } });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
    [Fact] public async Task Unpivot_only_accepts_post()
        => Assert.Equal(HttpStatusCode.MethodNotAllowed, (await _factory.CreateClient().GetAsync("/api/unpivot")).StatusCode);
}
