namespace DashboardBuilder.ClickHouse;

/// <summary>
/// A virtual table a worksheet query reads instead of a catalog table: a <c>union</c> (2..5 tables of one database stacked over
/// the columns they share by name and kind) or an <c>unpivot</c> (wide same-kind columns of one table turned into
/// <c>Field</c> / <c>Value</c> rows). <see cref="Name"/> is the table name the query's field references carry (it is never
/// sent to ClickHouse as an identifier); every real table and column named here is catalog-validated and quoted.
/// </summary>
/// <param name="Kind"><c>union</c> or <c>unpivot</c>.</param>
/// <param name="Db">The database every real table lives in.</param>
/// <param name="Name">The virtual table's name (what <see cref="TableRef.Table"/> and <see cref="ColumnRef.Table"/> say).</param>
/// <param name="Tables">Union: the 2..5 tables.</param>
/// <param name="Table">Unpivot: the table.</param>
/// <param name="Columns">Union: the shared columns to keep (null = every shared column). Unpivot: the 2..50 columns turned into rows.</param>
/// <param name="Keep">Unpivot: up to 5 columns kept beside Field and Value.</param>
public sealed record QuerySource(string Kind, string Db, string Name, string[]? Tables = null, string? Table = null, string[]? Columns = null, string[]? Keep = null);

/// <summary>A source ready to read: the derived-table SELECT, the columns it exposes, and the values it binds.</summary>
public sealed record SourceBuild(string Sql, IReadOnlyList<ColumnInfo> Columns, bool ColumnsTruncated,
    IReadOnlyList<(string Name, string Type, object Value)> Parameters, IReadOnlyList<string> Lossy);

/// <summary>
/// Builds the bounded derived table behind a union / unpivot source. Pure (the caller describes the real tables first), so the
/// statement is unit-tested without ClickHouse. Read-only; no identifier is built from anything the catalog did not return:
/// real names are quoted by <see cref="Identifier"/>, the union's table labels and the unpivot's <c>Field</c> values are bound
/// as <c>String</c> parameters (<c>us#</c> / <c>uf#</c>).
/// </summary>
public static class SourceSql
{
    public const string Union = "union", Unpivot = "unpivot";

    /// <summary>The real tables a source reads, in order (the order <see cref="Build"/> expects them described).</summary>
    public static IReadOnlyList<string> TablesOf(QuerySource s) => s.Kind == Union ? s.Tables ?? [] : [s.Table ?? ""];

