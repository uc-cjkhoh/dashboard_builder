using DashboardBuilder.ClickHouse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

namespace DashboardBuilder.Tests;

/// <summary>A card's custom SQL (D105): what the guard accepts, what it refuses, the request rules and the derived table.</summary>
public class CustomSqlTests
{
    private static string? Why(string? sql) { try { CustomSql.Clean(sql); return null; } catch (RequestValidationException e) { Assert.Equal("source.sql", e.Field); return e.Message; } }
    private static QuerySource Q(string? sql = "SELECT 1") => new("sql", "d", "orders", Sql: sql);

    [Theory]
    [InlineData("SELECT a, b FROM d.t")]
    [InlineData("select a from t where x = 'a;b' and y = \"c;d\" and z = `e;f`")]
    [InlineData("WITH x AS (SELECT 1 AS n) SELECT n FROM x")]
    [InlineData("SELECT a FROM (SELECT a FROM t) UNION ALL SELECT a FROM u")]
    [InlineData("SELECT 'it''s (open' AS s")]
    [InlineData("SELECT 'a\\'b;(' AS s")]
    public void Plain_selects_pass(string sql) => Assert.Null(Why(sql));

    [Fact] public void A_trailing_semicolon_is_dropped_and_comments_are_removed()
    {
        Assert.Equal("SELECT a FROM t", CustomSql.Clean("  SELECT a FROM t ;  "));
        var cleaned = CustomSql.Clean("SELECT a -- the key\nFROM t /* all rows */ WHERE x = '-- not a comment'");
        Assert.DoesNotContain("the key", cleaned); Assert.DoesNotContain("all rows", cleaned); Assert.Contains("'-- not a comment'", cleaned);
    }
    [Fact] public void A_line_comment_cannot_swallow_the_closing_bracket_of_the_wrapper()
        => Assert.DoesNotContain("--", CustomSql.Clean("SELECT a FROM t -- trailing"));

    [Theory]
    [InlineData("", "Write a SELECT query.")]
    [InlineData("   ", "Write a SELECT query.")]
    [InlineData("-- only a comment", "Write a SELECT query.")]
    [InlineData("DROP TABLE t", "must start with SELECT")]
    [InlineData("INSERT INTO t VALUES (1)", "must start with SELECT")]
    [InlineData("SHOW TABLES", "must start with SELECT")]
    [InlineData("(SELECT 1)", "must start with SELECT")]
    [InlineData("SELECT 1; SELECT 2", "extra ';'")]
    [InlineData("SELECT 1; DROP TABLE t", "extra ';'")]
    [InlineData("SELECT 1) UNION ALL SELECT secret FROM x WHERE (1", "no '('")]
    [InlineData("SELECT (1", "never closed")]
    [InlineData("SELECT a FROM t SETTINGS max_execution_time = 0", "change settings")]
    [InlineData("SELECT 'open", "closing quote")]
    [InlineData("SELECT `open", "closing quote")]
    [InlineData("SELECT 1 /* open", "never closed")]
    [InlineData("SELECT * FROM url('http://x/y.csv', CSV)", "outside this connection")]
    [InlineData("SELECT * FROM file('a.csv')", "outside this connection")]
    [InlineData("SELECT * FROM S3('x')", "outside this connection")]
    [InlineData("SELECT * FROM remote('h', d.t)", "outside this connection")]
    [InlineData("SELECT * FROM mysql('h:3306', 'd', 't', 'u', 'p')", "outside this connection")]
    public void Anything_else_is_refused_in_plain_words(string sql, string part) => Assert.Contains(part, Why(sql));

    // Review 2026-11-17: a quoted name is still a name, a backslash escapes inside backticks too, and only a few table functions may go where a table goes.
    [Theory]
    [InlineData("SELECT * FROM `url`('http://169.254.169.254/', 'LineAsString')", "'url' reads outside")]
    [InlineData("SELECT * FROM \"s3\"('x')", "'s3' reads outside")]
    [InlineData("SELECT * FROM `ur\\l`('x')", "'url' reads outside")]
    [InlineData("SELECT 1 AS `\\` AS a, `, * FROM url('http://x/','LineAsString') SETTINGS max_execution_time=0", "change settings")]
    [InlineData("SELECT * FROM icebergS3('x')", "'icebergS3' reads outside")]
    [InlineData("SELECT * FROM t, someFutureTableFunction('x')", "'someFutureTableFunction' reads outside")]
    [InlineData("SELECT * FROM t JOIN `fileCluster`('c', 'x') USING k", "'fileCluster' reads outside")]
    [InlineData("SELECT a FROM t WHERE a IN (SELECT b FROM mongodb('h', 'd', 'c', 'u', 'p', 'b String'))", "'mongodb' reads outside")]
    [InlineData("SELECT * FROM view(SELECT 1 FROM hdfs('x'))", "'hdfs' reads outside")]
    [InlineData("SELECT 1 FORMAT JSON", "output format")]
    [InlineData("SELECT a FROM t FORMAT `TabSeparated`", "output format")]
    [InlineData("SELECT a FROM t INTO OUTFILE 'x.csv'", "write a file")]
    public void Quoted_or_new_table_functions_and_output_clauses_are_refused(string sql, string part) => Assert.Contains(part, Why(sql));

