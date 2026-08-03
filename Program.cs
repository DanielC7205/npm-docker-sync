using System.Security.Claims;
using Docker.DotNet;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Extensions.FileProviders;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using NpmDockerSync.Services;
using Serilog;
using Serilog.Core;
using Serilog.Events;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft.Hosting.Lifetime", LogEventLevel.Information)
    .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
    .MinimumLevel.Override("System.Net.Http", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
    .Enrich.FromLogContext()
    .Enrich.With<ShortSourceContextEnricher>()
    .WriteTo.Console(
        outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss} [{Level:u3}] [{ShortContext}] {Message:lj}{NewLine}{Exception}"
    )
    .CreateLogger();

var builder = WebApplication.CreateBuilder(args);

builder.Configuration.AddJsonFile("appsettings.json", optional: false, reloadOnChange: true);
builder.Configuration.AddEnvironmentVariables();

var webUiPort = builder.Configuration["WEB_UI_PORT"] ?? "8080";
builder.WebHost.UseUrls($"http://0.0.0.0:{webUiPort}");

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
    options.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
});

builder.Host.UseSerilog();

builder.Services.Configure<HostOptions>(options =>
{
    options.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore;
});

builder.Services.AddSingleton<SettingsStore>();
builder.Services.AddHttpClient(nameof(IconResolver));
builder.Services.AddHttpClient(nameof(KomodoClient));
builder.Services.AddSingleton<IconResolver>(sp =>
    new IconResolver(sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(IconResolver)),
        sp.GetRequiredService<ILogger<IconResolver>>()));
builder.Services.AddSingleton<KomodoClient>();

builder.Services.AddSingleton(sp =>
{
    var config = sp.GetRequiredService<IConfiguration>();
    var dockerHost = config["DOCKER_HOST"] ?? "unix:///var/run/docker.sock";
    return new DockerClientConfiguration(new Uri(dockerHost)).CreateClient();
});

builder.Services.AddHttpClient<NginxProxyManagerClient>()
    .ConfigurePrimaryHttpMessageHandler(sp =>
    {
        var settings = sp.GetRequiredService<SettingsStore>();
        var handler = new HttpClientHandler
        {
            UseCookies = false,
            AllowAutoRedirect = true,
        };
        if (settings.GetBool("NPM_TLS_SKIP_VERIFY"))
        {
            handler.ServerCertificateCustomValidationCallback =
                HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }
        return handler;
    });
builder.Services.AddSingleton<LabelParser>();
builder.Services.AddSingleton<DockerNetworkService>();
builder.Services.AddSingleton<CertificateService>();
builder.Services.AddSingleton<InstanceIdentifier>();
builder.Services.AddSingleton<SyncOrchestrator>();
builder.Services.AddSingleton<NpmMirrorSyncService>();
builder.Services.AddSingleton<TunnelService>();
builder.Services.AddHostedService<DockerMonitorService>();
builder.Services.AddHostedService<NpmMirrorSyncService>();
builder.Services.AddHostedService<TunnelCleanupService>();

var authBuilder = builder.Services.AddAuthentication(options =>
    {
        options.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
        options.DefaultChallengeScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    })
    .AddCookie(CookieAuthenticationDefaults.AuthenticationScheme, options =>
    {
        options.LoginPath = "/login";
    });

{
    var oidcAuthority = builder.Configuration["OIDC_AUTHORITY"];
    var oidcClientId = builder.Configuration["OIDC_CLIENT_ID"];
    if (!string.IsNullOrWhiteSpace(oidcAuthority) && !string.IsNullOrWhiteSpace(oidcClientId))
    {
        authBuilder.AddOpenIdConnect(OpenIdConnectDefaults.AuthenticationScheme, options =>
        {
            options.Authority = oidcAuthority;
            options.ClientId = oidcClientId!;
            options.ClientSecret = builder.Configuration["OIDC_CLIENT_SECRET"];
            options.ResponseType = OpenIdConnectResponseType.Code;
            options.UsePkce = true;
            options.SaveTokens = true;
            options.GetClaimsFromUserInfoEndpoint = true;
            options.CallbackPath = builder.Configuration["OIDC_CALLBACK_PATH"] ?? "/signin-oidc";
            options.SignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
            var scopes = (builder.Configuration["OIDC_SCOPES"] ?? "openid profile email")
                .Split(' ', StringSplitOptions.RemoveEmptyEntries);
            options.Scope.Clear();
            foreach (var s in scopes)
                options.Scope.Add(s);
        });

        builder.Services.PostConfigure<AuthenticationOptions>(options =>
        {
            options.DefaultChallengeScheme = OpenIdConnectDefaults.AuthenticationScheme;
        });
    }

    builder.Services.AddAuthorization();
}

