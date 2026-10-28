using System.Net;
using System.Net.Http.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The column profile (POST /api/databases/{db}/tables/{table}/profile): limits, SQL shape, gate.</summary>
public class ColumnProfileTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public ColumnProfileTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static string? FieldOf(ProfileRequest r) { try { RequestRules.ValidateProfile(r); return null; } catch (RequestValidationException e) { return e.Field; } }

    [Fact] public void The_bounds_are_explicit()
    {
        Assert.Equal(1_000_000, ApiLimits.ProfileSampleRows);
        Assert.Equal(10, ApiLimits.DefaultProfileTop);
        Assert.Equal(50, ApiLimits.MaxProfileTop);
        Assert.Equal(100, ApiLimits.ProfileValueLength);
    }
    [Fact] public void A_column_is_required() { Assert.Equal("column", FieldOf(new(null!, null))); Assert.Equal("column", FieldOf(new(" ", null))); }
    [Fact] public void An_overlong_column_name_is_rejected() => Assert.Equal("column", FieldOf(new(new string('x', 1001), null)));
    [Theory] [InlineData(0)] [InlineData(-1)] [InlineData(51)] [InlineData(100000)]
    public void An_out_of_range_limit_is_rejected_not_clamped(int limit) => Assert.Equal("limit", FieldOf(new("a", limit)));
    [Theory] [InlineData(null)] [InlineData(1)] [InlineData(50)]
    public void A_limit_in_range_is_accepted(int? limit) => Assert.Null(FieldOf(new("a", limit)));

    [Fact] public void The_stats_sql_scans_a_bounded_subquery_and_quotes_every_identifier()
    {
        var sql = ClickHouseGateway.BuildProfileStatsSql("d`b", "t", "a`; DROP TABLE x; --", ClickHouseType.Numeric);
        Assert.Equal("SELECT count() AS n, countIf(isNull(v)) AS nulls, uniq(v) AS d, toString(min(v)) AS lo, toString(max(v)) AS hi " +
                     "FROM (SELECT `a\\`; DROP TABLE x; --` AS v FROM `d\\`b`.`t` LIMIT 1000000)", sql);
    }
    [Fact] public void Text_has_no_min_max_and_compound_columns_are_stringified()
    {
        Assert.Equal("SELECT count() AS n, countIf(isNull(v)) AS nulls, uniq(v) AS d FROM (SELECT `s` AS v FROM `d`.`t` LIMIT 1000000)",
            ClickHouseGateway.BuildProfileStatsSql("d", "t", "s", ClickHouseType.Text));
        Assert.Contains("(SELECT toString(`arr`) AS v FROM", ClickHouseGateway.BuildProfileStatsSql("d", "t", "arr", ClickHouseType.Compound));
        Assert.DoesNotContain("min(", ClickHouseGateway.BuildProfileStatsSql("d", "t", "arr", ClickHouseType.Compound));
    }
    [Fact] public void Dates_get_min_max()
        => Assert.Contains("toString(min(v)) AS lo", ClickHouseGateway.BuildProfileStatsSql("d", "t", "ts", ClickHouseType.Temporal));
    [Fact] public void The_top_sql_ranks_by_count_then_value_cuts_in_sql_and_keeps_null()
    {
        var sql = ClickHouseGateway.BuildProfileTopSql("d", "t", "a`b", ClickHouseType.Text, 10);
        Assert.Equal("SELECT if(isNull(v), NULL, left(toString(v), 101)) AS label, count() AS cnt " +
                     "FROM (SELECT `a\\`b` AS v FROM `d`.`t` LIMIT 1000000) GROUP BY v ORDER BY cnt DESC, v ASC LIMIT 10", sql);
    }
    [Fact] public void Cut_values_are_marked_and_trimmed_to_100_characters()
    {
        Assert.Equal(("abc", false), ClickHouseGateway.CutProfileValue("abc"));
        var (text, cut) = ClickHouseGateway.CutProfileValue(new string('x', 101));
        Assert.True(cut); Assert.Equal(100, text!.Length);
        Assert.Equal((null, false), ClickHouseGateway.CutProfileValue(null));
    }
    [Fact] public void Min_and_max_are_hidden_for_an_empty_or_all_null_column()
    {
        Assert.Null(ClickHouseGateway.ProfileExtreme("0", rows: 0, nulls: 0));
        Assert.Null(ClickHouseGateway.ProfileExtreme(null, rows: 5, nulls: 5));
        Assert.Equal("7", ClickHouseGateway.ProfileExtreme("7", rows: 5, nulls: 1));
    }

    [Fact] public async Task Profile_without_a_connection_returns_409()
    {
        var resp = await _factory.CreateClient().PostAsJsonAsync("/api/databases/d/tables/t/profile", new { column = "a" });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
}
