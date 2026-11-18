using System.Text;
using DashboardBuilder.ClickHouse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DashboardBuilder.Tests.StubClickHouse;

namespace DashboardBuilder.Tests;

/// <summary>ClickHouse calls reuse one HttpClient per endpoint (connection pooling). That is only safe if the client carries no
/// identity: each session's credentials must still go out per request, and a connection being disposed must not kill the client.</summary>
// The client table is process-wide and bounded (oldest dropped), so tests that hold a client across calls must not race other tests' endpoints.
[CollectionDefinition(nameof(SharedHttpClientTests), DisableParallelization = true)]
public class SharedHttpClientCollection;

[Collection(nameof(SharedHttpClientTests))]
public class SharedHttpClientTests
{
    private static ClickHouseConnectionInfo Info(int port, string user = "u", string pass = "p", bool secure = false, bool trust = false)
        => new("127.0.0.1", port, user, pass, secure, trust);

    [Fact] public void The_same_endpoint_gets_the_same_client_whoever_asks()
    {
        var a = SharedHttpClients.For(Info(41001, "alice", "a"), 15);
        var b = SharedHttpClients.For(Info(41001, "bob", "b"), 15);
        Assert.Same(a, b);
    }

    [Fact] public void Host_port_tls_and_the_trust_flag_each_get_their_own_client()
    {
        var plain = SharedHttpClients.For(Info(41002), 15);
        Assert.NotSame(plain, SharedHttpClients.For(Info(41003), 15));
        Assert.NotSame(plain, SharedHttpClients.For(Info(41002, secure: true), 15));
        Assert.NotSame(SharedHttpClients.For(Info(41002, secure: true), 15), SharedHttpClients.For(Info(41002, secure: true, trust: true), 15));
        Assert.Same(plain, SharedHttpClients.For(Info(41002, trust: true), 15)); // trusting a certificate means nothing without TLS (D11)
    }

    [Fact] public void The_table_of_clients_is_bounded()
    {
        for (var i = 0; i < SharedHttpClients.MaxClients * 2; i++) SharedHttpClients.For(Info(42000 + i), 15);
        Assert.True(SharedHttpClients.Count <= SharedHttpClients.MaxClients);
    }

    [Fact] public async Task Two_users_on_one_client_each_send_their_own_credentials_and_the_client_outlives_every_call()
    {
        using var stub = new StubClickHouse(_ => new Result([new Col("name", "String")], [["db1"]]));
        var gw = new ClickHouseGateway(NullLogger<ClickHouseGateway>.Instance);
        var client = SharedHttpClients.For(Info(stub.Port), 15);

        await gw.ListDatabasesAsync(Info(stub.Port, "alice", "pw-a"), default);
        await gw.ListDatabasesAsync(Info(stub.Port, "bob", "pw-b"), default);
        await gw.ListDatabasesAsync(Info(stub.Port, "alice", "pw-a"), default); // the client survived the earlier connections being disposed

        Assert.Same(client, SharedHttpClients.For(Info(stub.Port), 15));
        Assert.Empty(client.DefaultRequestHeaders); // nothing identity-bearing was parked on the shared client
        var users = stub.Statements.Where(s => s.Auth is not null).Select(s => Decode(s.Auth!)).Distinct().ToList();
        Assert.Equal(["alice:pw-a", "bob:pw-b"], users.OrderBy(u => u).ToList()); // each call carried its own pair, never a mix
        var seq = stub.Statements.Where(s => s.Auth is not null && s.Sql.StartsWith("SHOW")).Select(s => Decode(s.Auth!)).ToList();
        Assert.Equal(["alice", "bob", "alice"], seq.Select(u => u.Split(':')[0]).ToList());
    }

    private static string Decode(string auth)
        => auth.StartsWith("Basic ", StringComparison.OrdinalIgnoreCase) ? Encoding.UTF8.GetString(Convert.FromBase64String(auth[6..])) : auth;
}
