using System.Net.Http.Headers;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace NpmDockerSync.Services;

/// <summary>
/// Applies OIDC settings from <see cref="SettingsStore"/> (SQLite + env) so UI-saved OIDC works without container restart.
/// </summary>
public sealed class OpenIdConnectSettingsConfigurator : IConfigureNamedOptions<OpenIdConnectOptions>
{
    public const string BackchannelHttpClientName = "oidc-backchannel";

    private readonly SettingsStore _settings;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<OpenIdConnectSettingsConfigurator> _logger;

    public OpenIdConnectSettingsConfigurator(
        SettingsStore settings,
        IHttpClientFactory httpClientFactory,
        ILogger<OpenIdConnectSettingsConfigurator> logger)
    {
        _settings = settings;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public void Configure(OpenIdConnectOptions options) => Configure(OpenIdConnectDefaults.AuthenticationScheme, options);

    public void Configure(string? name, OpenIdConnectOptions options)
    {
        if (name != OpenIdConnectDefaults.AuthenticationScheme)
            return;

        if (!_settings.IsOidcConfigured())
            return;

        var authorityRaw = _settings.Get("OIDC_AUTHORITY")!.Trim();
        var authority = NormalizeAuthentikAuthority(authorityRaw);
        options.Authority = authority;
        options.MetadataAddress = $"{authority}.well-known/openid-configuration";

        options.ClientId = _settings.Get("OIDC_CLIENT_ID");
        options.ClientSecret = _settings.Get("OIDC_CLIENT_SECRET");
        options.CallbackPath = _settings.Get("OIDC_CALLBACK_PATH") ?? "/signin-oidc";
        options.ResponseType = OpenIdConnectResponseType.Code;
        options.UsePkce = true;
        options.SaveTokens = true;
        options.GetClaimsFromUserInfoEndpoint = true;
        options.MapInboundClaims = false;
        options.SignInScheme = Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationDefaults.AuthenticationScheme;

        options.Backchannel = _httpClientFactory.CreateClient(BackchannelHttpClientName);
        options.Backchannel.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var clientId = options.ClientId;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuers = new[] { authority, authority.TrimEnd('/') },
            ValidateAudience = !string.IsNullOrWhiteSpace(clientId),
            ValidAudience = clientId,
            NameClaimType = "name",
            RoleClaimType = "groups",
        };

        var publicBase = _settings.GetWebUiPublicBaseUrl();
        var useSecureCookies = publicBase?.StartsWith("https://", StringComparison.OrdinalIgnoreCase) == true;
        if (useSecureCookies)
        {
            options.CorrelationCookie.SecurePolicy = CookieSecurePolicy.Always;
            options.CorrelationCookie.SameSite = SameSiteMode.None;
            options.NonceCookie.SecurePolicy = CookieSecurePolicy.Always;
            options.NonceCookie.SameSite = SameSiteMode.None;
        }

        options.Scope.Clear();
        foreach (var scope in (_settings.Get("OIDC_SCOPES") ?? "openid profile email")
                     .Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            options.Scope.Add(scope);
        }

        options.Events = new OpenIdConnectEvents
        {
            OnRedirectToIdentityProvider = ctx =>
            {
                var redirect = ResolveRedirectUri(ctx.Request, options);
                ctx.ProtocolMessage.RedirectUri = redirect;
                ctx.Properties.RedirectUri = redirect;
                _logger.LogDebug("OIDC authorize redirect_uri={RedirectUri}", redirect);
                return Task.CompletedTask;
            },
            OnRemoteFailure = ctx =>
            {
                var message = ctx.Failure?.Message ?? "OIDC login failed";
                _logger.LogError(ctx.Failure, "OIDC remote failure: {Message}", message);
                ctx.Response.Redirect($"/login?error={Uri.EscapeDataString(message)}");
                ctx.HandleResponse();
                return Task.CompletedTask;
            },
        };
    }

    internal static string NormalizeAuthentikAuthority(string authorityRaw)
    {
        var trimmed = authorityRaw.Trim().TrimEnd('/');
        // Authentik application issuers use a trailing slash; discovery lives under the same prefix.
        return trimmed + "/";
    }

    private string ResolveRedirectUri(HttpRequest request, OpenIdConnectOptions options)
    {
        var publicBase = _settings.GetWebUiPublicBaseUrl();
        if (!string.IsNullOrWhiteSpace(publicBase))
            return $"{publicBase.TrimEnd('/')}{options.CallbackPath}";

        var scheme = request.Scheme;
        var host = request.Host.Value;
        return $"{scheme}://{host}{options.CallbackPath}";
    }
}