    [Theory]
    [InlineData("SELECT number FROM numbers(10)")]
    [InlineData("SELECT * FROM t, numbers(3) AS n")]
    [InlineData("SELECT * FROM view(SELECT a FROM t)")]
    [InlineData("SELECT EXTRACT(YEAR FROM toDate(created)) AS y FROM t")]
    [InlineData("SELECT trim(BOTH ' ' FROM upper(name)) FROM t")]
    [InlineData("SELECT x FROM t ARRAY JOIN splitByChar(',', tags) AS x")]
    [InlineData("SELECT a FROM t LEFT ARRAY JOIN arrayMap(v -> v * 2, vals) AS a")]
    [InlineData("SELECT `a\\`b` FROM t")]
    [InlineData("SELECT URLHierarchy(page) AS h, format('{}', a) AS f FROM t")]
    [InlineData("SELECT a AS format FROM t")]
    [InlineData("SELECT format FROM t ORDER BY format DESC")]
    [InlineData("SELECT a, format FROM t ORDER BY a, format ASC")]
    [InlineData("SELECT a FROM t GROUP BY a ORDER BY format NULLS LAST")]
    [InlineData("SELECT a FROM (SELECT a FROM t) AS s JOIN u ON s.a = lower(u.b)")]
    public void Ordinary_functions_subqueries_and_allowed_table_functions_pass(string sql) => Assert.Null(Why(sql));

    [Fact] public void Quoted_text_never_trips_the_checks()
    {
        Assert.Null(Why("SELECT 'DROP; (settings url(' AS note, `settings` FROM t"));
        Assert.Null(Why("SELECT url FROM t")); // a column called url is not a call
    }
    [Fact] public void The_length_is_bounded()
    {
        Assert.Null(Why("SELECT '" + new string('x', ApiLimits.MaxCustomSqlChars - 20) + "'"));
        Assert.Contains("at most", Why("SELECT '" + new string('x', ApiLimits.MaxCustomSqlChars) + "'"));
    }

    // --- the request rules ---------------------------------------------------------------------------------------------
    private static string? FieldOf(QuerySource s) { try { RequestRules.ValidateSource(s); return null; } catch (RequestValidationException e) { return e.Field; } }
    [Fact] public void A_sql_source_needs_a_query_and_nothing_else()
    {
        Assert.Null(FieldOf(Q()));
        Assert.Equal("source.sql", FieldOf(Q(null)));
        Assert.Equal("source.sql", FieldOf(Q("DROP TABLE t")));
        Assert.Equal("source.sql", FieldOf(Q() with { Tables = ["a", "b"] }));
        Assert.Equal("source.sql", FieldOf(Q() with { Columns = ["a"] }));
        Assert.Equal("source.name", FieldOf(Q() with { Name = "" }));
    }
    [Fact] public void Only_a_sql_source_takes_sql()
    {
        Assert.Equal("source.sql", FieldOf(new QuerySource("union", "d", "U", Tables: ["a", "b"], Sql: "SELECT 1")));
        Assert.Equal("source.sql", FieldOf(new QuerySource("unpivot", "d", "P", Table: "t", Columns: ["q1", "q2"], Sql: "SELECT 1")));
    }

