namespace DashboardBuilder.ClickHouse;
/// <summary>Client input that breaks a rule. Always a 400 with this message and the offending field path.</summary>
public sealed class RequestValidationException(string message, string? field = null) : Exception(message)
{ public string? Field { get; } = field; }
/// <summary>Every input bound — mirrored in Features/Core/validate.js LIMITS. Reject beyond these, never clamp.</summary>
public static class ApiLimits
{
    public const int MaxBodyBytes = 256 * 1024;
    public const int MaxHostLength = 253, MaxUserLength = 64, MaxPasswordLength = 256;
    public const int MaxDimensions = 12, MaxMeasures = 10, MaxJoins = 10, MaxFilters = 8;
    public const int MaxInValues = 500, MaxFilterValueLength = 1000;
    public const int MaxRowLimit = 500, MaxBuckets = 100, MaxDistinct = 1000;
}
