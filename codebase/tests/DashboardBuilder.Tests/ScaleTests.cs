using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// Showing all data with bounded requests: table paging (offset), the CSV export cap, the "Other"
/// bucket's request shape, and calendar date grouping (whitelisted grains, "auto" grain choice).
/// </summary>
public class ScaleTests
{
    private static QueryRequest Q(int? limit = null, int? offset = null, string? bucket = null) =>
        new(new TableRef("db", "t"), null, null, null, null, null, limit, null, offset, null, null, bucket);

    private static string? FieldOf(QueryRequest r, int max = ApiLimits.MaxRowLimit) =>
        Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(r, max)).Field;

    [Fact] public void A_page_offset_is_accepted() => RequestRules.ValidateQuery(Q(limit: 500, offset: 1500));
    [Theory] [InlineData(-1)] [InlineData(ApiLimits.MaxOffset + 1)]
    public void An_out_of_range_offset_is_rejected(int offset) => Assert.Equal("offset", FieldOf(Q(offset: offset)));

    [Fact] public void Export_may_ask_for_the_whole_result() => RequestRules.ValidateQuery(Q(limit: ApiLimits.MaxExportRows), ApiLimits.MaxExportRows);
    [Fact] public void A_view_may_not() => Assert.Equal("limit", FieldOf(Q(limit: ApiLimits.MaxExportRows)));
    [Fact] public void Export_is_still_bounded() => Assert.Equal("limit", FieldOf(Q(limit: ApiLimits.MaxExportRows + 1), ApiLimits.MaxExportRows));
    [Fact] public void The_probe_limit_follows_the_endpoint_cap() => Assert.Equal(100_001, ClickHouseGateway.ProbeLimit(100_000, ApiLimits.MaxExportRows));

    [Theory] [InlineData("auto")] [InlineData("hour")] [InlineData("day")] [InlineData("week")] [InlineData("month")] [InlineData("quarter")] [InlineData("year")]
    public void Known_date_groupings_are_accepted(string grain) => RequestRules.ValidateQuery(Q(bucket: grain));
    [Theory] [InlineData("minute")] [InlineData("Month")] [InlineData("toStartOfMonth")] [InlineData("")]
    public void Unknown_date_groupings_are_rejected(string grain) => Assert.Equal("dateBucket", FieldOf(Q(bucket: grain)));

    [Theory]
    [InlineData("hour", "toStartOfHour(t0.`d`)")]
    [InlineData("day", "toDate(t0.`d`)")]
    [InlineData("week", "toMonday(t0.`d`)")]
    [InlineData("month", "toStartOfMonth(t0.`d`)")]
    [InlineData("quarter", "toStartOfQuarter(t0.`d`)")]
    [InlineData("year", "toStartOfYear(t0.`d`)")]
    public void Each_grain_maps_to_one_whitelisted_function(string grain, string sql)
        => Assert.Equal(sql, ClickHouseGateway.BucketExpression(grain, "t0.`d`"));

    [Fact] public void An_unknown_grain_never_reaches_SQL()
        => Assert.Throws<RequestValidationException>(() => ClickHouseGateway.BucketExpression("x); DROP", "t0.`d`"));

    private static readonly DateTime Start = new(2020, 1, 1);

    [Fact] public void Auto_keeps_few_values_exact()
        => Assert.Null(ClickHouseGateway.PickGrain(ClickHouseGateway.AutoBucketTarget, Start, Start.AddYears(10), dateOnly: false));

    [Theory]
    [InlineData(10.0, false, "hour")]     // ten days of timestamps → 240 hours
    [InlineData(10.0, true, "day")]       // a Date column never goes finer than day
    [InlineData(365.0, false, "day")]     // a year → 365 days
    [InlineData(5 * 365.0, false, "week")]   // five years → ~260 weeks
    [InlineData(20 * 365.0, false, "month")] // twenty years → 240 months
    [InlineData(80 * 365.0, false, "quarter")]
    [InlineData(500 * 365.0, false, "year")]
    public void Auto_picks_the_finest_grain_within_the_target(double days, bool dateOnly, string grain)
        => Assert.Equal(grain, ClickHouseGateway.PickGrain(1_000_000, Start, Start.AddDays(days), dateOnly));
}

/// <summary>Per-dimension date parts: a whitelist mapped to fixed functions; hostile names never reach SQL.</summary>
public class DatePartTests
{
    [Theory]
    [InlineData("year", "toStartOfYear(t0.`d`)")]
    [InlineData("quarter", "toStartOfQuarter(t0.`d`)")]
    [InlineData("month", "toStartOfMonth(t0.`d`)")]
    [InlineData("week", "toMonday(t0.`d`)")]
    [InlineData("day", "toDate(t0.`d`)")]
    [InlineData("hour", "toStartOfHour(t0.`d`)")]
    [InlineData("quarterOfYear", "toQuarter(t0.`d`)")]
    [InlineData("monthOfYear", "toMonth(t0.`d`)")]
    [InlineData("dayOfWeek", "toDayOfWeek(t0.`d`)")]
    [InlineData("hourOfDay", "toHour(t0.`d`)")]
    public void Each_part_maps_to_one_function(string part, string sql) => Assert.Equal(sql, ClickHouseGateway.DatePartExpression(part, "t0.`d`", dateOnly: false));

