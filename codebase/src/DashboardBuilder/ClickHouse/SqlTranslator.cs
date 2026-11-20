using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace DashboardBuilder.ClickHouse;

/// <summary>The translated query, or why not. <see cref="Line"/>/<see cref="Col"/>/<see cref="Start"/> (1-based line, 1-based column of the end, 0-based start) place a parse error in the text that was sent.</summary>
public sealed record TranslateFailure(string Message, int? Line = null, int? Col = null, int? Start = null);

/// <summary>A translated query, and plain-language warnings about differences the user should know (they never block anything).</summary>
/// <summary><paramref name="Changes"/> names the repairs that make the ClickHouse query mean something other than the same text read as ClickHouse
/// (<c>ilike</c>, <c>case-fold</c>, <c>div-null</c>, <c>nulls-first</c>): when a MySQL → ClickHouse translation reports any, turning ClickHouse text into
/// MySQL and back is not lossless, which the browser uses to decide how to open a query.</summary>
/// <summary>One answer of the translator. <see cref="Probes"/>: for each <c>col = col</c> comparison the script could not decide (it does not know the columns' types), a
/// SELECT that describes the two columns as <c>l</c> and <c>r</c>; <see cref="SqlController"/> asks ClickHouse and calls again with the ids whose columns are both text.</summary>
public sealed record TranslateResult(string Sql, IReadOnlyList<string> Warnings, IReadOnlyList<string> Changes, IReadOnlyList<TypeProbe>? Probes = null)
{
    public IReadOnlyList<TypeProbe> ProbeList => Probes ?? [];
}

/// <summary>A query that describes the one or two columns of a comparison or a GROUP BY / ORDER BY / DISTINCT (<c>SELECT a.x AS l, b.y AS r FROM …</c>), by id.</summary>
public sealed record TypeProbe(int Id, string Sql, int Columns = 2);

/// <summary>The translator is not usable here (no Python 3, or the vendored library is missing): the dialect switch is unavailable, nothing else is.</summary>
public sealed class SqlTranslatorUnavailableException(string message) : Exception(message);

/// <summary>
/// Translates one query between MySQL and ClickHouse for the Edit SQL dialog's dialect switch (D106) by running <c>Tools/sql_translate.py</c>
/// (sqlglot, vendored in <c>Tools/vendor</c>) as a child process: <c>python3 -I</c>, fixed arguments, the request on stdin, the answer on stdout,
/// no shell, no network, a time limit and at most a few at once. MySQL → ClickHouse also repairs the places where sqlglot's plain output would run
/// but mean something else (see <c>Tools/sql_translate.py</c>) and refuses what it can't translate faithfully. It only converts text: the result is checked by <see cref="CustomSql"/> like any
/// other custom SQL before it is ever run, and it reads nothing from ClickHouse.
/// </summary>
public sealed class SqlTranslator
{
    public static readonly string[] Dialects = ["mysql", "clickhouse"];
    internal const int MaxOutputBytes = 64 * 1024;
    /// <summary>Column pairs per query whose types are asked for (the script's <c>MAX_PAIRS</c>).</summary>
    internal const int MaxProbes = 6;
    /// <summary>How long a request waits for one of the translator's slots before it is told the translator is busy.</summary>
    internal static readonly TimeSpan DefaultGateWait = TimeSpan.FromSeconds(5);

    private readonly SemaphoreSlim _gate; // at most `concurrency` python processes at a time; this class is a singleton, so the bound is the server's
    private readonly TimeSpan _gateWait;

    private readonly string _script, _python;
    private readonly TimeSpan _timeout;

    public SqlTranslator(string toolsDir, string python = "python3", TimeSpan? timeout = null, int concurrency = 4, TimeSpan? gateWait = null)
    {
        _gate = new SemaphoreSlim(Math.Max(1, concurrency));
        _gateWait = gateWait ?? DefaultGateWait;
        _script = Path.Combine(toolsDir, "sql_translate.py");
        _python = python;
        _timeout = timeout ?? TimeSpan.FromSeconds(10);
    }

