using System.Security.Cryptography;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class TunnelService
{
    private readonly SettingsStore _settings;
    private readonly NginxProxyManagerClient _npm;
    private readonly CertificateService _certificates;
    private readonly ILogger<TunnelService> _logger;

    public TunnelService(
        SettingsStore settings,
        NginxProxyManagerClient npm,
        CertificateService certificates,
        ILogger<TunnelService> logger)
    {
        _settings = settings;
        _npm = npm;
        _certificates = certificates;
        _logger = logger;
    }

    public bool IsEnabled() =>
        !string.IsNullOrWhiteSpace(_settings.Get("TUNNEL_BASE_DOMAIN"));

    public async Task<TunnelRecord> CreateAsync(
        int port,
        string? scheme,
        string? host,
        int? ttlMinutes,
        string? label,
        string? createdBy,
        CancellationToken cancellationToken)
    {
        var baseDomain = _settings.Get("TUNNEL_BASE_DOMAIN")?.Trim().TrimStart('.');
        if (string.IsNullOrWhiteSpace(baseDomain))
            throw new InvalidOperationException("TUNNEL_BASE_DOMAIN is not configured");

        var forwardHost = host
            ?? _settings.Get("TUNNEL_FORWARD_HOST")
            ?? _settings.Get("DOCKER_HOST_IP");
        if (string.IsNullOrWhiteSpace(forwardHost))
            throw new InvalidOperationException("TUNNEL_FORWARD_HOST (or host override) is required");

        var ttl = ttlMinutes ?? _settings.GetInt("TUNNEL_DEFAULT_TTL_MINUTES", 120);
        if (ttl < 5) ttl = 5;
        if (ttl > 60 * 24 * 7) ttl = 60 * 24 * 7;

        var slug = GenerateSlug();
        var domain = $"{slug}.{baseDomain}";
        var forwardScheme = string.IsNullOrWhiteSpace(scheme) ? "http" : scheme.Trim().ToLowerInvariant();

        var certId = 0;
        try
        {
            var match = await _certificates.FindMatchingCertificateAsync(new List<string> { domain }, cancellationToken);
            if (match.HasValue)
                certId = match.Value;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Certificate lookup failed for tunnel domain {Domain}", domain);
        }

        var authRequest = "none";
        var authUpstream = "";
        if (_settings.GetBool("TUNNEL_REQUIRE_AUTH"))
        {
            authRequest = _settings.Get("AUTH_REQUEST_DEFAULT") ?? "none";
            authUpstream = _settings.Get("AUTH_REQUEST_UPSTREAM") ?? "";
        }

        var request = new ProxyHostRequest
        {
            DomainNames = new List<string> { domain },
            ForwardScheme = forwardScheme,
            ForwardHost = forwardHost,
            ForwardPort = port,
            CertificateId = certId,
            SslForced = certId > 0,
            AllowWebsocketUpgrade = true,
            BlockExploits = true,
            Enabled = true,
            NpmplusAuthRequest = string.IsNullOrWhiteSpace(authRequest) ? "none" : authRequest,
            NpmplusAuthRequestUpstream = authUpstream,
            Meta = new Dictionary<string, object>
            {
                ["managed_by"] = "npm-docker-sync",
                ["tunnel"] = true,
                ["created_at"] = DateTime.UtcNow.ToString("o"),
            },
        };

        var hostCreated = await _npm.CreateProxyHostAsync(request, cancellationToken);

        var tunnel = new TunnelRecord
        {
            Id = Guid.NewGuid().ToString("n"),
            Slug = slug,
            Domain = domain,
            ForwardHost = forwardHost,
            ForwardPort = port,
            ForwardScheme = forwardScheme,
            NpmHostId = hostCreated.Id,
            ExpiresAt = DateTime.UtcNow.AddMinutes(ttl),
            CreatedBy = createdBy,
            Label = label,
            CreatedAt = DateTime.UtcNow,
        };

        _settings.InsertTunnel(tunnel);
        _logger.LogInformation("Created tunnel {Domain} -> {Host}:{Port} expires {Expires}",
            domain, forwardHost, port, tunnel.ExpiresAt);
        return tunnel;
    }

    public List<TunnelRecord> List() => _settings.ListTunnels();

    public async Task DeleteAsync(string id, CancellationToken cancellationToken)
    {
        var tunnel = _settings.GetTunnel(id)
            ?? throw new InvalidOperationException("Tunnel not found");

        if (tunnel.NpmHostId.HasValue)
        {
            try
            {
                await _npm.DeleteProxyHostAsync(tunnel.NpmHostId.Value, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to delete NPM host {HostId} for tunnel {Id}", tunnel.NpmHostId, id);
            }
        }

        _settings.DeleteTunnel(id);
    }

    public TunnelRecord Extend(string id, int? ttlMinutes)
    {
        var tunnel = _settings.GetTunnel(id)
            ?? throw new InvalidOperationException("Tunnel not found");

        var ttl = ttlMinutes ?? _settings.GetInt("TUNNEL_DEFAULT_TTL_MINUTES", 120);
        tunnel.ExpiresAt = DateTime.UtcNow.AddMinutes(Math.Clamp(ttl, 5, 60 * 24 * 7));
        _settings.UpdateTunnel(tunnel);
        return tunnel;
    }

    public async Task CleanupExpiredAsync(CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        foreach (var tunnel in _settings.ListTunnels())
        {
            if (tunnel.ExpiresAt > now)
                continue;

            _logger.LogInformation("Expiring tunnel {Domain}", tunnel.Domain);
            try
            {
                await DeleteAsync(tunnel.Id, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to expire tunnel {Id}", tunnel.Id);
            }
        }
    }

    private static string GenerateSlug()
    {
        Span<byte> bytes = stackalloc byte[6];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

public class TunnelCleanupService : BackgroundService
{
    private readonly TunnelService _tunnels;
    private readonly ILogger<TunnelCleanupService> _logger;

    public TunnelCleanupService(TunnelService tunnels, ILogger<TunnelCleanupService> logger)
    {
        _tunnels = tunnels;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await _tunnels.CleanupExpiredAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Tunnel cleanup failed");
            }

            await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken);
        }
    }
}
