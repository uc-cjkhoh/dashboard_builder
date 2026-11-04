using DashboardBuilder.Features.Shell;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>The UI's display zone: configured, else the host machine's, else Malaysia time (UTC+8).</summary>
public class AppTimeZoneTests
{
    [Fact]
    public void A_valid_configured_zone_wins()
        => Assert.Equal("Asia/Tokyo", AppTimeZone.Resolve("Asia/Tokyo", "Asia/Kuala_Lumpur"));

    [Fact]
    public void An_explicitly_configured_UTC_is_honoured()
        => Assert.Equal("UTC", AppTimeZone.Resolve("UTC", "Asia/Kuala_Lumpur"));

    [Fact]
    public void Without_configuration_the_host_machines_zone_is_used()
        => Assert.Equal("Europe/Berlin", AppTimeZone.Resolve(null, "Europe/Berlin"));

    [Theory]
    [InlineData("UTC")]
    [InlineData("Etc/UTC")]
    [InlineData("GMT")]
    public void A_host_that_reports_plain_UTC_is_treated_as_unset(string host)
        => Assert.Equal(AppTimeZone.Fallback, AppTimeZone.Resolve(null, host));

    [Theory]
    [InlineData(null, null)]
    [InlineData("", "")]
    [InlineData("Not/AZone", "Also/NotAZone")]
    public void Unknown_or_missing_zones_fall_back_to_Malaysia_time(string? configured, string? host)
        => Assert.Equal("Asia/Kuala_Lumpur", AppTimeZone.Resolve(configured, host));
}
