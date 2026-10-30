using System.Net;
using System.Net.Http.Json;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>A union / unpivot as a worksheet query source: the request rules, the derived table's SQL, the exposed columns.</summary>
public class SourceTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public SourceTests(WebApplicationFactory<Program> factory) => _factory = factory;

    private static QuerySource Un(string[]? tables = null, string[]? columns = null, string name = "U", string db = "d")
        => new("union", db, name, Tables: tables ?? ["a", "b"], Columns: columns);
    private static QuerySource Up(string[]? columns = null, string[]? keep = null, string name = "P", string db = "d", string table = "t")
        => new("unpivot", db, name, Table: table, Columns: columns ?? ["q1", "q2"], Keep: keep);
    private static string? FieldOf(QuerySource s) { try { RequestRules.ValidateSource(s); return null; } catch (RequestValidationException e) { return e.Field; } }
    private static List<ColumnInfo> C(params (string, string, string)[] c) => c.Select(x => new ColumnInfo(x.Item1, x.Item2, x.Item3)).ToList();

    // --- request rules ---------------------------------------------------------------------------------------------------
    [Fact] public void Valid_sources_pass() { Assert.Null(FieldOf(Un())); Assert.Null(FieldOf(Up())); }
    [Fact] public void The_kind_is_a_whitelisted_word() => Assert.Equal("source.kind", FieldOf(Un() with { Kind = "join" }));
    [Fact] public void Db_and_name_are_required_and_the_name_is_bounded()
    {
        Assert.Equal("source.db", FieldOf(Un(db: " ")));
        Assert.Equal("source.name", FieldOf(Un(name: "")));
        Assert.Equal("source.name", FieldOf(Un(name: new string('x', ApiLimits.MaxSourceName + 1))));
        Assert.Null(FieldOf(Un(name: new string('x', ApiLimits.MaxSourceName))));
    }
    [Fact] public void A_union_needs_two_to_five_distinct_tables()
    {
        Assert.Equal("source.tables", FieldOf(Un(tables: ["a"])));
        Assert.Equal("source.tables", FieldOf(Un(tables: ["a", "b", "c", "d", "e", "f"])));
        Assert.Equal("source.tables[1]", FieldOf(Un(tables: ["a", " "])));
        Assert.Equal("source.tables[1]", FieldOf(Un(tables: ["a", "a"])));
        Assert.Null(FieldOf(Un(tables: ["a", "b", "c", "d", "e"])));
    }
    [Fact] public void A_union_takes_no_unpivot_fields() { Assert.Equal("source.keep", FieldOf(Un() with { Keep = ["k"] })); Assert.Equal("source.table", FieldOf(Un() with { Table = "t" })); }
    [Fact] public void A_union_s_columns_are_bounded_distinct_and_not_blank()
    {
        Assert.Equal("source.columns", FieldOf(Un(columns: Enumerable.Range(0, ApiLimits.MaxRowsColumns + 1).Select(i => "c" + i).ToArray())));
        Assert.Equal("source.columns[0]", FieldOf(Un(columns: [""])));
        Assert.Equal("source.columns[1]", FieldOf(Un(columns: ["a", "a"])));
    }
    [Fact] public void An_unpivot_needs_a_table_and_two_to_fifty_distinct_columns()
    {
        Assert.Equal("source.table", FieldOf(Up(table: " ")));
        Assert.Equal("source.columns", FieldOf(Up(columns: ["a"])));
        Assert.Equal("source.columns", FieldOf(Up(columns: Enumerable.Range(0, 51).Select(i => "c" + i).ToArray())));
        Assert.Null(FieldOf(Up(columns: Enumerable.Range(0, 50).Select(i => "c" + i).ToArray())));
        Assert.Equal("source.columns[1]", FieldOf(Up(columns: ["a", "a"])));
        Assert.Equal("source.columns[1]", FieldOf(Up(columns: ["a", ""])));
    }
    [Fact] public void An_unpivot_keeps_at_most_five_columns_none_shared_with_the_unpivoted()
    {
        Assert.Equal("source.keep", FieldOf(Up(keep: ["k1", "k2", "k3", "k4", "k5", "k6"])));
        Assert.Equal("source.keep[0]", FieldOf(Up(keep: ["q1"])));
        Assert.Equal("source.keep[1]", FieldOf(Up(keep: ["k", "k"])));
        Assert.Equal("source.keep[0]", FieldOf(Up(keep: [" "])));
    }
    [Fact] public void An_unpivot_takes_no_union_tables() => Assert.Equal("source.tables", FieldOf(Up() with { Tables = ["a", "b"] }));

    private static QueryRequest Q(QuerySource? source, TableRef? from = null, JoinRef[]? joins = null) =>
        new(from ?? new TableRef("d", "U"), joins, [new ColumnRef("d", "U", "region")], null, [new MeasureRef("d", "U", "amount", "sum")], null, 10, null, Source: source);
    private static string? QueryField(QueryRequest r) { try { RequestRules.ValidateQuery(r); return null; } catch (RequestValidationException e) { return e.Field; } }

    [Fact] public void A_source_query_names_the_source_as_its_from() { Assert.Null(QueryField(Q(Un()))); Assert.Equal("from", QueryField(Q(Un(), new TableRef("d", "other")))); Assert.Equal("from", QueryField(Q(Un(), new TableRef("x", "U")))); }
    [Fact] public void A_source_query_is_never_joined() => Assert.Equal("joins", QueryField(Q(Un(), joins: [new JoinRef(new ColumnRef("d", "U", "a"), new ColumnRef("d", "t", "b"))])));
    [Fact] public void A_query_without_a_source_is_unchanged() => Assert.Null(QueryField(Q(null)));
    [Fact] public void A_source_rule_break_in_a_query_is_a_400_on_the_source_field() => Assert.Equal("source.tables", QueryField(Q(Un(tables: ["a"]))));

    // --- the union's derived table ---------------------------------------------------------------------------------------
    [Fact] public void The_union_sql_stacks_shared_columns_after_a_bound_source_label_and_quotes_every_name()
    {
        var a = C(("id", "UInt64", "numeric"), ("na`me", "String", "text"), ("only_a", "String", "text"));
        var b = C(("na`me", "String", "text"), ("id", "UInt64", "numeric"));
        var built = SourceSql.Build(Un(["a`x", "b"], null, db: "d`b"), [a, b]);
        Assert.Equal(
            "SELECT {us0:String} AS `Source table`, `id`, `na\\`me` FROM `d\\`b`.`a\\`x` UNION ALL " +
            "SELECT {us1:String} AS `Source table`, `id`, `na\\`me` FROM `d\\`b`.`b`", built.Sql);
        Assert.Equal(["Source table", "id", "na`me"], built.Columns.Select(c => c.Name));
        Assert.Equal([("us0", "String", (object)"a`x"), ("us1", "String", "b")], built.Parameters.Select(p => (p.Name, p.Type, p.Value)));
        Assert.False(built.ColumnsTruncated);
    }
    [Fact] public void A_hostile_table_name_is_only_ever_bound_or_quoted()
    {
        var evil = "a'; DROP TABLE x; --";
        var built = SourceSql.Build(Un([evil, "b"], null), [C(("id", "UInt8", "numeric")), C(("id", "UInt8", "numeric"))]);
        Assert.DoesNotContain("DROP", built.Sql.Replace("`" + evil + "`", ""));
        Assert.Contains("`d`.`a'; DROP TABLE x; --`", built.Sql);
        Assert.Contains(built.Parameters, p => p.Name == "us0" && (string)p.Value == evil);
    }
    [Fact] public void The_source_label_column_steps_aside_for_a_shared_column_of_that_name()
    {
        var t = C(("Source table", "String", "text"), ("v", "Int32", "numeric"));
        var built = SourceSql.Build(Un(), [t, t]);
        Assert.Equal(["Source table_", "Source table", "v"], built.Columns.Select(c => c.Name));
        Assert.StartsWith("SELECT {us0:String} AS `Source table_`, `Source table`, `v` FROM", built.Sql);
    }
    [Fact] public void Differing_types_of_a_shared_column_are_read_as_one_type_per_kind()
    {
        var a = C(("n", "UInt64", "numeric"), ("s", "Enum8('x'=1)", "text"), ("d", "Date", "temporal"), ("same", "Int32", "numeric"));
        var b = C(("n", "Int64", "numeric"), ("s", "String", "text"), ("d", "DateTime", "temporal"), ("same", "Int32", "numeric"));
        var built = SourceSql.Build(Un(), [a, b]);
        Assert.Contains("toInt128(`n`) AS `n`, toString(`s`) AS `s`, toDateTime64(`d`, 3) AS `d`, `same` FROM `d`.`a`", built.Sql);
        Assert.Equal(["String", "Int128", "String", "DateTime64(3)", "Int32"], built.Columns.Select(c => c.Type));
        Assert.Equal(["text", "numeric", "text", "temporal", "numeric"], built.Columns.Select(c => c.Category));
        Assert.Empty(built.Lossy);
    }
    [Fact] public void Nullable_and_LowCardinality_wrappers_are_not_a_difference_no_cast_and_Nullable_is_declared()
    {
        var a = C(("n", "Int64", "numeric"), ("s", "LowCardinality(String)", "text"), ("flag", "Bool", "boolean"));
        var b = C(("n", "Nullable(Int64)", "numeric"), ("s", "String", "text"), ("flag", "Nullable(Bool)", "boolean"));
        var built = SourceSql.Build(Un(), [a, b]);
        Assert.DoesNotContain("toInt", built.Sql); Assert.DoesNotContain("toString", built.Sql); Assert.DoesNotContain("toBool", built.Sql);
        Assert.Equal(["String", "Nullable(Int64)", "String", "Nullable(Bool)"], built.Columns.Select(c => c.Type));
        Assert.Empty(built.Lossy);
    }
    [Fact] public void Large_integers_are_never_cast_through_Float64()
    {
        var u = C(("n", "UInt64", "numeric")); var i = C(("n", "Int64", "numeric")); var i32 = C(("n", "Int32", "numeric")); var i64 = C(("n", "Int64", "numeric"));
        Assert.Equal("Int128", SourceSql.Build(Un(), [u, i]).Columns[1].Type);
        Assert.Equal("Int64", SourceSql.Build(Un(), [i32, i64]).Columns[1].Type);
        Assert.Equal("UInt64", SourceSql.Build(Un(), [C(("n", "UInt16", "numeric")), u]).Columns[1].Type);
        Assert.Equal("Nullable(Int128)", SourceSql.Build(Un(), [u, C(("n", "Nullable(Int64)", "numeric"))]).Columns[1].Type);
        Assert.Equal("Int256", SourceSql.Build(Un(), [C(("n", "UInt128", "numeric")), i]).Columns[1].Type);
        Assert.Empty(SourceSql.Build(Un(), [u, i]).Lossy);
    }
    [Fact] public void Only_a_truly_lossy_numeric_mix_falls_back_to_Float64_and_says_so()
    {
        var built = SourceSql.Build(Un(), [C(("n", "UInt64", "numeric"), ("m", "Float32", "numeric"), ("p", "Decimal(38, 4)", "numeric")),
            C(("n", "Float64", "numeric"), ("m", "Float64", "numeric"), ("p", "Decimal(10, 2)", "numeric"))]);
        Assert.Equal(["Float64", "Float64", "Float64"], built.Columns.Skip(1).Select(c => c.Type));
        Assert.Equal(["n", "p"], built.Lossy);   // Float32 -> Float64 is exact
        Assert.Contains("toFloat64(`n`)", built.Sql);
    }
    [Fact] public void Unpivot_values_follow_the_same_precision_rules()
    {
        var t = C(("a", "UInt64", "numeric"), ("b", "Int64", "numeric"));
        var built = SourceSql.Build(Up(["a", "b"]), [t]);
        Assert.Equal("Int128", built.Columns[^1].Type);
        Assert.Contains("({uf0:String}, toInt128(`a`)), ({uf1:String}, toInt128(`b`))", built.Sql);
        Assert.Empty(built.Lossy);
        var lossy = SourceSql.Build(Up(["a", "b"]), [C(("a", "UInt64", "numeric"), ("b", "Float64", "numeric"))]);
        Assert.Equal(["Value"], lossy.Lossy);
        var nul = SourceSql.Build(Up(["a", "b"]), [C(("a", "Nullable(Int32)", "numeric"), ("b", "Int32", "numeric"))]);
        Assert.Equal("Nullable(Int32)", nul.Columns[^1].Type); Assert.DoesNotContain("toInt", nul.Sql);
    }
    [Fact] public void A_compound_column_with_differing_types_cannot_be_stacked()
    {
        var a = C(("x", "Array(UInt8)", "compound")); var b = C(("x", "Array(String)", "compound"));
        Assert.Equal("source.tables", Assert.Throws<RequestValidationException>(() => SourceSql.Build(Un(), [a, b])).Field);
    }
    [Fact] public void A_union_with_no_shared_column_is_a_400() =>
        Assert.Equal("source.tables", Assert.Throws<RequestValidationException>(() => SourceSql.Build(Un(), [C(("x", "String", "text")), C(("y", "String", "text"))])).Field);
    [Fact] public void A_union_column_the_tables_lack_is_an_unknown_identifier()
    {
        var t = C(("id", "UInt8", "numeric"));
        Assert.Throws<UnknownIdentifierException>(() => SourceSql.Build(Un(columns: ["nope"]), [t, t]));
    }
    [Fact] public void A_union_may_keep_a_subset_of_the_shared_columns_in_the_given_order()
    {
        var t = C(("a", "String", "text"), ("b", "String", "text"), ("c", "String", "text"));
        var built = SourceSql.Build(Un(columns: ["c", "a"]), [t, t]);
        Assert.Equal(["Source table", "c", "a"], built.Columns.Select(c => c.Name));
    }

    // --- the unpivot's derived table -------------------------------------------------------------------------------------
    [Fact] public void The_unpivot_sql_binds_each_field_name_and_quotes_every_column()
    {
        var t = C(("k`1", "String", "text"), ("q`1", "Int32", "numeric"), ("q2", "Int32", "numeric"));
        var built = SourceSql.Build(Up(["q`1", "q2"], ["k`1"], db: "d`b", table: "t`x"), [t]);
        Assert.Equal(
            "SELECT `k\\`1`, tupleElement(`__up`, 1) AS `Field`, tupleElement(`__up`, 2) AS `Value` FROM " +
            "(SELECT `k\\`1`, arrayJoin([({uf0:String}, `q\\`1`), ({uf1:String}, `q2`)]) AS `__up` FROM `d\\`b`.`t\\`x`)", built.Sql);
        Assert.Equal([("uf0", "String", (object)"q`1"), ("uf1", "String", "q2")], built.Parameters.Select(p => (p.Name, p.Type, p.Value)));
        Assert.Equal(["k`1", "Field", "Value"], built.Columns.Select(c => c.Name));
        Assert.Equal(["String", "String", "Int32"], built.Columns.Select(c => c.Type));
        Assert.Equal(["text", "text", "numeric"], built.Columns.Select(c => c.Category));
    }
    [Fact] public void A_hostile_field_name_is_never_in_the_sql_text_as_a_value()
    {
        var evil = "q'; DROP TABLE x; --";
        var t = C((evil, "Int32", "numeric"), ("q2", "Int32", "numeric"));
        var built = SourceSql.Build(Up([evil, "q2"]), [t]);
        Assert.Contains("({uf0:String}, `q'; DROP TABLE x; --`)", built.Sql);   // only as a quoted identifier
        Assert.DoesNotContain("'" + evil, built.Sql);
        Assert.Contains(built.Parameters, p => p.Name == "uf0" && (string)p.Value == evil);
    }
    [Fact] public void Unpivoted_columns_of_differing_types_are_read_as_one_type()
    {
        var t = C(("a", "UInt64", "numeric"), ("b", "Float32", "numeric"));
        var built = SourceSql.Build(Up(["a", "b"]), [t]);
        Assert.Equal(["Value"], built.Lossy);
        Assert.Contains("({uf0:String}, toFloat64(`a`)), ({uf1:String}, toFloat64(`b`))", built.Sql);
        Assert.Equal("Float64", built.Columns[^1].Type);
    }
    [Fact] public void Field_and_Value_step_aside_for_columns_of_those_names()
    {
        var t = C(("Field", "String", "text"), ("Value", "Int32", "numeric"), ("q1", "Int32", "numeric"), ("q2", "Int32", "numeric"));
        var built = SourceSql.Build(Up(["q1", "q2", "Value"], ["Field"]), [t]);
        Assert.Equal(["Field", "Field_", "Value_"], built.Columns.Select(c => c.Name));
        Assert.Contains("AS `Field_`", built.Sql); Assert.Contains("AS `Value_`", built.Sql);
    }
    [Fact] public void The_helper_alias_never_shadows_a_table_column_named_like_it()
    {
        var t = C(("__up", "Int32", "numeric"), ("q1", "Int32", "numeric"), ("q2", "Int32", "numeric"));
        Assert.Contains("AS `__u_p`", SourceSql.Build(Up(), [t]).Sql);
    }
    [Fact] public void Unpivoted_columns_must_exist_and_share_a_kind()
    {
        var t = C(("q1", "Int32", "numeric"), ("note", "String", "text"));
        Assert.Equal("source.columns[1]", Assert.Throws<RequestValidationException>(() => SourceSql.Build(Up(["q1", "note"]), [t])).Field);
        Assert.Throws<UnknownIdentifierException>(() => SourceSql.Build(Up(["q1", "nope"]), [t]));
        Assert.Throws<UnknownIdentifierException>(() => SourceSql.Build(Up(["q1", "q1x"], ["nope"]), [t]));
    }

    [Fact] public void A_statement_that_reuses_the_from_carries_the_source_s_bound_values()
    {
        var built = SourceSql.Build(Un(), [C(("id", "UInt8", "numeric")), C(("id", "UInt8", "numeric"))]);
        List<(string Name, string Type, object Value)> all = [.. built.Parameters, ("p0", "String", "x")];
        var used = ClickHouseGateway.ParametersUsedBy($"`id` FROM ({built.Sql}) AS t0", all);
        Assert.Equal(["us0", "us1"], used.Select(p => p.Name));
    }

    // --- endpoints -------------------------------------------------------------------------------------------------------
    [Fact] public async Task Source_columns_without_a_connection_is_409()
    {
        var resp = await _factory.CreateClient().PostAsJsonAsync("/api/source/columns", new { kind = "union", db = "d", name = "U", tables = new[] { "a", "b" } });
        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }
    [Fact] public async Task Source_columns_only_accepts_post()
        => Assert.Equal(HttpStatusCode.MethodNotAllowed, (await _factory.CreateClient().GetAsync("/api/source/columns")).StatusCode);
}
