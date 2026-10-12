using DashboardBuilder.ClickHouse; using Xunit;
namespace DashboardBuilder.Tests;
public class ValidationTests
{
    [Theory]
    [InlineData("clickhouse.example.com")] [InlineData("10.168.49.13")] [InlineData("localhost")]
    [InlineData("::1")] [InlineData("[::1]")] [InlineData("ch_1.internal")] [InlineData("  padded.host  ")]
    public void Valid_hosts_pass(string host) => Assert.Null(RequestRules.HostError(host));

    [Theory]
    [InlineData("https://h", RequestRules.HostSchemeMessage)] [InlineData("h:8443", RequestRules.HostPortMessage)]
    [InlineData("[::1]:8443", RequestRules.HostPortMessage)] [InlineData("h/db", RequestRules.HostPathMessage)]
    [InlineData("bad host", RequestRules.HostInvalidMessage)] [InlineData("-bad.com", RequestRules.HostInvalidMessage)]
    [InlineData("   ", "Host is required.")]
    public void Invalid_hosts_say_why(string host, string message) => Assert.Equal(message, RequestRules.HostError(host));

    [Fact] public void An_overlong_host_is_rejected() => Assert.Equal("Host must be at most 253 characters.", RequestRules.HostError(new string('a', 254)));

    [Theory] [InlineData(null, "port")] [InlineData(0, "port")] [InlineData(65536, "port")]
    public void Port_is_required_and_in_range(int? port, string field)
        => Assert.Equal(field, Assert.Throws<RequestValidationException>(() => RequestRules.ValidateConnect("h", port, "u", "")).Field);

    [Fact] public void A_blank_user_is_rejected()
        => Assert.Equal("user", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateConnect("h", 8443, "  ", "")).Field);
    [Fact] public void An_overlong_password_is_rejected()
        => Assert.Equal("password", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateConnect("h", 8443, "u", new string('p', 257))).Field);

    private static QueryRequest Q(int dims = 1, int measures = 1, int joins = 0, QueryFilter[]? filters = null, int? limit = null, SortRef? sort = null) =>
        new(new TableRef("db", "t"),
            Enumerable.Range(0, joins).Select(i => new JoinRef(new ColumnRef("db", "t", "id"), new ColumnRef("db", $"t{i}", "id"))).ToArray(),
            Enumerable.Range(0, dims).Select(i => new ColumnRef("db", "t", $"d{i}")).ToArray(), [],
            Enumerable.Range(0, measures).Select(i => new MeasureRef("db", "t", $"m{i}", "sum")).ToArray(), filters, limit, sort);
    private static QueryFilter F(string op = "=", string? value = "1", string[]? values = null) => new("db", "t", "c", op, value, values);
    private static string? FieldOf(QueryRequest q) => Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(q)).Field;

    [Fact] public void At_the_limits_a_query_passes()
        => RequestRules.ValidateQuery(Q(dims: 12, measures: 10, joins: 10, filters: Enumerable.Repeat(F(), 8).ToArray(), limit: 500));
    [Fact] public void Thirteen_dimensions_are_rejected() => Assert.Equal("rowDimensions", FieldOf(Q(dims: 13)));
    [Fact] public void Eleven_measures_are_rejected() => Assert.Equal("measures", FieldOf(Q(measures: 11)));
    [Fact] public void Eleven_joins_are_rejected() => Assert.Equal("joins", FieldOf(Q(joins: 11)));
    [Fact] public void Nine_filters_are_rejected_not_dropped() => Assert.Equal("filters", FieldOf(Q(filters: Enumerable.Repeat(F(), 9).ToArray())));
    [Theory] [InlineData(0)] [InlineData(501)] public void Out_of_range_limits_are_rejected(int limit) => Assert.Equal("limit", FieldOf(Q(limit: limit)));
    [Fact] public void An_unknown_operator_is_rejected() => Assert.Equal("filters[0].op", FieldOf(Q(filters: [F("LIKE")])));
    [Fact] public void An_empty_in_list_is_rejected() => Assert.Equal("filters[0].values", FieldOf(Q(filters: [F("in", null, [])])));
    [Fact] public void A_501_value_in_list_is_rejected() => Assert.Equal("filters[0].values", FieldOf(Q(filters: [F("in", null, Enumerable.Repeat("x", 501).ToArray())])));
    [Fact] public void A_half_range_is_rejected() => Assert.Equal("filters[0].values", FieldOf(Q(filters: [F("between", null, ["1", " "])])));
    [Fact] public void An_overlong_value_is_rejected() => Assert.Equal("filters[0]", FieldOf(Q(filters: [F("=", new string('x', 1001))])));
    [Fact] public void A_sort_alias_past_the_dimensions_is_rejected() => Assert.Equal("sort.column", FieldOf(Q(dims: 1, sort: new SortRef("k5", false))));
    [Fact] public void A_null_filter_entry_is_rejected() => Assert.Equal("filters[0]", FieldOf(Q(filters: [null!])));
    [Theory] [InlineData(0)] [InlineData(101)]
    public void Out_of_range_bins_are_rejected(int bins)
        => Assert.Equal("buckets", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateHistogram(new HistogramRequest("c", bins, null))).Field);
    [Theory] [InlineData(0)] [InlineData(1001)]
    public void Out_of_range_distinct_limits_are_rejected(int n)
        => Assert.Equal("limit", Assert.Throws<RequestValidationException>(() => RequestRules.ValidateDistinctLimit(n)).Field);
}
