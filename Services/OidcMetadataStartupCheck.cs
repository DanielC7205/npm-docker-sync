using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

/// <summary>Logs whether OIDC discovery/JWKS can be loaded at startup (helps diagnose IDX10500).</summary>
public sealed class OidcMetadataStartupCheck : IHostedService
{
    private readonly SettingsStore _settings;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<OidcMetadataStartupCheck> _logger;

    public OidcMetadataStartupCheck(
        SettingsStore settings,
        IHttpClientFactory httpClientFactory,
        ILogger<OidcMetadataStartupCheck> logger)
    {
        _settings = settings;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!_settings.IsOidcConfigured())
            return;

        var authority = OpenIdConnectSettingsConfigurator.NormalizeAuthentikAuthority(_settings.Get("OIDC_AUTHORITY")!);
        var metadataUrl = $"{authority}.well-known/openid-configuration";
        var redirect = _settings.GetWebUiPublicBaseUrl() is { Length: > 0 } pub
            ? $"{pub.TrimEnd('/')}{_settings.Get("OIDC_CALLBACK_PATH") ?? "/signin-oidc"}"
            : "(set WEB_UI_PUBLIC_URL for reverse-proxy deployments)";

        try
        {
            var client = _httpClientFactory.CreateClient(OpenIdConnectSettingsConfigurator.BackchannelHttpClientName);
            using var response = await client.GetAsync(metadataUrl, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning(
                    "OIDC discovery GET {Url} returned {StatusCode} — login may fail (IDX10500). Check authority URL and TLS from container.",
                    metadataUrl, (int)response.StatusCode);
                return;
            }

            var json = await response.Content.ReadAsStringAsync(cancellationToken);
            var hasJwks = json.Contains("jwks_uri", StringComparison.OrdinalIgnoreCase);
            _logger.LogInformation(
                "OIDC discovery OK at {Url}. Register redirect URI in your IdP: {RedirectUri}. jwks_uri present={HasJwks}",
                metadataUrl, redirect, hasJwks);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "OIDC discovery failed for {Url}", metadataUrl);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
