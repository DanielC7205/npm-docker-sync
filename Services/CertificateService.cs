using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class CertificateService
{
    private readonly ILogger<CertificateService> _logger;
    private readonly NginxProxyManagerClient _npmClient;
    private readonly SettingsStore _settings;
    private List<Certificate>? _cachedCertificates;
    private DateTime _cacheExpiry = DateTime.MinValue;
    private readonly TimeSpan _cacheLifetime = TimeSpan.FromMinutes(5);

    public CertificateService(
        ILogger<CertificateService> logger,
        NginxProxyManagerClient npmClient,
        SettingsStore settings)
    {
        _logger = logger;
        _npmClient = npmClient;
        _settings = settings;
    }

    public async Task<List<CertificateInfo>> ListCertificatesAsync(CancellationToken cancellationToken)
    {
        var certs = await GetCertificatesAsync(cancellationToken);
        return certs.Select(c => new CertificateInfo
        {
            Id = c.Id,
            NiceName = c.NiceName,
            Provider = c.Provider,
            DomainNames = c.DomainNames ?? new List<string>(),
            ExpiresOn = c.ExpiresOn,
        }).OrderBy(c => c.NiceName ?? c.Id.ToString()).ToList();
    }

    /// <summary>
    /// Resolve cert: explicit domain map → NPM name/domain match → optional default cert id.
    /// </summary>
    public async Task<int?> FindMatchingCertificateAsync(List<string> domainNames, CancellationToken cancellationToken)
    {
        if (domainNames == null || domainNames.Count == 0)
            return null;

        var mapped = ResolveFromDomainMap(domainNames);
        if (mapped.HasValue)
        {
            _logger.LogInformation("Using CERT_DOMAIN_MAP certificate {CertId} for domains: {Domains}",
                mapped.Value, string.Join(", ", domainNames));
            return mapped.Value;
        }

        var certificates = await GetCertificatesAsync(cancellationToken);

        if (certificates.Count == 0)
        {
            _logger.LogDebug("No certificates available in NPM");
            return ResolveDefaultCertificateId();
        }

        var primaryDomain = domainNames[0];

        var exactMatch = FindExactMatch(certificates, domainNames);
        if (exactMatch != null)
        {
            _logger.LogInformation("Found exact certificate match (ID: {CertId}) for domains: {Domains}",
                exactMatch.Id, string.Join(", ", domainNames));
            return exactMatch.Id;
        }

        var primaryMatch = FindPrimaryDomainMatch(certificates, primaryDomain);
        if (primaryMatch != null)
        {
            _logger.LogInformation("Found certificate (ID: {CertId}) matching primary domain: {Domain}",
                primaryMatch.Id, primaryDomain);
            return primaryMatch.Id;
        }

        var wildcardMatch = FindWildcardMatch(certificates, primaryDomain);
        if (wildcardMatch != null)
        {
            _logger.LogInformation("Found wildcard certificate (ID: {CertId}) for domain: {Domain}",
                wildcardMatch.Id, primaryDomain);
            return wildcardMatch.Id;
        }

        // Also try each additional candidate (e.g. *.tunnels.example.com, parent wildcards)
        foreach (var domain in domainNames.Skip(1))
        {
            if (string.IsNullOrWhiteSpace(domain))
                continue;

            var lookupHost = domain.StartsWith("*.", StringComparison.Ordinal)
                ? $"tunnel.{domain[2..]}"
                : domain;
            var match = FindPrimaryDomainMatch(certificates, domain)
                        ?? FindWildcardMatch(certificates, lookupHost);
            // For literal "*.foo.com" look for cert SAN that equals that pattern
            if (match == null && domain.StartsWith("*."))
            {
                match = certificates.FirstOrDefault(c =>
                    c.DomainNames != null &&
                    c.DomainNames.Any(d => d.Equals(domain, StringComparison.OrdinalIgnoreCase)));
            }

            if (match != null)
            {
                _logger.LogInformation("Found certificate (ID: {CertId}) for candidate domain: {Domain}",
                    match.Id, domain);
                return match.Id;
            }
        }

        var fallback = ResolveDefaultCertificateId();
        if (fallback.HasValue)
        {
            _logger.LogInformation("Using NPM_PROXY_DEFAULT_CERTIFICATE_ID {CertId} for domains: {Domains}",
                fallback.Value, string.Join(", ", domainNames));
            return fallback;
        }

        _logger.LogWarning("No matching certificate found for domains: {Domains}", string.Join(", ", domainNames));
        return null;
    }

    /// <summary>
    /// CERT_DOMAIN_MAP lines: pattern=id  (e.g. *.example.com=3 or app.example.com=5)
    /// Separators: newline, semicolon, or comma between entries.
    /// </summary>
    public int? ResolveFromDomainMap(IEnumerable<string> domainNames)
    {
        var map = ParseDomainMap(_settings.Get("CERT_DOMAIN_MAP"));
        if (map.Count == 0)
            return null;

        foreach (var domain in domainNames)
        {
            if (string.IsNullOrWhiteSpace(domain))
                continue;

            // Exact pattern first
            if (map.TryGetValue(domain.Trim(), out var exactId))
                return exactId;

            // Wildcard patterns in map (*.example.com)
            foreach (var (pattern, certId) in map)
            {
                if (pattern.StartsWith("*.", StringComparison.Ordinal) && MatchesWildcard(domain, pattern))
                    return certId;
            }
        }

        return null;
    }

    public static Dictionary<string, int> ParseDomainMap(string? raw)
    {
        var result = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(raw))
            return result;

        var entries = raw.Split(new[] { '\n', '\r', ';', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var entry in entries)
        {
            var sep = entry.IndexOf('=');
            if (sep < 0)
                sep = entry.IndexOf(':');
            if (sep <= 0)
                continue;

            var pattern = entry[..sep].Trim();
            var idPart = entry[(sep + 1)..].Trim();
            if (string.IsNullOrEmpty(pattern) || !int.TryParse(idPart, out var id) || id <= 0)
                continue;

            result[pattern] = id;
        }

        return result;
    }

    private int? ResolveDefaultCertificateId()
    {
        var raw = _settings.Get("NPM_PROXY_DEFAULT_CERTIFICATE_ID");
        if (int.TryParse(raw, out var id) && id > 0)
            return id;
        return null;
    }

    private async Task<List<Certificate>> GetCertificatesAsync(CancellationToken cancellationToken)
    {
        if (_cachedCertificates != null && DateTime.UtcNow < _cacheExpiry)
        {
            _logger.LogDebug("Using cached certificates list ({Count} certificates)", _cachedCertificates.Count);
            return _cachedCertificates;
        }

        _logger.LogDebug("Fetching certificates from NPM");
        _cachedCertificates = await _npmClient.GetCertificatesAsync(cancellationToken);
        _cacheExpiry = DateTime.UtcNow.Add(_cacheLifetime);

        _cachedCertificates = _cachedCertificates
            .Where(c => c.IsDeleted == 0)
            .ToList();

        _logger.LogInformation("Loaded {Count} active certificates from NPM", _cachedCertificates.Count);
        return _cachedCertificates;
    }

    private Certificate? FindExactMatch(List<Certificate> certificates, List<string> domainNames)
    {
        return certificates.FirstOrDefault(cert =>
            cert.DomainNames != null &&
            domainNames.All(domain => cert.DomainNames.Contains(domain, StringComparer.OrdinalIgnoreCase))
        );
    }

    private Certificate? FindPrimaryDomainMatch(List<Certificate> certificates, string primaryDomain)
    {
        return certificates.FirstOrDefault(cert =>
            cert.DomainNames != null &&
            cert.DomainNames.Contains(primaryDomain, StringComparer.OrdinalIgnoreCase)
        );
    }

    private Certificate? FindWildcardMatch(List<Certificate> certificates, string domain)
    {
        return certificates.FirstOrDefault(cert =>
            cert.DomainNames != null &&
            cert.DomainNames.Any(certDomain =>
                certDomain.StartsWith("*.") &&
                MatchesWildcard(domain, certDomain)
            )
        );
    }

    private bool MatchesWildcard(string domain, string wildcardPattern)
    {
        if (!wildcardPattern.StartsWith("*."))
            return false;

        var wildcardRoot = wildcardPattern[2..];
        return domain.EndsWith(wildcardRoot, StringComparison.OrdinalIgnoreCase) &&
               (domain.Length == wildcardRoot.Length || domain[domain.Length - wildcardRoot.Length - 1] == '.');
    }

    public void InvalidateCache()
    {
        _logger.LogDebug("Invalidating certificate cache");
        _cacheExpiry = DateTime.MinValue;
    }
}

public class CertificateInfo
{
    public int Id { get; set; }
    public string? NiceName { get; set; }
    public string? Provider { get; set; }
    public List<string> DomainNames { get; set; } = new();
    public string? ExpiresOn { get; set; }
}
