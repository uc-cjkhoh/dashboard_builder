using System.Text.Json;
using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>Calculated fields: the validator/typing layer. The shared fixture
/// <c>tests/fixtures/calc-cases.json</c> is the contract the JS twin also obeys (exact messages, sorted
/// <c>tables</c>, dotted <c>path</c>); cases without an <c>ast</c> (parse errors) are JS-only and skipped here.</summary>
public class CalcValidatorTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private static readonly JsonElement Fixture = JsonDocument.Parse(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "calc-cases.json"))).RootElement;

    /// <summary>The fixture catalog as a <c>categoryOf</c> lookup; the table key splits on its first dot.</summary>
    private static string? CategoryOf(string db, string table, string column)
    {
        foreach (var t in Fixture.GetProperty("catalog").EnumerateObject())
        {
            var dot = t.Name.IndexOf('.');
            if (t.Name[..dot] != db || t.Name[(dot + 1)..] != table) continue;
            return t.Value.TryGetProperty(column, out var c) ? c.GetString() : null;
        }
        return null;
    }

    public static IEnumerable<object[]> AstCases() =>
        Fixture.GetProperty("cases").EnumerateArray()
            .Where(c => c.TryGetProperty("ast", out _))
            .Select(c => new object[] { c.GetProperty("name").GetString()! });

    [Theory]
    [MemberData(nameof(AstCases))]
    public void Fixture_case(string name)
    {
        var c = Fixture.GetProperty("cases").EnumerateArray().Single(x => x.GetProperty("name").GetString() == name);
        var node = JsonSerializer.Deserialize<ExprNode>(c.GetProperty("ast").GetRawText(), Web)!;
        var expect = c.GetProperty("expect");

        if (expect.TryGetProperty("error", out var message))
        {
            var ex = Assert.Throws<CalcException>(() => CalcValidator.Validate(node, CategoryOf));
            Assert.Equal(message.GetString(), ex.Message);
            Assert.Equal(expect.GetProperty("path").GetString(), ex.Path);
            return;
        }

        var info = CalcValidator.Validate(node, CategoryOf);
        Assert.Equal(expect.GetProperty("type").GetString(), info.Type);
        Assert.Equal(expect.GetProperty("isAggregate").GetBoolean(), info.IsAggregate);
        Assert.Equal(
            expect.GetProperty("tables").EnumerateArray().Select(t => t.GetString()!),
            info.Tables);
    }

    [Fact]
    public void Every_fixture_case_is_well_formed()
    {
        var names = new HashSet<string>();
        foreach (var c in Fixture.GetProperty("cases").EnumerateArray())
        {
            var name = c.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
            Assert.False(string.IsNullOrWhiteSpace(name), "a fixture case has no name: " + c.GetRawText());
            Assert.True(names.Add(name!), $"duplicate fixture case name: {name}");

            var hasAst = c.TryGetProperty("ast", out _);
            var hasParseError = c.TryGetProperty("parseError", out _);
            Assert.True(hasAst ^ hasParseError, $"case '{name}' must have exactly one of ast / parseError");
            if (!hasAst) continue;

            Assert.True(c.TryGetProperty("expect", out var expect) && expect.ValueKind == JsonValueKind.Object,
                $"case '{name}' has no expect object");
            if (expect.TryGetProperty("error", out var error))
            {
                Assert.Equal(JsonValueKind.String, error.ValueKind);
                Assert.True(expect.TryGetProperty("path", out var path) && path.ValueKind == JsonValueKind.String,
                    $"case '{name}': expect.error needs a string expect.path");
            }
            else
            {
                Assert.True(expect.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String,
                    $"case '{name}': expect needs error+path or type+isAggregate+tables (type)");
                Assert.True(expect.TryGetProperty("isAggregate", out var agg)
                    && agg.ValueKind is JsonValueKind.True or JsonValueKind.False,
                    $"case '{name}': expect.isAggregate must be a boolean");
                Assert.True(expect.TryGetProperty("tables", out var tables) && tables.ValueKind == JsonValueKind.Array
                    && tables.EnumerateArray().All(t => t.ValueKind == JsonValueKind.String),
                    $"case '{name}': expect.tables must be an array of strings");
            }
        }
        Assert.NotEmpty(names);
    }

    [Fact]
    public void A_non_finite_number_is_out_of_range()
    {
        foreach (var v in new[] { double.PositiveInfinity, double.NegativeInfinity, double.NaN })
        {
            var ex = Assert.Throws<CalcException>(() => CalcValidator.Validate(new NumNode(v), CategoryOf));
            Assert.Equal("That number is out of range.", ex.Message);
            Assert.Equal("", ex.Path);
        }
    }

    /// <summary>A chain of <paramref name="depth"/> nodes: unary minus over a number literal.</summary>
    private static ExprNode Chain(int depth)
    {
        ExprNode n = new NumNode(1);
        for (var i = 1; i < depth; i++) n = new UnNode("-", n);
        return n;
    }

    /// <summary>A balanced tree of exactly <paramref name="count"/> (odd) nodes: numbers joined by <c>+</c>.</summary>
    private static ExprNode Wide(int count)
    {
        if (count == 1) return new NumNode(1);
        var rest = count - 1;
        var left = rest / 2 % 2 == 1 ? rest / 2 : rest / 2 - 1;
        return new BinNode("+", Wide(left), Wide(rest - left));
    }

    private static int Count(ExprNode n) => n switch
    {
        UnNode u => 1 + Count(u.Arg),
        BinNode b => 1 + Count(b.L) + Count(b.R),
        AggNode a => 1 + Count(a.Arg),
        _ => 1,
    };

    [Fact]
    public void Depth_twelve_is_allowed_and_thirteen_is_too_deep()
    {
        CalcValidator.Validate(Chain(CalcLimits.MaxDepth), CategoryOf);
        var ex = Assert.Throws<CalcException>(() => CalcValidator.Validate(Chain(CalcLimits.MaxDepth + 1), CategoryOf));
        Assert.Equal("That formula is too deep.", ex.Message);
        Assert.Equal("", ex.Path);
    }

    [Fact]
    public void Node_count_boundaries_are_200_allowed_201_too_large()
    {
        var at = Wide(199);
        var two = new BinNode("+", at, new NumNode(1)); // 1 + 199 + 1 = 201
        Assert.Equal(201, Count(two));
        var ex = Assert.Throws<CalcException>(() => CalcValidator.Validate(two, CategoryOf));
        Assert.Equal("That formula is too large.", ex.Message);

        var exact = Wide(201);
        Assert.Equal(201, Count(exact));
        Assert.Throws<CalcException>(() => CalcValidator.CheckLimits(exact));

        var edge = new BinNode("+", Wide(197), new NumNode(1)); // 199
        Assert.Equal(199, Count(edge));
        CalcValidator.CheckLimits(edge);
        var two00 = new BinNode("+", Wide(197), new UnNode("-", new NumNode(1))); // 200
        Assert.Equal(200, Count(two00));
        CalcValidator.CheckLimits(two00);
    }

    [Fact]
    public void CheckLimits_needs_no_catalog_and_runs_first()
    {
        // The unknown field would fail Validate, but the depth limit is reported first.
        ExprNode deep = new FieldNode("shop", "orders", "nope");
        for (var i = 0; i < CalcLimits.MaxDepth; i++) deep = new UnNode("-", deep);
        var ex = Assert.Throws<CalcException>(() => CalcValidator.Validate(deep, (_, _, _) => null));
        Assert.Equal("That formula is too deep.", ex.Message);
        Assert.Throws<CalcException>(() => CalcValidator.CheckLimits(deep));
        CalcValidator.CheckLimits(new FieldNode("shop", "orders", "nope")); // fine: no catalog involved
    }

    [Fact]
    public void Catalog_knows_the_six_aggregates_only()
    {
        foreach (var fn in new[] { "sum", "avg", "min", "max", "count", "countd" }) Assert.True(CalcCatalog.IsKnown(fn));
        Assert.False(CalcCatalog.IsKnown("median"));
        Assert.False(CalcCatalog.IsKnown("SUM"));
        Assert.Equal(6, CalcCatalog.Aggregates.Count);
    }

    [Fact]
    public void Limits_match_the_spec()
    {
        Assert.Equal(500, CalcLimits.MaxFormula);
        Assert.Equal(12, CalcLimits.MaxDepth);
        Assert.Equal(200, CalcLimits.MaxNodes);
        Assert.Equal(20, CalcLimits.MaxCalcs);
        Assert.Equal(60, CalcLimits.MaxName);
    }
}
