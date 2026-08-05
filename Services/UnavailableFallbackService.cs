using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

/// <summary>
/// Retargets NPM proxy hosts at this app's /unavailable page when a tunnel or service is gone.
/// </summary>
public class UnavailableFallbackService
{
    private readonly SettingsStore _settings;
    private readonly NginxProxyManagerClient _npm;
    private readonly DockerNetworkService _networks;
    private readonly IConfiguration _configuration;
    private readonly ILogger<UnavailableFallbackService> _logger;

    public UnavailableFallbackService(
        SettingsStore settings,
        NginxProxyManagerClient npm,
        DockerNetworkService networks,
        IConfiguration configuration,
        ILogger<UnavailableFallbackService> logger)
    {
        _settings = settings;
        _npm = npm;
        _networks = networks;
        _configuration = configuration;
        _logger = logger;
    }

    public bool IsEnabled() => _settings.GetBool("UNAVAILABLE_FALLBACK_ENABLED", true);

    public (string Host, int Port, string Scheme) ResolveFallbackUpstream()
    {
        var host = (_settings.Get("FALLBACK_FORWARD_HOST")
                    ?? _settings.Get("DOCKER_HOST_IP")
                    ?? _configuration["NPM_CONTAINER_NAME"]
                    ?? "host.docker.internal")?.Trim();

        if (string.IsNullOrWhiteSpace(host))
            host = "host.docker.internal";

        // Prefer this container's Docker DNS name when NPM shares a network
        var selfName = Environment.GetEnvironmentVariable("HOSTNAME");
        var npmName = _settings.Get("NPM_CONTAINER_NAME") ?? _configuration["NPM_CONTAINER_NAME"];
        if (!string.IsNullOrWhiteSpace(_configuration["FALLBACK_FORWARD_HOST"]))
            host = _configuration["FALLBACK_FORWARD_HOST"]!.Trim();
        else if (!string.IsNullOrWhiteSpace(_settings.Get("FALLBACK_FORWARD_HOST")))
            host = _settings.Get("FALLBACK_FORWARD_HOST")!.Trim();

        var port = int.TryParse(_configuration["WEB_UI_PORT"] ?? _settings.Get("WEB_UI_PORT"), out var p) && p > 0
            ? p
            : 8080;

        return (host!, port, "http");
    }

    public string BuildUnavailablePath(string kind, string? name, string reason)
    {
        var qs = new List<string>
        {
            $"kind={Uri.EscapeDataString(kind)}",
            $"reason={Uri.EscapeDataString(reason)}",
        };
        if (!string.IsNullOrWhiteSpace(name))
            qs.Add($"name={Uri.EscapeDataString(name.Trim())}");
        return "/unavailable?" + string.Join("&", qs);
    }