    /// <summary>Convert <paramref name="sql"/> from <paramref name="from"/> to <paramref name="to"/> (each one of <see cref="Dialects"/>, and different).</summary>
    /// <exception cref="RequestValidationException">The query can't be read or has no equivalent (field <c>sql</c>); the message is a plain sentence.</exception>
    /// <exception cref="SqlTranslatorUnavailableException">No Python 3 or no vendored library on this server.</exception>
    public async Task<TranslateResult> TranslateAsync(string sql, string from, string to, CancellationToken ct, IReadOnlyList<int>? fold = null)
    {
        if (!Dialects.Contains(from) || !Dialects.Contains(to) || from == to) throw new RequestValidationException("Translate between mysql and clickhouse.", "from");
        if (string.IsNullOrWhiteSpace(sql)) throw new RequestValidationException("Write a SELECT query.", "sql");
        if (sql.Length > ApiLimits.MaxCustomSqlChars) throw new RequestValidationException($"The query can be at most {ApiLimits.MaxCustomSqlChars:N0} characters.", "sql");
        if (!File.Exists(_script)) throw new SqlTranslatorUnavailableException("The SQL translator is not installed on this server.");

        if (!await _gate.WaitAsync(_gateWait, ct)) throw new SqlTranslatorUnavailableException("The SQL translator is busy. Try again in a moment."); // a queue never grows without bound
        try
        {
            var psi = new ProcessStartInfo(_python) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8 };
            psi.ArgumentList.Add("-I"); // isolated: ignores PYTHON* variables and the user's site-packages
            psi.ArgumentList.Add(_script);
            Process proc;
            try { proc = Process.Start(psi) ?? throw new SqlTranslatorUnavailableException("Python 3 could not be started on this server."); }
            catch (System.ComponentModel.Win32Exception) { throw new SqlTranslatorUnavailableException("Python 3 is not installed on this server."); }
            using (proc)
            {
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
                limit.CancelAfter(_timeout);
                try
                {
                    var errors = proc.StandardError.ReadToEndAsync(limit.Token); // drained and ignored: a full stderr pipe would stall the script
                    await proc.StandardInput.WriteAsync(JsonSerializer.Serialize(new { sql, from, to, fold }));
                    proc.StandardInput.Close();
                    var text = await ReadLimitedAsync(proc.StandardOutput, limit.Token);
                    await proc.WaitForExitAsync(limit.Token);
                    try { await errors; } catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw; } catch { /* nothing to report */ }
                    return Interpret(text);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    try { proc.Kill(true); } catch { /* already gone */ }
                    throw new RequestValidationException("The translation took too long. Try a shorter query.", "sql");
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    throw new SqlTranslatorUnavailableException("The SQL translator stopped unexpectedly."); // a broken pipe to python is the translator's fault, not ClickHouse's
                }
                finally { if (!proc.HasExited) { try { proc.Kill(true); } catch { /* already gone */ } } }
            }
        }
        finally { _gate.Release(); }
    }

    private static async Task<string> ReadLimitedAsync(StreamReader reader, CancellationToken ct)
    {
        var sb = new StringBuilder(); var buf = new char[4096];
        int n;
        while ((n = await reader.ReadAsync(buf.AsMemory(), ct)) > 0)
        {
            sb.Append(buf, 0, n);
            if (sb.Length > MaxOutputBytes) throw new SqlTranslatorUnavailableException("The SQL translator gave an unusable answer.");
        }
        return sb.ToString();
    }

    /// <summary>The script's one JSON answer → the translated text, or the exception it stands for.</summary>
    internal static TranslateResult Interpret(string json)
    {
        JsonElement root;
        try { root = JsonDocument.Parse(json).RootElement; }
        catch (JsonException) { throw new SqlTranslatorUnavailableException("The SQL translator gave an unusable answer."); }
        if (root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True && root.TryGetProperty("sql", out var sql) && sql.GetString() is { Length: > 0 } text)
        {
            var warnings = root.TryGetProperty("warnings", out var w) && w.ValueKind == JsonValueKind.Array
                ? w.EnumerateArray().Select(x => x.GetString()).OfType<string>().Where(x => x.Length > 0).Take(5).ToList() : [];
            var changes = root.TryGetProperty("changes", out var c) && c.ValueKind == JsonValueKind.Array
                ? c.EnumerateArray().Select(x => x.GetString()).OfType<string>().Where(x => x.Length is > 0 and <= 40).Take(10).ToList() : [];
            var probes = root.TryGetProperty("probes", out var pr) && pr.ValueKind == JsonValueKind.Array
                ? pr.EnumerateArray().Select(x => x.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.Number && x.TryGetProperty("sql", out var q) && q.GetString() is { Length: > 0 and <= ApiLimits.MaxCustomSqlChars } text2
                    ? new TypeProbe(i.GetInt32(), text2, x.TryGetProperty("columns", out var n) && n.ValueKind == JsonValueKind.Number && n.GetInt32() is 1 or 2 ? n.GetInt32() : 2) : null).OfType<TypeProbe>().Take(MaxProbes).ToList() : [];
            return new TranslateResult(text, warnings, changes, probes);
        }
        var kind = root.TryGetProperty("kind", out var k) ? k.GetString() : "error";
        var message = root.TryGetProperty("error", out var e) ? e.GetString() ?? "This query could not be translated." : "This query could not be translated.";
        if (kind == "missing") throw new SqlTranslatorUnavailableException(message);
        throw new SqlTranslateException(message, ParseFailure(root, message));
    }

    private static TranslateFailure ParseFailure(JsonElement root, string message)
    {
        if (root.TryGetProperty("errors", out var list) && list.ValueKind == JsonValueKind.Array && list.GetArrayLength() > 0)
        {
            var first = list[0];
            int? Int(string name) => first.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
            return new TranslateFailure(message, Int("line"), Int("col"), Int("start"));
        }
        return new TranslateFailure(message);
    }
}

/// <summary>A query the translator could not read or convert; <see cref="Failure"/> carries the position when it has one.</summary>
public sealed class SqlTranslateException(string message, TranslateFailure failure) : Exception(message) { public TranslateFailure Failure { get; } = failure; }
