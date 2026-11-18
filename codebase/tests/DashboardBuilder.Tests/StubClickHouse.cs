using System.Net;
using System.Text;

namespace DashboardBuilder.Tests;

/// <summary>A tiny in-process ClickHouse HTTP endpoint for gateway tests: records every statement (with the bound parameters it was sent
/// with) and answers each with a RowBinaryWithNamesAndTypes result chosen by the test. No real server, no credentials.</summary>
public sealed class StubClickHouse : IDisposable
{
    public sealed record Col(string Name, string Type);
    public sealed record Result(Col[] Columns, object?[][] Rows);
    public sealed record Seen(string Sql, string Url, string Form, string? Auth = null);

    private HttpListener _listener = new(); // a new one per attempt: a listener whose Start() failed is disposed and cannot be tried again
    private readonly Func<string, Result> _answer;
    public List<Seen> Statements { get; } = [];
    public int Port { get; }

    public StubClickHouse(Func<string, Result> answer)
    {
        _answer = answer;
        for (var tries = 0; ; tries++)
        {
            var port = Random.Shared.Next(20000, 60000);
            try { _listener.Prefixes.Add($"http://127.0.0.1:{port}/"); _listener.Start(); Port = port; break; }
            catch (HttpListenerException) when (tries < 20) { try { _listener.Close(); } catch { /* already disposed */ } _listener = new HttpListener(); }
        }
        _ = Task.Run(Loop);
    }

    private async Task Loop()
    {
        while (_listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = await _listener.GetContextAsync(); } catch { return; }
            try
            {
                Stream input = ctx.Request.InputStream;
                if (string.Equals(ctx.Request.Headers["Content-Encoding"], "gzip", StringComparison.OrdinalIgnoreCase)) input = new System.IO.Compression.GZipStream(input, System.IO.Compression.CompressionMode.Decompress);
                using var reader = new StreamReader(input, Encoding.UTF8);
                var body = await reader.ReadToEndAsync();
                var url = ctx.Request.Url!.Query;
                var sql = ctx.Request.Url.Query.Contains("query=", StringComparison.Ordinal) ? WebUtility.UrlDecode(url.Split("query=")[1].Split('&')[0]) : body;
                lock (Statements) Statements.Add(new Seen(sql, WebUtility.UrlDecode(url), body, ctx.Request.Headers["Authorization"] ?? ctx.Request.Headers["X-ClickHouse-User"]));
                var bytes = sql.StartsWith("SELECT version()", StringComparison.Ordinal) ? Encoding.UTF8.GetBytes("24.3.1.1\tUTC\n") : Encode(_answer(sql));
                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "application/octet-stream";
                await ctx.Response.OutputStream.WriteAsync(bytes);
            }
            catch { ctx.Response.StatusCode = 500; }
            finally { ctx.Response.Close(); }
        }
    }

    private static void VarInt(MemoryStream s, ulong v) { while (v >= 0x80) { s.WriteByte((byte)(v | 0x80)); v >>= 7; } s.WriteByte((byte)v); }
    private static void Str(MemoryStream s, string v) { var b = Encoding.UTF8.GetBytes(v); VarInt(s, (ulong)b.Length); s.Write(b); }

    internal static byte[] Encode(Result r)
    {
        using var s = new MemoryStream();
        VarInt(s, (ulong)r.Columns.Length);
        foreach (var c in r.Columns) Str(s, c.Name);
        foreach (var c in r.Columns) Str(s, c.Type);
        foreach (var row in r.Rows)
            for (var i = 0; i < r.Columns.Length; i++)
            {
                switch (r.Columns[i].Type)
                {
                    case "String": Str(s, (string)row[i]!); break;
                    case "UInt64": s.Write(BitConverter.GetBytes(Convert.ToUInt64(row[i]))); break;
                    case "Float64": s.Write(BitConverter.GetBytes(Convert.ToDouble(row[i]))); break;
                    case "DateTime": s.Write(BitConverter.GetBytes((uint)Convert.ToInt64(row[i]))); break;
                    case "Date": s.Write(BitConverter.GetBytes((ushort)Convert.ToInt32(row[i]))); break;
                    default: throw new NotSupportedException(r.Columns[i].Type);
                }
            }
        return s.ToArray();
    }

    public void Dispose() { try { _listener.Stop(); _listener.Close(); } catch { /* gone */ } }
}
