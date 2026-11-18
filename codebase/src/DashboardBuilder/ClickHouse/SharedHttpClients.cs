using System.Net;
using System.Net.Http;

namespace DashboardBuilder.ClickHouse;

/// <summary>
/// One long-lived <see cref="HttpClient"/> per ClickHouse endpoint, so repeated queries reuse the pooled TCP/TLS connection
/// instead of opening (and handshaking) a fresh one for every call.
/// <para>The key is <b>only</b> what shapes the transport — host, port, TLS on/off and the D11 "trust an invalid certificate" flag.
/// Credentials never reach the client: ClickHouse.Client sends them per request, so sessions with different users share a
/// connection pool but not an identity (<c>SharedHttpClientTests</c> pins this).</para>
/// </summary>
internal static class SharedHttpClients
{
    private readonly record struct Key(string Host, int Port, bool Secure, bool TrustAnyCertificate);

    /// <summary>The users can name any host:port, so the table is bounded; the oldest entry is dropped (not disposed — a request may
    /// still be using it; its idle pooled connections close on their own after <see cref="IdleTimeout"/>).</summary>
    internal const int MaxClients = 32;
    private static readonly TimeSpan LifeTime = TimeSpan.FromMinutes(5), IdleTimeout = TimeSpan.FromMinutes(1);
    private static readonly Dictionary<Key, HttpClient> Clients = [];
    private static readonly Queue<Key> Order = new();
    private static readonly Lock Gate = new();

    internal static int Count { get { lock (Gate) return Clients.Count; } }

    public static HttpClient For(ClickHouseConnectionInfo info, int timeoutSeconds)
    {
        var key = new Key(info.Host.ToLowerInvariant(), info.Port, info.Secure, ClickHouseGateway.BypassesCertificateValidation(info));
        lock (Gate)
        {
            if (Clients.TryGetValue(key, out var existing)) return existing;
            while (Clients.Count >= MaxClients && Order.TryDequeue(out var oldest)) Clients.Remove(oldest);
            var handler = new SocketsHttpHandler
            {
                // ClickHouse.Client asks for compressed responses, so a hand-supplied HttpClient must decompress them itself.
                AutomaticDecompression = DecompressionMethods.All,
                PooledConnectionLifetime = LifeTime, // re-resolves DNS and recycles connections now and then
                PooledConnectionIdleTimeout = IdleTimeout,
            };
            if (key.TrustAnyCertificate) handler.SslOptions.RemoteCertificateValidationCallback = static (_, _, _, _) => true;
            var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(timeoutSeconds) }; // bound the wait: an unresponsive host fails cleanly
            Clients[key] = client;
            Order.Enqueue(key);
            return client;
        }
    }
}
