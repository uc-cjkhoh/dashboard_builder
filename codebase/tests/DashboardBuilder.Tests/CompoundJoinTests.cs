using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>Compound join keys: a relationship may hold up to MaxJoinPairs column pairs (ANDed equalities).</summary>
public class CompoundJoinTests
{
    private static QueryRequest Q(params JoinRef[] joins) =>
        new(new TableRef("db", "a"), joins, [new ColumnRef("db", "a", "x")], [], [new MeasureRef("db", "a", "m", "sum")], null, null, null);
    private static JoinRef J(params JoinColumnPair[] pairs) =>
        new(new ColumnRef("db", "a", "k1"), new ColumnRef("db", "b", "k1"), null, pairs);
    private static string? FieldOf(QueryRequest q) => Assert.Throws<RequestValidationException>(() => RequestRules.ValidateQuery(q)).Field;
    private static JoinColumnPair P(string l = "x", string r = "y") => new(l, r);

    [Fact] public void The_pair_limit_is_four_in_all_so_three_extra()
    {
        Assert.Equal(4, ApiLimits.MaxJoinPairs);
        RequestRules.ValidateQuery(Q(J(P(), P(), P())));      // 1 + 3 = 4
        Assert.Equal("joins[0].pairs", FieldOf(Q(J(P(), P(), P(), P()))));
    }
    [Fact] public void A_join_without_extra_pairs_is_unchanged()
    {
        RequestRules.ValidateQuery(Q(new JoinRef(new ColumnRef("db", "a", "k"), new ColumnRef("db", "b", "k"))));
        RequestRules.ValidateQuery(Q(J()));
    }
    [Theory] [InlineData("", "y", "joins[0].pairs[0].left")] [InlineData("x", " ", "joins[0].pairs[0].right")]
    public void Blank_pair_columns_are_rejected(string l, string r, string field) => Assert.Equal(field, FieldOf(Q(J(P(l, r)))));
    [Fact] public void A_null_pair_is_rejected() => Assert.Equal("joins[0].pairs", FieldOf(Q(J(new JoinColumnPair[] { null! }))));

    [Fact] public void The_on_clause_ands_every_pair_with_each_identifier_quoted()
    {
        var on = ClickHouseGateway.JoinOn("t0.`k1`", "t1", "k1", [("t0.`x`", "y")]);
        Assert.Equal(" ON t0.`k1` = t1.`k1` AND t0.`x` = t1.`y`", on);
        Assert.Equal(" ON t0.`k1` = t1.`k1`", ClickHouseGateway.JoinOn("t0.`k1`", "t1", "k1", []));
        Assert.Contains("t1.`a\\`; DROP`", ClickHouseGateway.JoinOn("t0.`k`", "t1", "k", [("t0.`x`", "a`; DROP")]));
    }

    // --- the preview ---
    private static JoinKeyRef K(string t, string c) => new("d", t, c);
    private static string? PreviewField(JoinPreviewRequest r) { try { JoinPreviewRules.Validate(r); return null; } catch (RequestValidationException e) { return e.Field; } }
    [Fact] public void The_preview_accepts_up_to_three_extra_pairs_and_rejects_more()
    {
        Assert.Null(PreviewField(new(K("a", "k"), K("b", "k"), null, [P(), P(), P()])));
        Assert.Equal("pairs", PreviewField(new(K("a", "k"), K("b", "k"), null, [P(), P(), P(), P()])));
        Assert.Equal("pairs[0].right", PreviewField(new(K("a", "k"), K("b", "k"), null, [P("x", "")])));
        Assert.Null(PreviewField(new(K("a", "k"), K("b", "k"), null)));
    }
    [Fact] public void A_compound_preview_key_is_one_string_that_is_NULL_when_any_part_is()
    {
        var sql = ClickHouseGateway.BuildJoinSideSql("d", "a", "k1", "d", "b", "j1", 50, false, [("k2", "j2")]);
        Assert.Contains("(SELECT if(isNull(`k1`) OR isNull(`k2`), NULL, concat(toString(`k1`), char(31), toString(`k2`))) AS k FROM `d`.`a` LIMIT 50)", sql);
        Assert.Contains("(SELECT if(isNull(`j1`) OR isNull(`j2`), NULL, concat(toString(`j1`), char(31), toString(`j2`))) AS k FROM `d`.`b` LIMIT 50)", sql);
        Assert.DoesNotContain("ORDER BY", sql);
    }
}