    public async Task RetargetHostAsync(
        int hostId,
        string kind,
        string? name,
        string reason,
        CancellationToken cancellationToken)
    {
        if (!IsEnabled())
            return;

        var existing = await _npm.GetProxyHostByIdAsync(hostId, cancellationToken)
            ?? throw new InvalidOperationException($"Proxy host {hostId} not found");

        var (fbHost, fbPort, fbScheme) = ResolveFallbackUpstream();
        var path = BuildUnavailablePath(kind, name, reason);

        var meta = existing.Meta != null
            ? new Dictionary<string, object>(existing.Meta)
            : new Dictionary<string, object>();

        // Stash originals once so we can restore later
        if (!meta.ContainsKey("fallback_original_host"))
        {
            meta["fallback_original_host"] = existing.ForwardHost ?? string.Empty;
            meta["fallback_original_port"] = existing.ForwardPort;
            meta["fallback_original_scheme"] = existing.ForwardScheme ?? "http";
            meta["fallback_original_advanced"] = existing.AdvancedConfig ?? string.Empty;
        }

        meta["unavailable"] = true;
        meta["unavailable_kind"] = kind;
        meta["unavailable_reason"] = reason;
        meta["managed_by"] = meta.GetValueOrDefault("managed_by") ?? "npm-docker-sync";

        var accessListIds = existing.NpmplusAccessListIds ?? new List<int>();
        if (accessListIds.Count == 0 && existing.AccessListId is > 0)
            accessListIds = new List<int> { existing.AccessListId.Value };

        var request = new ProxyHostRequest
        {
            DomainNames = existing.DomainNames ?? new List<string>(),
            ForwardScheme = fbScheme,
            ForwardHost = fbHost,
            ForwardPort = fbPort,
            AccessListId = existing.AccessListId ?? 0,
            NpmplusAccessListIds = accessListIds,
            NpmplusAccessListType = existing.NpmplusAccessListType
                ?? (accessListIds.Count > 0 ? "custom" : "public"),
            CertificateId = existing.CertificateId ?? 0,
            SslForced = existing.SslForced != 0 || (existing.CertificateId ?? 0) > 0,
            CachingEnabled = false,
            BlockExploits = existing.BlockExploits != 0,
            AdvancedConfig = $"rewrite ^ /{path.TrimStart('/')} break;\n",
            AllowWebsocketUpgrade = existing.AllowWebsocketUpgrade != 0,
            Http2Support = existing.Http2Support != 0,
            HstsEnabled = existing.HstsEnabled != 0,
            HstsSubdomains = existing.HstsSubdomains != 0,
            Enabled = true,
            NpmplusAuthRequest = "none",
            NpmplusAuthRequestUpstream = string.Empty,
            NpmplusHttp3Support = existing.NpmplusHttp3Support != 0,
            TrustForwardedProto = existing.TrustForwardedProto != 0,
            NpmplusLocationConfig = existing.NpmplusLocationConfig ?? string.Empty,
            NpmplusNoindex = existing.NpmplusNoindex != 0,
            NpmplusCrowdsecAppsec = existing.NpmplusCrowdsecAppsec != 0,
            NpmplusProxyResponseBuffering = existing.NpmplusProxyResponseBuffering != 0,
            NpmplusProxyRequestBuffering = existing.NpmplusProxyRequestBuffering != 0,
            NpmplusDisableUriSanitisation = existing.NpmplusDisableUriSanitisation != 0,
            NpmplusUpstreamCompression = existing.NpmplusUpstreamCompression != 0,
            NpmplusFancyindex = existing.NpmplusFancyindex != 0,
            NpmplusXFrameOptions = string.IsNullOrWhiteSpace(existing.NpmplusXFrameOptions)
                ? "SAMEORIGIN"
                : existing.NpmplusXFrameOptions,
            Meta = meta,
            Locations = existing.Locations ?? new List<ProxyLocationRequest>(),
        };

        await _npm.UpdateProxyHostAsync(hostId, request, cancellationToken);
        _logger.LogInformation(
            "Retargeted proxy host {HostId} → fallback {Host}:{Port}{Path}",
            hostId, fbHost, fbPort, path);
    }