var app = builder.Build();

var settingsStore = app.Services.GetRequiredService<SettingsStore>();

app.UseAuthentication();
app.UseAuthorization();

app.Use(async (context, next) =>
{
    if (!context.Request.Path.StartsWithSegments("/api") ||
        context.Request.Path.StartsWithSegments("/api/health") ||
        context.Request.Path.StartsWithSegments("/api/auth"))
    {
        await next();
        return;
    }

    if (!settingsStore.IsAuthConfigured())
    {
        // Settings writes still blocked later
        await next();
        return;
    }

    if (context.User.Identity?.IsAuthenticated == true)
    {
        await next();
        return;
    }

    var auth = context.Request.Headers.Authorization.ToString();
    var webToken = settingsStore.Get("WEB_UI_TOKEN");
    var tunnelToken = settingsStore.Get("TUNNEL_API_TOKEN");
    var bearerOk = (!string.IsNullOrEmpty(webToken) && auth.Equals($"Bearer {webToken}", StringComparison.Ordinal))
                   || (!string.IsNullOrEmpty(tunnelToken) && auth.Equals($"Bearer {tunnelToken}", StringComparison.Ordinal));

    if (bearerOk)
    {
        await next();
        return;
    }

    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
    await context.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
});

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/api/auth/status", (SettingsStore settings, HttpContext ctx) =>
{
    return Results.Ok(new
    {
        authConfigured = settings.IsAuthConfigured(),
        oidcConfigured = settings.IsOidcConfigured(),
        authenticated = ctx.User.Identity?.IsAuthenticated == true,
        name = ctx.User.Identity?.Name,
    });
});

app.MapGet("/api/auth/me", (HttpContext ctx) =>
{
    if (ctx.User.Identity?.IsAuthenticated != true)
        return Results.Unauthorized();
    return Results.Ok(new
    {
        name = ctx.User.Identity?.Name,
        email = ctx.User.FindFirstValue(ClaimTypes.Email) ?? ctx.User.FindFirstValue("email"),
    });
});

app.MapGet("/api/auth/login", async (HttpContext ctx, SettingsStore settings) =>
{
    if (!settings.IsOidcConfigured())
        return Results.BadRequest(new { error = "OIDC is not configured" });
    await ctx.ChallengeAsync(OpenIdConnectDefaults.AuthenticationScheme, new AuthenticationProperties
    {
        RedirectUri = "/",
    });
    return Results.Empty;
});

app.MapGet("/api/auth/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    try
    {
        await ctx.SignOutAsync(OpenIdConnectDefaults.AuthenticationScheme);
    }
    catch
    {
        // OIDC may not be registered
    }
    return Results.Ok(new { success = true });
});

