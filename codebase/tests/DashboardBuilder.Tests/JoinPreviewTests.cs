using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The join safety preview (POST /api/relationships/preview): input rules, exact SQL, key-kind rule, result shape.</summary>
public class JoinPreviewTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public JoinPreviewTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static JoinKeyRef K(string db = "d", string table = "t", string column = "c") => new(db, table, column);
    private static string? FieldOf(JoinPreviewRequest r) { try { JoinPreviewRules.Validate(r); return null; } catch (RequestValidationException e) { return e.Field; } }

    [Fact] public void The_bound_defaults_to_one_million_and_is_capped_there()
    {
        Assert.Equal(1_000_000, JoinPreviewRules.MaxSampleRows);
        Assert.Equal(1_000_000, JoinPreviewRules.Bound(null));
        Assert.Equal(500, JoinPreviewRules.Bound(500));
    }
    [Theory] [InlineData(0)] [InlineData(-1)] [InlineData(1_000_001)]
    public void An_out_of_range_sample_limit_is_rejected_not_clamped(int n) => Assert.Equal("sampleLimit", FieldOf(new(K(), K(), n)));
    [Theory] [InlineData(null)] [InlineData(1)] [InlineData(1_000_000)]
    public void A_sample_limit_in_range_is_accepted(int? n) => Assert.Null(FieldOf(new(K(), K(), n)));
    [Fact] public void Both_ends_need_db_table_and_column()
    {
        Assert.Equal("from", FieldOf(new(null!, K(), null)));
        Assert.Equal("to", FieldOf(new(K(), null!, null)));
        Assert.Equal("from.db", FieldOf(new(K(db: ""), K(), null)));
        Assert.Equal("to.table", FieldOf(new(K(), K(table: " "), null)));
        Assert.Equal("to.column", FieldOf(new(K(), K(column: ""), null)));
    }

    [Fact] public void The_side_sql_is_one_bounded_read_only_select_with_every_identifier_quoted()
    {
        var sql = ClickHouseGateway.BuildJoinSideSql("d", "a", "k", "d", "b", "k", 1000, textKeys: false);
        Assert.Equal(
            "SELECT sum(cnt), sumIf(cnt, isNull(k)), countIf(isNotNull(k)), maxIf(cnt, isNotNull(k)), " +
            "sumIf(cnt, isNotNull(k) AND k IN (SELECT k FROM (SELECT `k` AS k FROM `d`.`b` LIMIT 1000) WHERE isNotNull(k))), " +
            "countIf(isNotNull(k) AND k IN (SELECT k FROM (SELECT `k` AS k FROM `d`.`b` LIMIT 1000) WHERE isNotNull(k))) " +
            "FROM (SELECT k, count() AS cnt FROM (SELECT `k` AS k FROM `d`.`a` LIMIT 1000) GROUP BY k)", sql);
    }
    [Fact] public void Text_keys_compare_as_strings()
    {
        var sql = ClickHouseGateway.BuildJoinSideSql("d", "a", "k", "d", "b", "k", 10, textKeys: true);
        Assert.Contains("(SELECT toString(`k`) AS k FROM `d`.`a` LIMIT 10)", sql);
        Assert.Contains("(SELECT toString(`k`) AS k FROM `d`.`b` LIMIT 10)", sql);
    }
    [Fact] public void Hostile_identifiers_stay_inside_their_quotes()
    {
        var sql = ClickHouseGateway.BuildJoinSideSql("d`b", "t\\x", "c`; DROP TABLE x; --", "d2", "t2", "c2", 5, false);
        Assert.Contains("`c\\`; DROP TABLE x; --` AS k FROM `d\\`b`.`t\\\\x` LIMIT 5", sql);
        Assert.DoesNotContain("ORDER BY", sql);
        Assert.StartsWith("SELECT ", sql);
    }
    [Fact] public void The_limit_is_a_validated_integer_never_text()
        => Assert.Throws<ArgumentOutOfRangeException>(() => ClickHouseGateway.BuildJoinSideSql("d", "a", "k", "d", "b", "k", 0, false));

    [Fact] public void Keys_of_different_kinds_are_refused_with_the_dialogs_wording()
    {
        var msg = Assert.Throws<RequestValidationException>(() =>
            JoinPreviewRules.CheckKinds(new("id", "UInt32", "numeric"), new("code", "String", "text"), "orders.id", "tags.code")).Message;
        Assert.Equal("Can't relate orders.id (numeric) to tags.code (text) — join keys must hold the same kind of value.", msg);
        Assert.Throws<RequestValidationException>(() => JoinPreviewRules.CheckKinds(new("a", "Array(Int32)", "compound"), new("a", "Array(Int32)", "compound"), "x.a", "y.a"));
        JoinPreviewRules.CheckKinds(new("id", "UInt32", "numeric"), new("id", "Nullable(Int64)", "numeric"), "a.id", "b.id");
        JoinPreviewRules.CheckKinds(new("d", "Date", "temporal"), new("d", "DateTime", "temporal"), "a.d", "b.d");
    }

    [Fact] public void The_result_serialises_camelCase_with_the_raw_counts_and_the_sampled_flag()
    {
        var side = new JoinSideStats(10, 1, 3, 2, 6, 4, 3.0);
        var json = JsonSerializer.Serialize(new JoinPreviewResult(side, side, 1000, false), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Contains("\"from\":{\"rows\":10,\"nullRows\":1,\"keys\":3,\"matchedKeys\":2,\"matchedRows\":6,\"maxDuplicates\":4,\"avgDuplicates\":3", json);
        Assert.Contains("\"sampleLimit\":1000,\"sampled\":false", json);
    }

    [Fact] public async Task Preview_without_a_connection_returns_409()
    {
        var resp = await _factory.CreateClient().PostAsJsonAsync("/api/relationships/preview", new { from = new { db = "d", table = "a", column = "k" }, to = new { db = "d", table = "b", column = "k" } });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
    [Fact] public async Task Preview_only_accepts_post()
    {
        var resp = await _factory.CreateClient().GetAsync("/api/relationships/preview");
        Assert.Equal(HttpStatusCode.MethodNotAllowed, resp.StatusCode);
    }
}
