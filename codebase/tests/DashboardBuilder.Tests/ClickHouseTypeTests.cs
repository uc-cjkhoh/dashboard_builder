using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// The ClickHouse-type → display-category mapper (dev doc's second unit target). Covers the
/// wrappers (Nullable/LowCardinality) and rich types that are not SQL-92.
/// </summary>
public class ClickHouseTypeTests
{
    [Theory]
    [InlineData("UInt64")]
    [InlineData("Int32")]
    [InlineData("Float64")]
    [InlineData("Decimal(18,4)")]
    [InlineData("Decimal64(4)")]
    [InlineData("Nullable(UInt8)")]
    [InlineData("LowCardinality(Nullable(Int16))")]
    public void Numeric_types(string type)
        => Assert.Equal(ClickHouseType.Numeric, ClickHouseType.Categorize(type));

    [Theory]
    [InlineData("String")]
    [InlineData("FixedString(16)")]
    [InlineData("LowCardinality(String)")]
    [InlineData("UUID")]
    [InlineData("IPv4")]
    [InlineData("Enum8('a' = 1, 'b' = 2)")]
    public void Text_types(string type)
        => Assert.Equal(ClickHouseType.Text, ClickHouseType.Categorize(type));

    [Theory]
    [InlineData("Date")]
    [InlineData("Date32")]
    [InlineData("DateTime")]
    [InlineData("DateTime64(3)")]
    [InlineData("Nullable(DateTime64(3, 'UTC'))")]
    public void Temporal_types(string type)
        => Assert.Equal(ClickHouseType.Temporal, ClickHouseType.Categorize(type));

    [Theory]
    [InlineData("Array(UInt64)")]
    [InlineData("Map(String, UInt64)")]
    [InlineData("Tuple(UInt8, String)")]
    public void Compound_types(string type)
        => Assert.Equal(ClickHouseType.Compound, ClickHouseType.Categorize(type));

    [Theory]
    [InlineData("Bool")]
    [InlineData("Boolean")]
    public void Boolean_types(string type)
        => Assert.Equal(ClickHouseType.Boolean, ClickHouseType.Categorize(type));

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("SomethingWeird")]
    [InlineData("Point")]
    public void Unknown_falls_back_to_other(string? type)
        => Assert.Equal(ClickHouseType.Other, ClickHouseType.Categorize(type));
}
