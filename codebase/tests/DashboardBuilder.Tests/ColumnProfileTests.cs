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

    [Fact] public void The_stats_sql_scans_the_whole_column_and_quotes_every_identifier()
    {
        var sql = ClickHouseGateway.BuildProfileStatsSql("d`b", "t", "a`; DROP TABLE x; --", ClickHouseType.Numeric);
        Assert.Equal("SELECT count() AS n, countIf(isNull(v)) AS nulls, uniq(v) AS d, toString(min(v)) AS lo, toString(max(v)) AS hi, " +
                     "avg(toFloat64(v)) AS mean, stddevSamp(toFloat64(v)) AS sd, quantile(0.25)(toFloat64(v)) AS q1, quantile(0.5)(toFloat64(v)) AS med, quantile(0.75)(toFloat64(v)) AS q3 " +
                     "FROM (SELECT `a\\`; DROP TABLE x; --` AS v FROM `d\\`b`.`t`)", sql);
    }
    [Fact] public void The_numeric_summary_is_cast_to_float_and_never_exact_or_a_sum()
    {
        var sql = ClickHouseGateway.BuildProfileStatsSql("d", "t", "a", ClickHouseType.Numeric);
        Assert.Contains("quantile(0.5)(toFloat64(v))", sql); // the box plot's function: approximate, bounded memory
        Assert.DoesNotContain("quantileExact", sql);      // would hold every value of a whole-table scan
        Assert.DoesNotContain("sum(", sql);               // sum wraps silently on 64-bit integers
        foreach (var other in new[] { ClickHouseType.Text, ClickHouseType.Temporal, ClickHouseType.Compound })
            Assert.DoesNotContain("avg(", ClickHouseGateway.BuildProfileStatsSql("d", "t", "a", other));
    }
    [Fact] public void A_summary_figure_is_finite_or_null()
    {
        Assert.Null(ClickHouseGateway.ProfileFigure(null, 5, 0));
        Assert.Null(ClickHouseGateway.ProfileFigure(double.NaN, 5, 0));
        Assert.Null(ClickHouseGateway.ProfileFigure(double.PositiveInfinity, 5, 0));
        Assert.Null(ClickHouseGateway.ProfileFigure(3.5, 0, 0));
        Assert.Null(ClickHouseGateway.ProfileFigure(3.5, 5, 5));
        Assert.Equal(3.5, ClickHouseGateway.ProfileFigure(3.5, 5, 1));
    }
    [Fact] public void Text_has_no_min_max_and_compound_columns_are_stringified()
    {
        Assert.Equal("SELECT count() AS n, countIf(isNull(v)) AS nulls, uniq(v) AS d FROM (SELECT `s` AS v FROM `d`.`t`)",
            ClickHouseGateway.BuildProfileStatsSql("d", "t", "s", ClickHouseType.Text));
        Assert.Contains("(SELECT toString(`arr`) AS v FROM", ClickHouseGateway.BuildProfileStatsSql("d", "t", "arr", ClickHouseType.Compound));
        Assert.DoesNotContain("min(", ClickHouseGateway.BuildProfileStatsSql("d", "t", "arr", ClickHouseType.Compound));
    }
    [Fact] public void Dates_get_min_max()
        => Assert.Contains("toString(min(v)) AS lo", ClickHouseGateway.BuildProfileStatsSql("d", "t", "ts", ClickHouseType.Temporal));
    [Fact] public void The_top_sql_groups_on_the_cut_label_in_characters_not_bytes_and_keeps_null()
    {
        var sql = ClickHouseGateway.BuildProfileTopSql("d", "t", "a`b", 10);
        Assert.Equal("SELECT label, cut, count() AS cnt FROM (SELECT if(isNull(`a\\`b`), NULL, leftUTF8(toString(`a\\`b`), 100)) AS label, " +
                     "if(isNull(`a\\`b`), 0, lengthUTF8(toString(`a\\`b`)) > 100) AS cut " +
                     "FROM `d`.`t`) GROUP BY label, cut ORDER BY cnt DESC, label ASC, cut ASC LIMIT 10", sql);
    }
    [Fact] public void The_backstop_settings_bound_the_memory_and_never_the_rows()
    {
        Assert.DoesNotContain("max_rows_to_read", ClickHouseGateway.ProfileSettings);
        Assert.DoesNotContain("read_overflow_mode", ClickHouseGateway.ProfileSettings);
        Assert.DoesNotContain("LIMIT 1000000", ClickHouseGateway.BuildProfileStatsSql("d", "t", "a", ClickHouseType.Numeric));
        Assert.Contains("max_memory_usage", ClickHouseGateway.ProfileSettings);
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
