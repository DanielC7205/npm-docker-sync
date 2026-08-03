using Docker.DotNet;
using Microsoft.Extensions.FileProviders;
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
    // Keep the web UI up even if Docker/NPM sync hits a transient failure
    options.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore;
});

builder.Services.AddSingleton(sp =>
{
    var config = sp.GetRequiredService<IConfiguration>();
    var dockerHost = config["DOCKER_HOST"] ?? "unix:///var/run/docker.sock";
    return new DockerClientConfiguration(new Uri(dockerHost)).CreateClient();
});

builder.Services.AddHttpClient<NginxProxyManagerClient>()
    .ConfigurePrimaryHttpMessageHandler(sp =>
    {
        var config = sp.GetRequiredService<IConfiguration>();
        // Disable automatic cookie handling so we can read NPMplus Set-Cookie
        // (HttpOnly session cookies; body may only contain "expires")
        var handler = new HttpClientHandler
        {
            UseCookies = false,
            AllowAutoRedirect = true,
        };
        var skipTls = config["NPM_TLS_SKIP_VERIFY"]?.ToLowerInvariant() is "true" or "1" or "yes" or "on";
        if (skipTls)
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
builder.Services.AddHostedService<DockerMonitorService>();
builder.Services.AddHostedService<NpmMirrorSyncService>();

var app = builder.Build();

var webUiToken = app.Configuration["WEB_UI_TOKEN"];

app.Use(async (context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/api") &&
        !context.Request.Path.StartsWithSegments("/api/health") &&
        !string.IsNullOrEmpty(webUiToken))
    {
        var auth = context.Request.Headers.Authorization.ToString();
        if (!auth.Equals($"Bearer {webUiToken}", StringComparison.Ordinal))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
            return;
        }
    }

    await next();
});

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/api/stats", async (SyncOrchestrator orchestrator, CancellationToken ct) =>
{
    try
    {
        var stats = await orchestrator.GetStatsAsync(ct);
        return Results.Ok(stats);
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
        var routes = await orchestrator.GetRoutesAsync(ct);
        return Results.Ok(routes);
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapPost("/api/routes/{containerId}/{index:int}/enabled", async (
    string containerId,
    int index,
    EnableRequest body,
    SyncOrchestrator orchestrator,
    CancellationToken ct) =>
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

app.MapPost("/api/routes/{containerId}/sync", async (
    string containerId,
    SyncOrchestrator orchestrator,
    CancellationToken ct) =>
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