app.MapGet("/api/stats", async (SyncOrchestrator orchestrator, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await orchestrator.GetStatsAsync(ct));
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapGet("/api/routes", async (SyncOrchestrator orchestrator, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await orchestrator.GetRoutesAsync(ct));
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapPost("/api/routes/{containerId}/{index:int}/enabled", async (
    string containerId, int index, EnableRequest body, SyncOrchestrator orchestrator, CancellationToken ct) =>
{
    try
    {
        await orchestrator.SetEnabledAsync(containerId, index, body.Enabled, ct);
        return Results.Ok(new { success = true, enabled = body.Enabled });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPatch("/api/routes/{containerId}/{index:int}", async (
    string containerId, int index, RouteOverride body, SyncOrchestrator orchestrator, CancellationToken ct) =>
{
    try
    {
        await orchestrator.UpdateRouteOverrideAsync(containerId, index, body, ct);
        return Results.Ok(new { success = true });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapDelete("/api/routes/{containerId}/{index:int}/override", async (
    string containerId, int index, SyncOrchestrator orchestrator, CancellationToken ct) =>
{
    try
    {
        await orchestrator.ClearRouteOverrideAsync(containerId, index, ct);
        return Results.Ok(new { success = true });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/routes/{containerId}/sync", async (
    string containerId, SyncOrchestrator orchestrator, CancellationToken ct) =>
{
    try
    {
        await orchestrator.SyncNowAsync(containerId, ct);
        return Results.Ok(new { success = true });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapGet("/api/settings", (SettingsStore settings) => Results.Ok(settings.GetPublicSettings()));

app.MapPut("/api/settings", (SettingsStore settings, Dictionary<string, string?> body) =>
{
    if (!settings.IsAuthConfigured())
        return Results.Json(new { error = "Configure WEB_UI_TOKEN or OIDC before changing settings via the API" },
            statusCode: StatusCodes.Status403Forbidden);

    settings.UpdateSettings(body);
    return Results.Ok(settings.GetPublicSettings());
});

app.MapGet("/api/tunnels", (TunnelService tunnels) =>
{
    var list = tunnels.List().Select(t => new
    {
        t.Id,
        t.Slug,
        t.Domain,
        url = $"https://{t.Domain}",
        t.ForwardHost,
        t.ForwardPort,
        t.ForwardScheme,
        t.NpmHostId,
        expiresAt = t.ExpiresAt,
        t.Label,
        t.CreatedBy,
        createdAt = t.CreatedAt,
    });
    return Results.Ok(list);
});

app.MapPost("/api/tunnels", async (TunnelCreateRequest body, TunnelService tunnels, HttpContext ctx, CancellationToken ct) =>
{
    try
    {
        var createdBy = ctx.User.Identity?.Name ?? "api";
        var tunnel = await tunnels.CreateAsync(body.Port, body.Scheme, body.Host, body.TtlMinutes, body.Label, createdBy, ct);
        return Results.Ok(new
        {
            tunnel.Id,
            tunnel.Slug,
            tunnel.Domain,
            url = $"https://{tunnel.Domain}",
            expiresAt = tunnel.ExpiresAt,
            tunnel.ForwardHost,
            tunnel.ForwardPort,
        });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapDelete("/api/tunnels/{id}", async (string id, TunnelService tunnels, CancellationToken ct) =>
{
    try
    {
        await tunnels.DeleteAsync(id, ct);
        return Results.Ok(new { success = true });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/tunnels/{id}/extend", (string id, TunnelExtendRequest? body, TunnelService tunnels) =>
{
    try
    {
        var tunnel = tunnels.Extend(id, body?.TtlMinutes);
        return Results.Ok(new { tunnel.Id, url = $"https://{tunnel.Domain}", expiresAt = tunnel.ExpiresAt });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

var wwwroot = Path.Combine(app.Environment.ContentRootPath, "wwwroot");
if (Directory.Exists(wwwroot))
{
    var fileProvider = new PhysicalFileProvider(wwwroot);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = fileProvider });

    app.MapFallback(async context =>
    {
        if (context.Request.Path.StartsWithSegments("/api"))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var indexPath = Path.Combine(wwwroot, "index.html");
        if (File.Exists(indexPath))
        {
            context.Response.ContentType = "text/html";
            await context.Response.SendFileAsync(indexPath);
        }
        else
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
        }
    });
}

try
{
    Log.Information("Starting NPM Docker Sync (Web UI on port {Port})", webUiPort);
    await app.RunAsync();
}
catch (Exception ex)
{
    Log.Fatal(ex, "Application terminated unexpectedly");
    throw;
}
finally
{
    await Log.CloseAndFlushAsync();
}

public record EnableRequest(bool Enabled);
public record TunnelCreateRequest(int Port, string? Scheme, string? Host, int? TtlMinutes, string? Label);
public record TunnelExtendRequest(int? TtlMinutes);

class ShortSourceContextEnricher : ILogEventEnricher
{
    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory propertyFactory)
    {
        if (logEvent.Properties.TryGetValue("SourceContext", out var sourceContext) &&
            sourceContext is ScalarValue { Value: string context })
        {
            var lastDot = context.LastIndexOf('.');
            var shortName = lastDot >= 0 ? context[(lastDot + 1)..] : context;
            logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty("ShortContext", shortName));
        }
        else
        {
            logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty("ShortContext", string.Empty));
        }
    }
}
