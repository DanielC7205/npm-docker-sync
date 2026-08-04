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

        var forwardHost = (host
            ?? _settings.Get("TUNNEL_FORWARD_HOST")
            ?? _settings.Get("DOCKER_HOST_IP")
            ?? "host.docker.internal")?.Trim();

        if (string.IsNullOrWhiteSpace(forwardHost))
        {
            throw new InvalidOperationException(
                "TUNNEL_FORWARD_HOST is required. The VS Code extension should send your machine IP automatically; " +
                "or set Forward host under Settings → Dev tunnels.");
        }

        var ttl = ttlMinutes ?? _settings.GetInt("TUNNEL_DEFAULT_TTL_MINUTES", 120);
        if (ttl < 5) ttl = 5;
        if (ttl > 60 * 24 * 7) ttl = 60 * 24 * 7;

        var slug = BuildSlug(label);
        var domain = $"{slug}.{baseDomain}";
        var forwardScheme = string.IsNullOrWhiteSpace(scheme) ? "http" : scheme.Trim().ToLowerInvariant();

        var certId = await ResolveTunnelCertificateIdAsync(domain, baseDomain, cancellationToken);
        if (!certId.HasValue || certId.Value <= 0)
        {
            throw new InvalidOperationException(
                "No TLS certificate for tunnels. Set TUNNEL_CERTIFICATE_ID (Settings → TLS), " +
                $"add CERT_DOMAIN_MAP for *.{baseDomain}, or ensure NPMplus has a matching wildcard cert " +
                $"(e.g. *.{baseDomain} or *.parent.domain). Without a cert, HTTPS tunnels fail with SSL_VERSION_OR_CIPHER_MISMATCH.");
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
            CertificateId = certId.Value,
            SslForced = true,
            Http2Support = true,
            HstsEnabled = true,
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
        _logger.LogInformation("Created tunnel {Domain} -> {Host}:{Port} cert={CertId} expires {Expires}",
            domain, forwardHost, port, certId.Value, tunnel.ExpiresAt);
        return tunnel;
    }

    private async Task<int?> ResolveTunnelCertificateIdAsync(
        string domain,
        string baseDomain,
        CancellationToken cancellationToken)
    {
        var explicitId = _settings.Get("TUNNEL_CERTIFICATE_ID");
        if (int.TryParse(explicitId, out var configured) && configured > 0)
        {
            _logger.LogInformation("Using TUNNEL_CERTIFICATE_ID {CertId} for tunnel {Domain}", configured, domain);
            return configured;
        }

        // Prefer map / match for the full hostname, then wildcard of the tunnel base, then base itself
        var candidates = new List<string> { domain, $"*.{baseDomain}", baseDomain };
        var parent = ParentDomain(baseDomain);
        if (!string.IsNullOrEmpty(parent))
        {
            candidates.Add($"*.{parent}");
            candidates.Add(parent);
        }

        var match = await _certificates.FindMatchingCertificateAsync(candidates, cancellationToken);
        if (match.HasValue && match.Value > 0)
            return match.Value;

        return null;
    }

    private static string? ParentDomain(string domain)
    {
        var parts = domain.Split('.', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 3 ? string.Join('.', parts.Skip(1)) : null;
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

        var addMinutes = ttlMinutes ?? _settings.GetInt("TUNNEL_DEFAULT_TTL_MINUTES", 120);
        addMinutes = Math.Clamp(addMinutes, 5, 60 * 24 * 7);

        var baseline = tunnel.ExpiresAt > DateTime.UtcNow ? tunnel.ExpiresAt : DateTime.UtcNow;
        var maxExpiry = DateTime.UtcNow.AddDays(7);
        tunnel.ExpiresAt = baseline.AddMinutes(addMinutes);
        if (tunnel.ExpiresAt > maxExpiry)
            tunnel.ExpiresAt = maxExpiry;

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

    private static string BuildSlug(string? label)
    {
        Span<byte> bytes = stackalloc byte[3];
        RandomNumberGenerator.Fill(bytes);
        var suffix = Convert.ToHexString(bytes).ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(label))
            return GenerateSlug();

        var baseSlug = System.Text.RegularExpressions.Regex.Replace(
            label.Trim().ToLowerInvariant(),
            @"[^a-z0-9]+",
            "-").Trim('-');
        if (baseSlug.Length > 36)
            baseSlug = baseSlug[..36].TrimEnd('-');
        if (string.IsNullOrEmpty(baseSlug))
            return GenerateSlug();

        return $"{baseSlug}-{suffix}";
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
