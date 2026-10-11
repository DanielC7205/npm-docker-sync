using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace NpmDockerSync.Services;

/// <summary>
/// Applies OIDC settings from <see cref="SettingsStore"/> (SQLite + env) so UI-saved OIDC works without container restart.
/// </summary>
public sealed class OpenIdConnectSettingsConfigurator : IConfigureNamedOptions<OpenIdConnectOptions>
{
    private readonly SettingsStore _settings;

    public OpenIdConnectSettingsConfigurator(SettingsStore settings)
    {
        _settings = settings;
    }

    public void Configure(OpenIdConnectOptions options) => Configure(OpenIdConnectDefaults.AuthenticationScheme, options);

    public void Configure(string? name, OpenIdConnectOptions options)
    {
        if (name != OpenIdConnectDefaults.AuthenticationScheme)
            return;

        if (!_settings.IsOidcConfigured())
            return;

        options.Authority = _settings.Get("OIDC_AUTHORITY")!.TrimEnd('/');
        options.ClientId = _settings.Get("OIDC_CLIENT_ID");
        options.ClientSecret = _settings.Get("OIDC_CLIENT_SECRET");
        options.CallbackPath = _settings.Get("OIDC_CALLBACK_PATH") ?? "/signin-oidc";
        options.ResponseType = OpenIdConnectResponseType.Code;
        options.UsePkce = true;
        options.SaveTokens = true;
        options.GetClaimsFromUserInfoEndpoint = true;
        options.SignInScheme = Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationDefaults.AuthenticationScheme;

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
                var publicBase = _settings.GetWebUiPublicBaseUrl();
                if (!string.IsNullOrWhiteSpace(publicBase))
                    ctx.ProtocolMessage.RedirectUri = $"{publicBase.TrimEnd('/')}{options.CallbackPath}";
                return Task.CompletedTask;
            },
        };
    }
}
