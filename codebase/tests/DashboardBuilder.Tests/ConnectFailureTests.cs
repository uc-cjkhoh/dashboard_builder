using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using DashboardBuilder.ClickHouse;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>A failed connect says which thing is wrong (password, host/port, TLS setting, certificate) — plain words, the right
/// field, and never the password. Real transports: closed port, plain HTTP stub, raw TCP, a TLS server with a self-signed cert.</summary>
public class ConnectFailureTests
{
    private const string Secret = "s3cret-pw-XYZ";
    private static ClickHouseGateway Gw() => new(NullLogger<ClickHouseGateway>.Instance);
    private static ClickHouseConnectionInfo Info(int port, bool secure, bool trust = false)
        => new("127.0.0.1", port, "ann", Secret, secure, trust);

    private static int FreePort() { var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); var p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p; }

    private static void NoSecret(ConnectFailure f) => Assert.DoesNotContain(Secret, f.Message);

    [Fact] public async Task A_closed_port_says_the_server_cannot_be_reached_at_host_and_port()
    {
        var (f, _) = await Gw().ValidateAsync(Info(FreePort(), false), default);
        Assert.NotNull(f); NoSecret(f);
        Assert.Equal("host", f.Field);
        Assert.Contains("Can't reach 127.0.0.1:", f.Message);
        Assert.Equal(502, f.Status);
    }

    [Fact] public async Task A_wrong_password_is_401_on_the_password_field()
    {
        using var l = new HttpListener(); var port = FreePort(); l.Prefixes.Add($"http://127.0.0.1:{port}/"); l.Start();
        _ = Task.Run(async () =>
        {
            var ctx = await l.GetContextAsync();
            ctx.Response.StatusCode = 403;
            await ctx.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("Code: 516. DB::Exception: ann: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)\n"));
            ctx.Response.Close();
        });
        var (f, _) = await Gw().ValidateAsync(Info(port, false), default);
        Assert.NotNull(f); NoSecret(f);
        Assert.Equal(401, f.Status); Assert.Equal("password", f.Field);
        Assert.Equal("Wrong user name or password.", f.Message);
    }

    [Fact] public async Task TLS_on_a_plain_HTTP_port_says_to_turn_Secure_off()
    {
        using var stub = new StubClickHouse(_ => new(new[] { new StubClickHouse.Col("1", "UInt64") }, [[1UL]]));
        var (f, _) = await Gw().ValidateAsync(Info(stub.Port, true), default);
        Assert.NotNull(f); NoSecret(f);
        Assert.Contains("Turn Secure (TLS) off for an HTTP port such as 8123", f.Message);
        Assert.Null(f.Field);
    }

    [Fact] public async Task Plain_HTTP_to_a_TLS_port_says_to_turn_Secure_on()
    {
        var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); var port = ((IPEndPoint)l.LocalEndpoint).Port;
        _ = Task.Run(async () => { using var c = await l.AcceptTcpClientAsync(); await Task.Delay(50); });
        try
        {
            var (f, _) = await Gw().ValidateAsync(Info(port, false), default);
            Assert.NotNull(f); NoSecret(f);
            Assert.Contains("Turn Secure (TLS) on", f.Message);
        }
        finally { l.Stop(); }
    }

    [Fact] public async Task A_certificate_that_is_not_trusted_is_named_and_the_trust_switch_is_the_way_out()
    {
        using var rsa = RSA.Create(2048);
        var req = new CertificateRequest("CN=localhost", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var cert0 = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        using var cert = new X509Certificate2(cert0.Export(X509ContentType.Pfx));
        var l = new TcpListener(IPAddress.Loopback, 0); l.Start(); var port = ((IPEndPoint)l.LocalEndpoint).Port;
        _ = Task.Run(async () =>
        {
            try { using var c = await l.AcceptTcpClientAsync(); using var ssl = new SslStream(c.GetStream()); await ssl.AuthenticateAsServerAsync(cert); await Task.Delay(100); } catch { /* client hangs up */ }
        });
        try
        {
            var (f, _) = await Gw().ValidateAsync(Info(port, true, trust: false), default);
            Assert.NotNull(f); NoSecret(f);
            Assert.Contains("certificate", f.Message);
            Assert.Contains("Trust invalid / self-signed certificate", f.Message);
        }
        finally { l.Stop(); }
    }
}
