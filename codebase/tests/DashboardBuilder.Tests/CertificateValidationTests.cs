using DashboardBuilder.ClickHouse;
using Xunit;

namespace DashboardBuilder.Tests;

/// <summary>
/// P8 hardening (decision D11): TLS certificate validation is on by default. A connection only
/// bypasses validation when it is <em>both</em> secure and the user explicitly opted in — never
/// silently, and never on a plain (non-TLS) connection.
/// </summary>
public class CertificateValidationTests
{
    private static ClickHouseConnectionInfo Info(bool secure, bool allowInvalid) =>
        new("host", 8443, "default", "", secure, allowInvalid);

    [Fact]
    public void Secure_connection_validates_the_certificate_by_default()
        => Assert.False(ClickHouseGateway.BypassesCertificateValidation(Info(secure: true, allowInvalid: false)));

    [Fact]
    public void Secure_connection_bypasses_validation_only_on_explicit_opt_in()
        => Assert.True(ClickHouseGateway.BypassesCertificateValidation(Info(secure: true, allowInvalid: true)));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Plain_connection_never_bypasses_validation(bool allowInvalid)
        => Assert.False(ClickHouseGateway.BypassesCertificateValidation(Info(secure: false, allowInvalid)));

    [Fact]
    public void Client_view_surfaces_the_certificate_trust_state()
    {
        var view = Info(secure: true, allowInvalid: true).ToClientView();
        Assert.True(view.Secure);
        Assert.True(view.AllowInvalidCertificate);
    }

    [Fact]
    public void Client_view_reports_validated_certificate_for_a_default_secure_connection()
    {
        var view = Info(secure: true, allowInvalid: false).ToClientView();
        Assert.True(view.Secure);
        Assert.False(view.AllowInvalidCertificate);
    }
}
