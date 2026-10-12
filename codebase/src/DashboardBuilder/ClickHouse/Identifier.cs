namespace DashboardBuilder.ClickHouse;

/// <summary>
/// The single place identifiers (database / table / column names) are made safe to
/// interpolate into ClickHouse SQL.
/// <para>
/// ClickHouse binds <em>values</em> as parameters but <strong>not identifiers</strong>, so
/// <c>SHOW TABLES FROM {db}</c> / <c>DESCRIBE {db}.{table}</c> must interpolate the name as
/// text. Two defences apply (CLAUDE.md golden rule 2 / decision D6):
/// </para>
/// <list type="number">
///   <item>the name is confirmed to exist in the live catalog for the connection (done by
///   <see cref="ClickHouseGateway"/> before it reaches a query), and</item>
///   <item>it is backtick-quoted here with internal backticks (and backslashes) escaped, so
///   a hostile name cannot terminate the identifier and inject SQL.</item>
/// </list>
/// Quoting is deliberately total: any non-empty string becomes exactly one identifier token.
/// </summary>
public static class Identifier
{
    /// <summary>
    /// Backtick-quote a single identifier, escaping <c>\</c> then <c>`</c>. The result always
    /// begins and ends with a backtick and contains no unescaped backtick, so it is a single
    /// safe token regardless of the input.
    /// </summary>
    /// <exception cref="ArgumentException">The identifier is null, empty, or contains NUL.</exception>
    public static string Quote(string identifier)
    {
        if (string.IsNullOrEmpty(identifier))
            throw new ArgumentException("Identifier must not be null or empty.", nameof(identifier));
        if (identifier.Contains('\0'))
            throw new ArgumentException("Identifier must not contain a NUL character.", nameof(identifier));

        // Order matters: escape backslashes first, then backticks.
        var escaped = identifier.Replace("\\", "\\\\").Replace("`", "\\`");
        return string.Concat("`", escaped, "`");
    }

    /// <summary>Quote a <c>db.table</c> pair as <c>`db`.`table`</c>.</summary>
    public static string QualifiedName(string database, string table)
        => string.Concat(Quote(database), ".", Quote(table));
}
