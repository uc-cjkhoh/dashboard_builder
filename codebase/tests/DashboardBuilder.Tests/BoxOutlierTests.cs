using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>Box-plot outliers (T07-08): the Tukey-fence SQL is bounded, identifier-quoted and value-bound.</summary>
public class BoxOutlierTests
{
    [Fact]
    public void Grouped_whisker_sql_joins_per_group_quartiles_and_is_bounded()
    {
        var sql = ClickHouseGateway.BuildBoxWhiskerSql("`m`", "`d`.`t`", "`g`", " WHERE `y` > {p0:Float64}", 51);
        Assert.Contains("quantile(0.25)(`m`)", sql);
        Assert.Contains("quantile(0.75)(`m`)", sql);
        Assert.Contains("1.5 * (s.q3 - s.q1)", sql);
        Assert.Contains("minIf(", sql);
        Assert.Contains("GROUP BY", sql);
        Assert.Contains("LIMIT 51", sql);
        Assert.Contains("{p0:Float64}", sql);
    }

    [Fact]
    public void Ungrouped_whisker_sql_has_no_label_and_crosses_a_scalar_fence()
    {
        var sql = ClickHouseGateway.BuildBoxWhiskerSql("`m`", "`d`.`t`", null, "", 2);
        Assert.DoesNotContain("label", sql);
        Assert.Contains("CROSS JOIN", sql);
    }

    [Fact]
    public void Outlier_sql_selects_values_outside_the_fences_with_a_hard_limit()
    {
        var sql = ClickHouseGateway.BuildBoxOutlierSql("`m`", "`d`.`t`", "`g`", "", 51, ApiLimits.MaxBoxOutliers + 1);
        Assert.Contains("d.v < s.q1 - 1.5 * (s.q3 - s.q1)", sql);
        Assert.Contains("d.v > s.q3 + 1.5 * (s.q3 - s.q1)", sql);
        Assert.EndsWith($"LIMIT {ApiLimits.MaxBoxOutliers + 1}", sql);
    }
}
