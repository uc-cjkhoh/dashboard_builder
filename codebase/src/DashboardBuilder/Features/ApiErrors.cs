using System.Text.Json.Serialization;
using DashboardBuilder.ClickHouse;
using Microsoft.AspNetCore.Diagnostics; using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc; using Microsoft.AspNetCore.Mvc.ModelBinding;
namespace DashboardBuilder.Features;
/// <summary>The one error body every API failure returns.</summary>
public sealed record ApiError(string Error, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Field = null);
public static class ApiErrors
{
    /// <summary>Model-binding failures → { error, field }: first error only, no CLR names or parser positions.</summary>
    public static IActionResult FromModelState(ModelStateDictionary state)
    {
        // Prefer an entry that names a real field: a body that fails to parse also leaves a generic
        // "req is required" entry keyed by the body parameter.
        var bad = state.Where(kv => kv.Value is { Errors.Count: > 0 })
            .OrderBy(kv => ToFieldPath(kv.Key) is null).FirstOrDefault();
        var field = ToFieldPath(bad.Key);
        var required = bad.Value?.Errors.Any(e => e.ErrorMessage.EndsWith("field is required.", StringComparison.Ordinal)) == true;
        var message = field is null ? "Request body is missing or isn't valid JSON."
            : required ? $"'{field}' is required." : $"'{field}' has an invalid value.";
        return new BadRequestObjectResult(new ApiError(message, field));
    }
    // "$.filters[0].Value" → "filters[0].value"; the body parameter itself ("req"/"request"/"$") isn't a field.
    internal static string? ToFieldPath(string? key)
    {
        if (string.IsNullOrEmpty(key) || key == "$") return null;
        var k = key.StartsWith("$.", StringComparison.Ordinal) ? key[2..] : key;
        if (k is "req" or "request") return null;
        return string.Join('.', k.Split('.').Select(s => s.Length == 0 ? s : char.ToLowerInvariant(s[0]) + s[1..]));
    }
    /// <summary>Reject API bodies over <see cref="ApiLimits.MaxBodyBytes"/> with a 413 (declared length up front;
    /// chunked bodies via Kestrel's per-request limit, surfaced by <see cref="WriteUnhandledAsync"/>).</summary>
    public static WebApplication UseApiBodyLimit(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            if (ctx.Request.Path.StartsWithSegments("/api"))
            {
                if (ctx.Request.ContentLength > ApiLimits.MaxBodyBytes)
                {
                    ctx.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                    await ctx.Response.WriteAsJsonAsync(new ApiError("Request too large."));
                    return;
                }
                if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } f) f.MaxRequestBodySize = ApiLimits.MaxBodyBytes;
            }
            await next();
        });
        return app;
    }
    /// <summary>Last resort for anything a controller didn't catch. Logs the exception TYPE only (messages can carry credentials).</summary>
    public static async Task WriteUnhandledAsync(HttpContext ctx)
    {
        var ex = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
        if (ex is BadHttpRequestException bad)
        {
            ctx.Response.StatusCode = bad.StatusCode;
            await ctx.Response.WriteAsJsonAsync(new ApiError(bad.StatusCode == 413 ? "Request too large." : "Bad request."));
            return;
        }
        ctx.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("DashboardBuilder.Unhandled")
            .LogError("Unhandled {ErrorType} (ref {TraceId})", ex?.GetType().Name, ctx.TraceIdentifier);
        ctx.Response.StatusCode = StatusCodes.Status500InternalServerError;
        await ctx.Response.WriteAsJsonAsync(new ApiError($"Unexpected error (ref {ctx.TraceIdentifier})."));
    }
}