    private static readonly System.Text.RegularExpressions.Regex IntType = new(@"^(U?)Int(8|16|32|64|128|256)$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>The widest type that holds every one of <paramref name="bases"/> (integers: the next signed width when signed and unsigned mix;
    /// floats: Float64). Float64 with <c>lossy</c> when no exact type exists (a Decimal in the mix, a 64-bit integer beside a float, UInt256 beside a signed).</summary>
    internal static (string Type, bool Lossy) NumericTarget(IReadOnlyList<string> bases)
    {
        var ints = bases.Select(b => IntType.Match(b)).ToList();
        if (ints.All(m => m.Success))
        {
            var signed = ints.Where(m => m.Groups[1].Value == "").Select(m => int.Parse(m.Groups[2].Value)).ToList();
            var unsigned = ints.Where(m => m.Groups[1].Value == "U").Select(m => int.Parse(m.Groups[2].Value)).ToList();
            if (unsigned.Count == 0) return ($"Int{signed.Max()}", false);
            if (signed.Count == 0) return ($"UInt{unsigned.Max()}", false);
            var need = Math.Max(signed.Max(), unsigned.Max() * 2);
            return need <= 256 ? ($"Int{new[] { 8, 16, 32, 64, 128, 256 }.First(w => w >= need)}", false) : ("Float64", true);
        }
        var onlyFloatsAndInts = bases.All(b => b is "Float32" or "Float64" || IntType.IsMatch(b));
        var wideInt = ints.Any(m => m.Success && int.Parse(m.Groups[2].Value) >= 64);
        return ("Float64", !onlyFloatsAndInts || wideInt);
    }

    /// <summary>Several columns of one name are stacked as they are when they differ only by Nullable / LowCardinality (Nullable is then
    /// declared on the result). Otherwise they are read as one type per kind: integers the widest exact integer type, other numbers Float64
    /// (<c>Lossy</c> when large values may round), text String, dates DateTime64(3). A kind with no such type is refused.</summary>
    internal static (string Type, Func<string, string>? Cast, bool Lossy) Unify(IReadOnlyList<ColumnInfo> columns, string label, string field)
    {
        if (columns.All(c => c.Type == columns[0].Type)) return (columns[0].Type, null, false);
        var bases = columns.Select(c => ClickHouseType.BaseType(c.Type)).ToList();
        var nullable = columns.Any(c => ClickHouseType.IsNullable(c.Type));
        string Wrap(string t) => nullable ? $"Nullable({t})" : t;
        if (bases.Distinct().Count() == 1) return (Wrap(bases[0]), null, false);
        switch (columns[0].Category)
        {
            case ClickHouseType.Numeric:
                var (type, lossy) = NumericTarget(bases.Distinct().ToList());
                return (Wrap(type), x => $"to{type}({x})", lossy);
            case ClickHouseType.Text: return (Wrap("String"), x => $"toString({x})", false);
            case ClickHouseType.Temporal: return (Wrap("DateTime64(3)"), x => $"toDateTime64({x}, 3)", false);
            default: throw new RequestValidationException($"'{label}' has different types, so its values can't be combined.", field);
        }
    }

    /// <summary>The union's derived table: each table's shared columns (cast alike where their types differ) after a bound source label.</summary>
    internal static SourceBuild BuildUnion(QuerySource s, IReadOnlyList<IReadOnlyList<ColumnInfo>> described)
    {
        var tables = s.Tables!;
        var (picked, truncated) = ClickHouseGateway.PickUnionColumns(described, s.Columns);
        var label = "Source table"; while (picked.Any(c => c.Name == label)) label += "_";
        var maps = described.Select(t => t.ToDictionary(c => c.Name, c => c, StringComparer.Ordinal)).ToList();
        var unified = picked.Select((c, i) => Unify(maps.Select(m => m[c.Name]).ToList(), c.Name, s.Columns is { Length: > 0 } ? $"source.columns[{i}]" : "source.tables")).ToList();
        var parameters = new List<(string, string, object)>();
        var branches = new List<string>();
        for (var t = 0; t < tables.Length; t++)
        {
            parameters.Add(($"us{t}", "String", tables[t]));
            var cells = picked.Select((c, i) => unified[i].Cast is { } cast ? $"{cast(Identifier.Quote(c.Name))} AS {Identifier.Quote(c.Name)}" : Identifier.Quote(c.Name));
            branches.Add($"SELECT {{us{t}:String}} AS {Identifier.Quote(label)}, {string.Join(", ", cells)} FROM {Identifier.QualifiedName(s.Db, tables[t])}");
        }
        var columns = new List<ColumnInfo> { new(label, "String", ClickHouseType.Text) };
        columns.AddRange(picked.Select((c, i) => new ColumnInfo(c.Name, unified[i].Type, c.Category)));
        return new SourceBuild(string.Join(" UNION ALL ", branches), columns, truncated, parameters, picked.Where((_, i) => unified[i].Lossy).Select(c => c.Name).ToList());
    }

    /// <summary>The unpivot's derived table: the kept columns beside one (Field, Value) pair per unpivoted column, read once via arrayJoin.</summary>
    internal static SourceBuild BuildUnpivot(QuerySource s, IReadOnlyList<ColumnInfo> described)
    {
        var keep = s.Keep ?? [];
        var cols = s.Columns ?? [];
        ClickHouseGateway.CheckUnpivot(described, cols, keep);
        var byName = described.ToDictionary(c => c.Name, c => c, StringComparer.Ordinal);
        var (valueType, cast, lossy) = Unify(cols.Select(c => byName[c]).ToList(), cols[0], "source.columns");
        var used = keep.Concat(cols).ToList();
        var field = "Field"; while (used.Contains(field)) field += "_";
        var value = "Value"; while (used.Contains(value)) value += "_";
        var p = ClickHouseGateway.FreeAliasPrefix("__u", described.Select(c => c.Name));
        var parameters = cols.Select((c, i) => ($"uf{i}", "String", (object)c)).ToList();
        var pairs = string.Join(", ", cols.Select((c, i) => $"({{uf{i}:String}}, {(cast is null ? Identifier.Quote(c) : cast(Identifier.Quote(c)))})"));
        var inner = string.Join(", ", keep.Select(Identifier.Quote).Append($"arrayJoin([{pairs}]) AS {Identifier.Quote(p + "p")}"));
        var outer = string.Join(", ", keep.Select(Identifier.Quote).Concat([
            $"tupleElement({Identifier.Quote(p + "p")}, 1) AS {Identifier.Quote(field)}",
            $"tupleElement({Identifier.Quote(p + "p")}, 2) AS {Identifier.Quote(value)}"]));
        var sql = $"SELECT {outer} FROM (SELECT {inner} FROM {Identifier.QualifiedName(s.Db, s.Table!)})";
        var columns = keep.Select(k => byName[k]).ToList();
        columns.Add(new ColumnInfo(field, "String", ClickHouseType.Text));
        columns.Add(new ColumnInfo(value, valueType, byName[cols[0]].Category));
        return new SourceBuild(sql, columns, false, parameters, lossy ? [value] : []);
    }

    /// <summary>The derived table for a source; <paramref name="described"/> holds each of <see cref="TablesOf"/>'s columns, in order.</summary>
    public static SourceBuild Build(QuerySource s, IReadOnlyList<IReadOnlyList<ColumnInfo>> described)
    {
        try { return s.Kind == Union ? BuildUnion(s, described) : BuildUnpivot(s, described[0]); }
        catch (RequestValidationException ex) when (ex.Field is { } f && !f.StartsWith("source.", StringComparison.Ordinal))
        { throw new RequestValidationException(ex.Message, "source." + f); } // the union / unpivot rules name the request's own fields
    }
}