    // --- the derived table ----------------------------------------------------------------------------------------------
    private static List<ColumnInfo> C(params (string, string)[] c) => c.Select(x => new ColumnInfo(x.Item1, x.Item2, ClickHouseType.Categorize(x.Item2))).ToList();
    [Fact] public void The_derived_table_is_the_checked_text_with_the_described_columns()
    {
        var b = SourceSql.Build(Q("SELECT a, b FROM t;"), [C(("a", "Int32"), ("b", "String"))]);
        Assert.Equal("SELECT a, b FROM t", b.Sql);
        Assert.Equal(["a", "b"], b.Columns.Select(c => c.Name));
        Assert.Empty(b.Parameters); Assert.Empty(b.Lossy); Assert.False(b.ColumnsTruncated);
    }
    [Fact] public void Repeated_column_names_and_too_many_columns_are_refused()
    {
        var dup = Assert.Throws<RequestValidationException>(() => SourceSql.Build(Q(), [C(("a", "Int32"), ("a", "Int32"))]));
        Assert.Contains("more than once", dup.Message); Assert.Equal("source.sql", dup.Field);
        var many = Enumerable.Range(0, ApiLimits.MaxRowsColumns + 1).Select(i => new ColumnInfo($"c{i}", "Int32", ClickHouseType.Numeric)).ToList();
        Assert.Equal("source.sql", Assert.Throws<RequestValidationException>(() => SourceSql.Build(Q(), [many])).Field);
        Assert.Equal("source.sql", Assert.Throws<RequestValidationException>(() => SourceSql.Build(Q(), [[]])).Field);
    }
    [Fact] public void A_sql_source_reads_no_catalog_tables() => Assert.Empty(SourceSql.TablesOf(Q()));

    [Fact] public void A_clickhouse_message_is_trimmed_to_the_readable_part()
    {
        var m = "Code: 62. DB::Exception: Syntax error: failed at position 8 ('FORM') (line 1, col 8): FORM t. Expected one of: FROM. (SYNTAX_ERROR) (version 24.8.1.1)\n0. DB::Exception::Exception(...) Stack trace:";
        var text = ClickHouseGateway.QueryProblem(m);
        Assert.StartsWith("Syntax error: failed at position 8", text);
        Assert.DoesNotContain("version", text); Assert.DoesNotContain("Stack", text);
        Assert.Equal("ClickHouse could not read the query.", ClickHouseGateway.QueryProblem("  "));
    }

