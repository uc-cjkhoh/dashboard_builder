using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>Box-plot outliers: the Tukey-fence SQL is bounded, identifier-quoted and value-bound.</summary>
public class BoxOutlierTests
{
    [Fact]
    public void Grouped_whisker_sql_joins_per_group_quartiles_and_is_bounded()
    {
        var sql = ClickHouseGateway.BuildBoxWhiskerSql("`m`", "`d`.`t`", "`g`", " WHERE `y` > {p0:Float64}", 51);
        Assert.Contains("quantile(0.25)(`m`)", sql);
        Assert.Contains("quantile(0.75)(`m`)", sql);
        Assert.Contains("1.5 * (s.__bx_q3 - s.__bx_q1)", sql);
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
        Assert.Contains("d.__bx_v < s.__bx_q1 - 1.5 * (s.__bx_q3 - s.__bx_q1)", sql);
        Assert.Contains("d.__bx_v > s.__bx_q3 + 1.5 * (s.__bx_q3 - s.__bx_q1)", sql);
        Assert.EndsWith($"LIMIT {ApiLimits.MaxBoxOutliers + 1}", sql);
    }

    [Fact]
    public void A_filter_on_columns_named_v_and_label_cannot_meet_an_alias()
    {
        var byName = new Dictionary<string, ColumnInfo>
        {
            ["v"] = new("v", "Float64", ClickHouseType.Numeric), ["label"] = new("label", "String", ClickHouseType.Text),
        };
        var ps = new List<(string Name, string Type, object Value)>();
        var where = ClickHouseGateway.BuildSingleTableFilters(
            [new StatFilter("v", ">", "1", null), new StatFilter("label", "=", "x", null)], byName, ps);
        foreach (var dim in new string?[] { "`label`", null })
        {
            var sql = ClickHouseGateway.BuildBoxWhiskerSql("`v`", "`d`.`t`", dim, where, 5)
                    + ClickHouseGateway.BuildBoxOutlierSql("`v`", "`d`.`t`", dim, where, 5, 10);
            Assert.DoesNotContain(" AS v", sql.Replace("AS __bx_v", "").Replace("d.__bx_v AS v", ""));
            Assert.DoesNotContain("AS label", sql.Replace("AS __bx_label", "").Replace("d.__bx_label AS label", ""));
            Assert.DoesNotContain("s.q1", sql);
        }
    }
}
