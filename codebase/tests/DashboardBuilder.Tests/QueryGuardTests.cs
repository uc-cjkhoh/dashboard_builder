using ClickHouse.Client;
using ClickHouse.Client.ADO;
using DashboardBuilder.ClickHouse;
using DashboardBuilder.Features;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// Database-level guards (roadmap item 4): every query carries ClickHouse's own read-only and
/// time-limit settings, so the read-only invariant does not rest on our SQL builders alone, a
/// runaway query is stopped server-side, and a client disconnect cancels the query. When the server
/// refuses a setting, the connection steps down instead of failing: a settings constraint (code 452,
/// usually on max_execution_time) drops only the time limit; an account the server already locks
/// read-only (code 164) runs with no settings — the server guards it.
/// </summary>
public class QueryGuardTests
{
    private static ClickHouseConnectionInfo Info(QueryGuards guards = QueryGuards.Full) =>
        new("host", 8443, "analyst", "secret", true, false, guards);

    private static ClickHouseServerException ServerError(int code) => new("refused", "SELECT 1", code);

    private static IDictionary<string, object> SettingsOf(ClickHouseConnectionInfo info) =>
        new ClickHouseConnection(ClickHouseGateway.BuildConnectionString(info)).CustomSettings;

    [Fact]
    public void Every_query_is_marked_read_only_at_the_database()
        => Assert.Equal("2", SettingsOf(Info())["readonly"].ToString());

    [Fact]
    public void Every_query_has_a_server_side_time_limit_shorter_than_the_http_timeout()
    {
        var seconds = int.Parse(SettingsOf(Info())["max_execution_time"].ToString()!);
        Assert.Equal(ClickHouseGateway.MaxExecutionSeconds, seconds);
        Assert.True(seconds < ClickHouseGateway.HttpTimeoutSeconds);
    }

    [Fact]
    public void A_client_disconnect_cancels_the_running_query()
        => Assert.Equal("1", SettingsOf(Info())["cancel_http_readonly_queries_on_client_close"].ToString());

    [Fact]
    public void An_account_the_server_already_locks_read_only_gets_no_setting_changes()
        => Assert.Empty(SettingsOf(Info(QueryGuards.None)));

    [Fact]
    public void Without_the_time_limit_queries_stay_read_only_and_cancel_on_disconnect()
    {
        var settings = SettingsOf(Info(QueryGuards.NoTimeLimit));
        Assert.Equal("2", settings["readonly"].ToString());
        Assert.Equal("1", settings["cancel_http_readonly_queries_on_client_close"].ToString());
        Assert.False(settings.ContainsKey("max_execution_time"));
    }

    [Fact]
    public void A_read_only_account_steps_down_to_no_settings()
        => Assert.Equal(QueryGuards.None, ClickHouseGateway.NextGuards(QueryGuards.Full, ServerError(164)));

    [Fact]
    public void A_settings_constraint_drops_only_the_time_limit()
        => Assert.Equal(QueryGuards.NoTimeLimit, ClickHouseGateway.NextGuards(QueryGuards.Full, ServerError(452)));

    [Theory]
    [InlineData(164)]
    [InlineData(452)]
    public void A_further_refusal_without_the_time_limit_steps_down_to_no_settings(int code)
        => Assert.Equal(QueryGuards.None, ClickHouseGateway.NextGuards(QueryGuards.NoTimeLimit, ServerError(code)));

    [Theory]
    [InlineData(164)]
    [InlineData(452)]
    public void With_no_settings_left_there_is_nothing_to_step_down_to(int code)
        => Assert.Null(ClickHouseGateway.NextGuards(QueryGuards.None, ServerError(code)));

    [Fact]
    public void Other_server_errors_do_not_trigger_a_step_down()
        => Assert.Null(ClickHouseGateway.NextGuards(QueryGuards.Full, ServerError(516)));

    [Fact]
    public void Non_server_errors_do_not_trigger_a_step_down()
        => Assert.Null(ClickHouseGateway.NextGuards(QueryGuards.Full, new HttpRequestException("no route")));

    [Fact]
    public void A_server_side_timeout_becomes_a_504_with_an_actionable_message()
    {
        var (status, message) = ApiControllerBase.DescribeFailure(
            new ClickHouseServerException("Timeout exceeded", "SELECT …", 159), "t");
        Assert.Equal(504, status);
        Assert.Contains($"{ClickHouseGateway.MaxExecutionSeconds} seconds", message);
    }

    [Fact]
    public void An_http_timeout_becomes_the_same_actionable_504()
    {
        // Without the server-side limit (a stepped-down connection) the HTTP timeout stops the query.
        var (status, message) = ApiControllerBase.DescribeFailure(
            new TaskCanceledException("timed out", new TimeoutException()), "t");
        Assert.Equal(504, status);
        Assert.Contains($"{ClickHouseGateway.HttpTimeoutSeconds} seconds", message);
    }

    [Fact]
    public void An_http_timeout_is_a_failure_to_report_not_a_client_abort()
        => Assert.False(ApiControllerBase.IsClientAbort(new TaskCanceledException("timed out", new TimeoutException())));

    [Fact]
    public void A_client_abort_is_left_to_the_framework()
        => Assert.True(ApiControllerBase.IsClientAbort(new OperationCanceledException()));

    [Fact]
    public void Other_failures_stay_a_generic_credential_free_502()
    {
        var (status, message) = ApiControllerBase.DescribeFailure(
            new ClickHouseServerException("password=secret leaked", "SELECT 1", 516), "t");
        Assert.Equal(502, status);
        Assert.DoesNotContain("secret", message);
    }
}