    [Theory] [InlineData(null)] [InlineData("auto")] [InlineData("exact")]
    public void Auto_and_exact_leave_the_column_alone(string? part) => Assert.Null(ClickHouseGateway.DatePartExpression(part, "t0.`d`", false));

    [Fact] public void A_date_column_never_goes_finer_than_day() => Assert.Equal("toDate(t0.`d`)", ClickHouseGateway.DatePartExpression("hour", "t0.`d`", dateOnly: true));
    [Fact] public void Hour_of_day_needs_a_time() => Assert.Throws<RequestValidationException>(() => ClickHouseGateway.DatePartExpression("hourOfDay", "t0.`d`", dateOnly: true));

    [Theory] [InlineData("toYear(1); DROP TABLE x")] [InlineData("Year")] [InlineData("minute")] [InlineData("")]
    public void Hostile_or_unknown_parts_are_rejected(string part)
    {
        Assert.Throws<RequestValidationException>(() => ClickHouseGateway.DatePartExpression(part, "t0.`d`", false));
        var req = new QueryRequest(new TableRef("db", "t"), null, [new ColumnRef("db", "t", "d", part)], null, null, null, null, null);
        Assert.Equal("datePart", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(req)).Field);
    }
}

/// <summary>Server result cache key.</summary>
public class ResultCacheTests
{
    private static ClickHouseConnectionInfo Info(string user = "u", string pw = "s3cret!", string host = "h") => new(host, 8443, user, pw, true, false);
    private static QueryRequest Q(bool? fresh = null, bool? approx = null, int? limit = 50) =>
        new(new TableRef("db", "t"), null, null, null, null, null, limit, null, Fresh: fresh, Approximate: approx);

    [Fact] public void Fresh_does_not_change_the_key() => Assert.Equal(ClickHouseGateway.CacheKey(Info(), Q(), 5000), ClickHouseGateway.CacheKey(Info(), Q(fresh: true), 5000));
    [Fact] public void The_password_is_never_in_the_key() => Assert.DoesNotContain("s3cret!", ClickHouseGateway.CacheKey(Info(), Q(), 5000));
    [Fact] public void Users_servers_requests_and_caps_get_their_own_entries()
    {
        var k = ClickHouseGateway.CacheKey(Info(), Q(), 5000);
        Assert.NotEqual(k, ClickHouseGateway.CacheKey(Info(user: "other"), Q(), 5000));
        Assert.NotEqual(k, ClickHouseGateway.CacheKey(Info(host: "h2"), Q(), 5000));
        Assert.NotEqual(k, ClickHouseGateway.CacheKey(Info(), Q(approx: true), 5000));
        Assert.NotEqual(k, ClickHouseGateway.CacheKey(Info(), Q(limit: 51), 5000));
        Assert.NotEqual(k, ClickHouseGateway.CacheKey(Info(), Q(), 100_000));
    }
    [Fact] public void A_different_password_for_the_same_user_shares_the_entry() => Assert.Equal(ClickHouseGateway.CacheKey(Info(pw: "a"), Q(), 5000), ClickHouseGateway.CacheKey(Info(pw: "b"), Q(), 5000));
}

/// <summary>Richer filters: text match is bound and case-insensitive; top-N is validated.</summary>
public class RicherFilterTests
{
    private static string Cond(string op, string value, string category = ClickHouseType.Text, List<(string, string, object)>? ps = null)
        => ClickHouseGateway.BuildCondition(op, "p0", "t0.`name`", category, "name", "filters[0]", value, null, ps ?? []);

    [Fact] public void Contains_binds_the_text()
    {
        var ps = new List<(string, string, object)>();
        Assert.Equal("positionCaseInsensitiveUTF8(t0.`name`, {p0:String}) > 0", Cond("contains", "50%_off'); DROP", ps: ps));
        Assert.Equal("50%_off'); DROP", ps[0].Item3); // bound as-is: no pattern, nothing to escape, never in the SQL
    }
    [Fact] public void Starts_and_ends_with_are_case_insensitive()
    {
        Assert.Equal("startsWith(lowerUTF8(t0.`name`), lowerUTF8({p0:String}))", Cond("startsWith", "ab"));
        Assert.Equal("endsWith(lowerUTF8(t0.`name`), lowerUTF8({p0:String}))", Cond("endsWith", "ab"));
    }
    [Fact] public void Text_match_needs_a_text_column() => Assert.Throws<RequestValidationException>(() => Cond("contains", "1", ClickHouseType.Numeric));

