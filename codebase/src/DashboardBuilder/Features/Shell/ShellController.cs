using Microsoft.AspNetCore.Mvc;

namespace DashboardBuilder.Features.Shell;

/// <summary>
/// Serves the single SPA shell page. It carries no server state — all builder state lives in the
/// browser (ARCHITECTURE.md); the server only proxies read-only calls to ClickHouse. The page is
/// composed from per-feature partials (Connection, Schema, Canvas, Dashboard).
/// </summary>
public sealed class ShellController : Controller
{
    [HttpGet("/")]
    public IActionResult Index() => View();
}