    public async Task RestoreHostAsync(
        int hostId,
        string forwardHost,
        int forwardPort,
        string forwardScheme,
        List<ProxyLocationRequest>? locations,
        CancellationToken cancellationToken)
    {
        var existing = await _npm.GetProxyHostByIdAsync(hostId, cancellationToken)
            ?? throw new InvalidOperationException($"Proxy host {hostId} not found");

        var meta = existing.Meta != null
            ? new Dictionary<string, object>(existing.Meta)
            : new Dictionary<string, object>();

        var host = forwardHost;
        var port = forwardPort;
        var scheme = forwardScheme;
        var advanced = "";

        if (meta.TryGetValue("fallback_original_host", out var oh) && oh != null)
            host = oh.ToString() ?? host;
        if (meta.TryGetValue("fallback_original_port", out var op) && op != null &&
            int.TryParse(op.ToString(), out var parsedPort))
            port = parsedPort;
        if (meta.TryGetValue("fallback_original_scheme", out var os) && os != null)
            scheme = os.ToString() ?? scheme;
        if (meta.TryGetValue("fallback_original_advanced", out var oa) && oa != null)
            advanced = oa.ToString() ?? "";

        meta.Remove("unavailable");
        meta.Remove("unavailable_kind");
        meta.Remove("unavailable_reason");
        meta.Remove("fallback_original_host");
        meta.Remove("fallback_original_port");
        meta.Remove("fallback_original_scheme");
        meta.Remove("fallback_original_advanced");
        meta["ui_disabled"] = false;

        var accessListIds = existing.NpmplusAccessListIds ?? new List<int>();
        if (accessListIds.Count == 0 && existing.AccessListId is > 0)
            accessListIds = new List<int> { existing.AccessListId.Value };

        var request = new ProxyHostRequest
        {
            DomainNames = existing.DomainNames ?? new List<string>(),
            ForwardScheme = string.IsNullOrWhiteSpace(scheme) ? "http" : scheme,
            ForwardHost = host,
            ForwardPort = port,
            AccessListId = existing.AccessListId ?? 0,
            NpmplusAccessListIds = accessListIds,
            NpmplusAccessListType = existing.NpmplusAccessListType
                ?? (accessListIds.Count > 0 ? "custom" : "public"),
            CertificateId = existing.CertificateId ?? 0,
            SslForced = existing.SslForced != 0,
            CachingEnabled = existing.CachingEnabled != 0,
            BlockExploits = existing.BlockExploits != 0,
            AdvancedConfig = advanced,
            AllowWebsocketUpgrade = existing.AllowWebsocketUpgrade != 0,
            Http2Support = existing.Http2Support != 0,
            HstsEnabled = existing.HstsEnabled != 0,
            HstsSubdomains = existing.HstsSubdomains != 0,
            Enabled = true,
            NpmplusAuthRequest = existing.NpmplusAuthRequest ?? "none",
            NpmplusAuthRequestUpstream = existing.NpmplusAuthRequestUpstream ?? string.Empty,
            NpmplusHttp3Support = existing.NpmplusHttp3Support != 0,
            TrustForwardedProto = existing.TrustForwardedProto != 0,
            NpmplusLocationConfig = existing.NpmplusLocationConfig ?? string.Empty,
            NpmplusNoindex = existing.NpmplusNoindex != 0,
            NpmplusCrowdsecAppsec = existing.NpmplusCrowdsecAppsec != 0,
            NpmplusProxyResponseBuffering = existing.NpmplusProxyResponseBuffering != 0,
            NpmplusProxyRequestBuffering = existing.NpmplusProxyRequestBuffering != 0,
            NpmplusDisableUriSanitisation = existing.NpmplusDisableUriSanitisation != 0,
            NpmplusUpstreamCompression = existing.NpmplusUpstreamCompression != 0,
            NpmplusFancyindex = existing.NpmplusFancyindex != 0,
            NpmplusXFrameOptions = string.IsNullOrWhiteSpace(existing.NpmplusXFrameOptions)
                ? "SAMEORIGIN"
                : existing.NpmplusXFrameOptions,
            Meta = meta,
            Locations = locations ?? existing.Locations ?? new List<ProxyLocationRequest>(),
        };

        await _npm.UpdateProxyHostAsync(hostId, request, cancellationToken);
        _logger.LogInformation("Restored proxy host {HostId} → {Scheme}://{Host}:{Port}", hostId, scheme, host, port);
    }

    public static bool IsMarkedUnavailable(ProxyHost host)
    {
        if (host.Meta == null) return false;
        if (!host.Meta.TryGetValue("unavailable", out var v) || v == null) return false;
        var text = v.ToString()?.ToLowerInvariant();
        return text is "true" or "1" or "yes" or "on";
    }
}