    private static QueryRequest Q(params QueryFilter[] f) => new(new TableRef("db", "t"), null, null, null, null, f, null, null);
    private static string? FieldOf(QueryRequest r) => Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(r)).Field;

    [Fact] public void Top_n_needs_a_measure() => Assert.Equal("filters[0].topBy", FieldOf(Q(new QueryFilter("db", "t", "c", "top", "10"))));
    [Theory] [InlineData("0")] [InlineData("1001")] [InlineData("ten")] [InlineData("5; DROP")]
    public void Top_n_is_a_whole_number_1_to_1000(string n) => Assert.Equal("filters[0].value", FieldOf(Q(new QueryFilter("db", "t", "c", "top", n, TopBy: new MeasureRef("db", "t", "x", "sum")))));
    [Fact] public void A_good_top_n_passes() => RequestRules.ValidateQuery(Q(new QueryFilter("db", "t", "c", "top", "10", TopBy: new MeasureRef("db", "t", "x", "sum"), Bottom: true)));
    [Fact] public void Empty_text_match_is_rejected() => Assert.Equal("filters[0].value", FieldOf(Q(new QueryFilter("db", "t", "c", "contains", "  "))));
    [Fact] public void Histograms_refuse_top_n() => Assert.Throws<RequestValidationException>(() => RequestRules.ValidateHistogram(new HistogramRequest("c", null, [new StatFilter("c", "top", "5")])));
}

/// <summary>Join type per relationship.</summary>
public class JoinTypeTests
{
    private static QueryRequest Q(string? type) => new(new TableRef("db", "a"),
        [new JoinRef(new ColumnRef("db", "a", "id"), new ColumnRef("db", "b", "a_id"), type)], null, null, null, null, null, null);
    [Theory] [InlineData(null)] [InlineData("inner")] [InlineData("left")] [InlineData("right")] [InlineData("full")]
    public void Join_types_are_accepted(string? t) => RequestRules.ValidateQuery(Q(t));
    [Theory] [InlineData("RIGHT")] [InlineData("LEFT")] [InlineData("full outer")] [InlineData("left; DROP TABLE x")] [InlineData("cross")]
    public void Anything_else_is_rejected(string t) => Assert.Equal("joins[0].type", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(Q(t))).Field);
    [Theory] [InlineData(null, " INNER JOIN ")] [InlineData("inner", " INNER JOIN ")] [InlineData("left", " LEFT JOIN ")]
    [InlineData("right", " RIGHT JOIN ")] [InlineData("full", " FULL JOIN ")]
    public void Join_keyword_is_a_whitelisted_literal(string? t, string kw) => Assert.Equal(kw, ClickHouseGateway.JoinKeyword(t));
    [Theory] [InlineData(null, false)] [InlineData("inner", false)] [InlineData("left", true)] [InlineData("right", true)] [InlineData("full", true)]
    public void Outer_joins_need_nulls(string? t, bool outer) => Assert.Equal(outer, ClickHouseGateway.IsOuter(t));
    [Theory] [InlineData("right")] [InlineData("full")]
    public void Right_and_full_joins_refuse_a_top_n_filter(string t)
    {
        var q = Q(t) with { Filters = [new QueryFilter("db", "a", "id", "top", "5", null, new MeasureRef("db", "a", "id", "count"))] };
        Assert.Equal("filters[0]", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(q)).Field);
        RequestRules.ValidateQuery(q with { Joins = [q.Joins![0] with { Type = "left" }] }); // left still allows it
    }
    [Fact] public void Right_and_full_joins_do_not_sample() { Assert.True(ClickHouseGateway.CanSample(["inner", "left", null])); Assert.False(ClickHouseGateway.CanSample(["left", "full"])); Assert.False(ClickHouseGateway.CanSample(["right"])); }
    [Fact] public void Left_joins_ask_for_nulls_unless_settings_are_refused()
    {
        var info = new ClickHouseConnectionInfo("h", 8443, "u", "p", true, false);
        Assert.Equal(" SETTINGS join_use_nulls = 1", ClickHouseGateway.Settings(true, info));
        Assert.Equal("", ClickHouseGateway.Settings(false, info));
        Assert.Equal("", ClickHouseGateway.Settings(true, info with { Guards = QueryGuards.None }));
        Assert.True(ClickHouseGateway.NullsUnavailable(["full"], info with { Guards = QueryGuards.None }));
        Assert.False(ClickHouseGateway.NullsUnavailable(["left"], info with { Guards = QueryGuards.None }));
        Assert.False(ClickHouseGateway.NullsUnavailable(["full"], info));
    }
}
