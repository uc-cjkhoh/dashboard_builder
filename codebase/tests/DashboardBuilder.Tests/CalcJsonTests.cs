using System.Net;
using System.Text;
using System.Text.Json;
using DashboardBuilder.ClickHouse;
using DashboardBuilder.ClickHouse.Calc;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>Calculated fields: the expression-tree wire format (discriminator <c>k</c>) and the optional
/// <c>Calc</c> field on <see cref="ColumnRef"/> / <see cref="MeasureRef"/>.</summary>
public class CalcJsonTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private const string Wire =
        """{"k":"bin","op":"/","l":{"k":"agg","fn":"sum","arg":{"k":"field","db":"shop","table":"orders","column":"amount"}},"r":{"k":"agg","fn":"sum","arg":{"k":"field","db":"shop","table":"orders","column":"qty"}}}""";

    [Fact]
    public void The_wire_example_round_trips_to_the_records()
    {
        var node = JsonSerializer.Deserialize<ExprNode>(Wire, Web);
        var expected = new BinNode("/",
            new AggNode("sum", new FieldNode("shop", "orders", "amount")),
            new AggNode("sum", new FieldNode("shop", "orders", "qty")));
        Assert.Equal(expected, node);

        var back = JsonDocument.Parse(JsonSerializer.Serialize(node, Web)).RootElement;
        Assert.Equal("bin", back.GetProperty("k").GetString());
        Assert.Equal("agg", back.GetProperty("l").GetProperty("k").GetString());
        Assert.Equal("field", back.GetProperty("l").GetProperty("arg").GetProperty("k").GetString());
    }

    [Fact]
    public void An_aggregate_may_carry_a_fraction_p_and_it_round_trips()
    {
        var node = JsonSerializer.Deserialize<ExprNode>("""{"k":"agg","fn":"percentile","arg":{"k":"num","v":1},"p":0.9}""", Web);
        Assert.Equal(new AggNode("percentile", new NumNode(1), 0.9), node);
        Assert.Equal(0.9, JsonDocument.Parse(JsonSerializer.Serialize(node, Web)).RootElement.GetProperty("p").GetDouble());
        Assert.Null(((AggNode)JsonSerializer.Deserialize<ExprNode>("""{"k":"agg","fn":"sum","arg":{"k":"num","v":1}}""", Web)!).P);
    }

    [Theory]
    [InlineData("""{"k":"agg","fn":"percentile","arg":{"k":"num","v":1},"p":"0.9"}""")]
    [InlineData("""{"k":"agg","fn":"percentile","arg":{"k":"num","v":1},"p":1e999}""")]
    public void A_malformed_fraction_throws_JsonException(string json)
        => Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ExprNode>(json, Web));

    [Fact]
    public void Num_and_unary_nodes_deserialise()
    {
        var node = JsonSerializer.Deserialize<ExprNode>("""{"k":"un","op":"-","arg":{"k":"num","v":2.5}}""", Web);
        Assert.Equal(new UnNode("-", new NumNode(2.5)), node);
    }

    [Fact]
    public void An_unknown_kind_throws_JsonException()
        => Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ExprNode>("""{"k":"nope"}""", Web));

    [Fact]
    public void A_node_without_k_throws_JsonException()
        => Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ExprNode>("""{"v":1}""", Web));

    [Theory]
    [InlineData("""{"k":"num","v":1e999}""")]
    [InlineData("""{"k":"num","v":"5"}""")]
    [InlineData("""{"k":"bin","op":"+","l":{"k":"num","v":1}}""")]
    [InlineData("""{"k":"field","db":"d","table":"t","column":3}""")]
    [InlineData("""[1]""")]
    public void A_malformed_node_throws_JsonException(string json)
        => Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ExprNode>(json, Web));

    [Fact]
    public async Task A_node_without_k_in_a_request_is_a_400()
    {
        var body = """{"from":{"db":"d","table":"t"},"rowDimensions":[{"db":"","table":"","column":"D","calc":{"op":"+"}}]}""";
        var r = await factory.CreateClient().PostAsync("/api/query", new StringContent(body, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public void Requests_without_Calc_still_deserialise_with_Calc_null()
    {
        var m = JsonSerializer.Deserialize<MeasureRef>("""{"db":"d","table":"t","column":"c","agg":"sum"}""", Web);
        Assert.NotNull(m);
        Assert.Null(m!.Calc);
        var c = JsonSerializer.Deserialize<ColumnRef>("""{"db":"d","table":"t","column":"c"}""", Web);
        Assert.Null(c!.Calc);
        var q = JsonSerializer.Deserialize<QueryRequest>(
            """{"from":{"db":"d","table":"t"},"measures":[{"db":"d","table":"t","column":"c","agg":"sum"}]}""", Web);
        Assert.Null(q!.Measures![0].Calc);
    }

    [Fact]
    public void Calc_on_a_measure_and_a_dimension_deserialises()
    {
        var m = JsonSerializer.Deserialize<MeasureRef>($$"""{"db":"","table":"","column":"Margin","agg":"calc","calc":{{Wire}}}""", Web);
        Assert.IsType<BinNode>(m!.Calc);
        var c = JsonSerializer.Deserialize<ColumnRef>("""{"db":"","table":"","column":"Neg","calc":{"k":"num","v":1}}""", Web);
        Assert.Equal(new NumNode(1), c!.Calc);
    }

    [Fact]
    public async Task An_unknown_node_kind_in_a_request_is_a_400_with_an_error_body()
    {
        var body = """{"from":{"db":"d","table":"t"},"measures":[{"db":"","table":"","column":"M","agg":"calc","calc":{"k":"nope"}}]}""";
        var r = await factory.CreateClient().PostAsync("/api/query", new StringContent(body, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        var json = JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;
        Assert.True(json.TryGetProperty("error", out var e) && e.GetString()!.Length > 0);
    }

    // An aggregate calculation carries no aggregation, so `agg` must bind as absent / null (not a "required" 400):
    // with no connection the request reaches the 409 gate.
    [Theory]
    [InlineData("""{"from":{"db":"d","table":"t"},"measures":[{"db":"d","table":"t","column":"M","calc":{"k":"agg","fn":"sum","arg":{"k":"num","v":1}}}]}""")]
    [InlineData("""{"from":{"db":"d","table":"t"},"measures":[{"db":"d","table":"t","column":"M","agg":null,"calc":{"k":"agg","fn":"sum","arg":{"k":"num","v":1}}}]}""")]
    [InlineData("""{"from":{"db":"d","table":"t"},"filters":[{"db":"d","table":"t","column":"c","op":"top","value":"2","topBy":{"db":"d","table":"t","column":"R","calc":{"k":"agg","fn":"sum","arg":{"k":"num","v":1}}}}]}""")]
    public async Task An_aggregate_calc_without_agg_binds(string body)
    {
        var r = await factory.CreateClient().PostAsync("/api/query", new StringContent(body, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
    }
}