    // --- through the gateway, against a stub ClickHouse -----------------------------------------------------------------------
    private static Result Answer(string sql)
    {
        if (sql.StartsWith("EXPLAIN SYNTAX")) return new([new Col("explain", "String")], [["SELECT region"], ["FROM d.sales"], ["WHERE equals(amount, 1)"]]);
        if (sql.StartsWith("DESCRIBE TABLE (") && sql.Contains("d.labels")) return new([new Col("name", "String"), new Col("type", "String")], [["region", "String"], ["label", "String"]]);
        if (sql.StartsWith("DESCRIBE TABLE (")) return new([new Col("name", "String"), new Col("type", "String")], [["region", "String"], ["amount", "Float64"]]);
        if (sql.StartsWith("SHOW DATABASES")) return new([new Col("name", "String")], [["d"]]);
        if (sql.StartsWith("SHOW TABLES")) return new([new Col("name", "String")], [["orders"], ["regions"]]);
        if (sql.StartsWith("DESCRIBE TABLE `d`.`regions`")) return new([new Col("name", "String"), new Col("type", "String")], [["region", "String"], ["label", "String"]]);
        if (sql.StartsWith("DESCRIBE TABLE `d`.`orders`")) return new([new Col("name", "String"), new Col("type", "String")], [["id", "UInt64"], ["region", "String"], ["amount", "Float64"]]);
        return new([new Col("k0", "String"), new Col("v0", "Float64")], [["north", 2.5]]);
    }
    private static (StubClickHouse Stub, ClickHouseGateway Gw, ClickHouseConnectionInfo Info) Start()
    {
        var stub = new StubClickHouse(Answer);
        return (stub, new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance), new ClickHouseConnectionInfo("127.0.0.1", stub.Port, "u", "p", false, false));
    }

    [Fact] public async Task The_columns_come_from_describing_the_query()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var (columns, truncated, lossy) = await gw.SourceColumnsAsync(info, Q("SELECT region, amount FROM d.sales;"), default);
        Assert.Equal(["region", "amount"], columns.Select(c => c.Name));
        Assert.Equal("Float64", columns[1].Type); Assert.False(truncated); Assert.Empty(lossy);
        Assert.Contains(stub.Statements, x => x.Sql.StartsWith("DESCRIBE TABLE (") && x.Sql.Contains("SELECT region, amount FROM d.sales") && !x.Sql.Contains(';'));
    }
    [Fact] public async Task A_worksheet_query_reads_the_text_as_a_derived_table_t0()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var req = new QueryRequest(new TableRef("d", "orders"), null, [new ColumnRef("d", "orders", "region")], null,
            [new MeasureRef("d", "orders", "amount", "sum")], null, 10, null, Source: Q("SELECT region, amount FROM d.sales WHERE amount > 0"));
        await gw.QueryAsync(info, req, default);
        var main = stub.Statements.Single(x => x.Sql.StartsWith("SELECT") && !x.Sql.StartsWith("SELECT version()"));
        Assert.Contains("FROM (SELECT region, amount FROM d.sales WHERE amount > 0) AS t0", main.Sql);
        Assert.Contains("sum(t0.`amount`)", main.Sql);
        Assert.Contains("LIMIT 11", main.Sql);
    }
    [Fact] public async Task A_field_the_query_does_not_return_is_refused()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var req = new QueryRequest(new TableRef("d", "orders"), null, [new ColumnRef("d", "orders", "gone")], null,
            [new MeasureRef("d", "orders", "amount", "sum")], null, 10, null, Source: Q("SELECT region, amount FROM d.sales"));
        await Assert.ThrowsAsync<UnknownIdentifierException>(() => gw.QueryAsync(info, req, default));
    }

    [Fact] public async Task A_custom_sql_card_takes_part_in_joins_as_the_base_or_a_join_side()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var join = new JoinRef(new ColumnRef("d", "orders", "region"), new ColumnRef("d", "regions", "region"), "left");
        var req = new QueryRequest(new TableRef("d", "orders"), [join], [new ColumnRef("d", "regions", "label")], null,
            [new MeasureRef("d", "orders", "amount", "sum")], null, 10, null, Sources: [Q("SELECT region, amount FROM d.sales")]);
        await gw.QueryAsync(info, req, default);
        var main = stub.Statements.Single(x => x.Sql.StartsWith("SELECT") && !x.Sql.StartsWith("SELECT version()"));
        Assert.Contains("FROM (SELECT region, amount FROM d.sales) AS t0 LEFT JOIN `d`.`regions` AS t1 ON t0.`region` = t1.`region`", main.Sql);

        var (stub2, gw2, info2) = Start();
        using var _2 = stub2;
        var other = new QuerySource("sql", "d", "regions", Sql: "SELECT region, label FROM d.labels");
        var req2 = req with { Sources = [other] };
        await gw2.QueryAsync(info2, req2 with { Measures = [new MeasureRef("d", "orders", "id", "count")] }, default);
        var main2 = stub2.Statements.Single(x => x.Sql.StartsWith("SELECT") && !x.Sql.StartsWith("SELECT version()"));
        Assert.Contains("FROM `d`.`orders` AS t0 LEFT JOIN (SELECT region, label FROM d.labels) AS t1", main2.Sql);
    }
    [Fact] public void The_sources_list_is_checked()
    {
        QueryRequest Req(QuerySource[]? sources, QuerySource? source = null) => new(new TableRef("d", "orders"), null, [new ColumnRef("d", "orders", "region")], null, null, null, 10, null, Source: source, Sources: sources);
        string? Field(QueryRequest r) { try { RequestRules.ValidateQuery(r); return null; } catch (RequestValidationException e) { return e.Field; } }
        Assert.Null(Field(Req([Q()])));
        Assert.Equal("sources[0].sql", Field(Req([Q("DROP TABLE t")])));
        Assert.Equal("sources[0].kind", Field(Req([new QuerySource("union", "d", "U", Tables: ["a", "b"])])));
        Assert.Equal("sources[1].name", Field(Req([Q(), Q()])));
        Assert.Equal("sources", Field(Req([Q()], new QuerySource("union", "d", "orders", Tables: ["a", "b"]))));
        Assert.Equal("sources", Field(Req(Enumerable.Range(0, ApiLimits.MaxJoins + 2).Select(i => Q() with { Name = $"t{i}" }).ToArray())));
    }

    [Fact] public async Task The_syntax_text_is_what_EXPLAIN_SYNTAX_says_of_the_checked_query()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var text = await gw.SourceSyntaxAsync(info, Q("SELECT region FROM d.sales WHERE amount = 1;"), default);
        Assert.Equal("SELECT region\nFROM d.sales\nWHERE equals(amount, 1)", text);
        Assert.Contains(stub.Statements, x => x.Sql.StartsWith("EXPLAIN SYNTAX\nSELECT region FROM d.sales WHERE amount = 1") && !x.Sql.Contains(';'));
    }
    [Fact] public async Task The_syntax_text_refuses_what_the_guard_refuses()
    {
        var (stub, gw, info) = Start();
        using var _ = stub;
        var ex = await Assert.ThrowsAsync<RequestValidationException>(() => gw.SourceSyntaxAsync(info, Q("SELECT 1; DROP TABLE t"), default));
        Assert.Equal("source.sql", ex.Field);
        Assert.DoesNotContain(stub.Statements, x => x.Sql.StartsWith("EXPLAIN"));
    }
}
