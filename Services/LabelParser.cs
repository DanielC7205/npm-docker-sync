using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class LabelParser
{
    private readonly ILogger<LabelParser> _logger;
    private readonly SettingsStore _settings;

    public LabelParser(ILogger<LabelParser> logger, SettingsStore settings)
    {
        _logger = logger;
        _settings = settings;
    }

    /// <summary>
    /// Parse proxy configs from GoDoxy <c>proxy.*</c> labels merged with <c>npm.*</c>/<c>npm-*</c>.
    /// npm fields override overlapping GoDoxy fields.
    /// </summary>
    public Dictionary<int, ProxyConfiguration> ParseLabels(IDictionary<string, string> labels)
    {
        if (IsGoDoxyExcluded(labels))
        {
            _logger.LogInformation("proxy.exclude is set; skipping proxy sync for these labels");
            return new Dictionary<int, ProxyConfiguration>();
        }

        var godoxyConfigs = ParseGoDoxyProxyConfigs(labels);
        var npmConfigs = ParseNpmProxyConfigs(labels);

        return MergeProxyConfigs(godoxyConfigs, npmConfigs);
    }

    public bool IsExcluded(IDictionary<string, string> labels) => IsGoDoxyExcluded(labels);

    public string? GetPreferredNetwork(IDictionary<string, string> labels)
    {
        if (labels.TryGetValue("proxy.network", out var network) && !string.IsNullOrWhiteSpace(network))
            return network.Trim();
        return null;
    }

    private bool IsGoDoxyExcluded(IDictionary<string, string> labels)
    {
        if (!labels.TryGetValue("proxy.exclude", out var value) || string.IsNullOrWhiteSpace(value))
            return false;
        return value.ToLowerInvariant() is "true" or "1" or "yes" or "on";
    }

    private Dictionary<int, ProxyConfiguration> ParseNpmProxyConfigs(IDictionary<string, string> labels)
    {
        var configs = new Dictionary<int, ProxyConfiguration>();
        var indices = GetNpmProxyIndices(labels);

        foreach (var index in indices)
        {
            var config = ParseNpmProxyConfig(labels, index);
            if (config != null)
                configs[index] = config;
        }

        return configs;
    }

    private HashSet<int> GetNpmProxyIndices(IDictionary<string, string> labels)
    {
        var indices = new HashSet<int>();

        foreach (var key in labels.Keys)
        {
            if (key.StartsWith("npm.proxy.") || key.StartsWith("npm-proxy."))
            {
                var parts = key.Split('.');
                if (parts.Length >= 3 && int.TryParse(parts[2], out var index) && index >= 0 && index < 100)
                    indices.Add(index);
            }
        }

        if (GetLabelValue(labels, "proxy.domains", null) != null ||
            GetLabelValue(labels, "proxy.domain", null) != null)
        {
            indices.Add(0);
        }

        return indices;
    }

    private ProxyConfiguration? ParseNpmProxyConfig(IDictionary<string, string> labels, int index)
    {
        var prefix = index > 0 ? $"{index}." : "";

        var domainNames = GetProxyLabelValue(labels, "proxy", prefix, "domains", index);
        if (string.IsNullOrEmpty(domainNames))
        {
            domainNames = GetProxyLabelValue(labels, "proxy", prefix, "domain", index);
            if (string.IsNullOrEmpty(domainNames))
            {
                _logger.LogDebug("No proxy.domains label found for index {Index}", index);
                return null;
            }
        }

        var forwardHost = GetProxyLabelValue(labels, "proxy", prefix, "host", index);
        var forwardPortStr = GetProxyLabelValue(labels, "proxy", prefix, "port", index);

        int? forwardPort = null;
        if (!string.IsNullOrEmpty(forwardPortStr))
        {
            if (!TryParsePort(forwardPortStr, out var parsedPort))
            {
                _logger.LogWarning("Invalid npm.proxy.{Prefix}port value: {Port}", prefix, forwardPortStr);
                return null;
            }
            forwardPort = parsedPort;
        }

        var websocketsExplicit = GetProxyLabelValue(labels, "proxy", prefix, "websockets", index) != null;

        var config = new ProxyConfiguration
        {
            Index = index,
            DomainNames = SplitCsv(domainNames).Select(ExpandDomainAlias).ToList(),
            ForwardHost = forwardHost?.Trim() ?? string.Empty,
            ForwardPort = forwardPort,
            ForwardScheme = GetProxyLabelValue(labels, "proxy", prefix, "scheme", index) ?? "http",
            SslForced = GetProxyBoolLabel(labels, "proxy", prefix, "ssl.force", index, GetConfigBool("NPM_PROXY_SSL_FORCE", false)),
            CachingEnabled = GetProxyBoolLabel(labels, "proxy", prefix, "caching", index, GetConfigBool("NPM_PROXY_CACHING", false)),
            BlockExploits = GetProxyBoolLabel(labels, "proxy", prefix, "block_common_exploits", index, GetConfigBool("NPM_PROXY_BLOCK_EXPLOITS", true)),
            AllowWebsocketUpgrade = GetProxyBoolLabel(labels, "proxy", prefix, "websockets", index, GetConfigBool("NPM_PROXY_WEBSOCKETS", false)),
            Http2Support = GetProxyBoolLabel(labels, "proxy", prefix, "ssl.http2", index, GetConfigBool("NPM_PROXY_HTTP2", false)),
            HstsEnabled = GetProxyBoolLabel(labels, "proxy", prefix, "ssl.hsts", index, GetConfigBool("NPM_PROXY_HSTS", false)),
            HstsSubdomains = GetProxyBoolLabel(labels, "proxy", prefix, "ssl.hsts.subdomains", index, GetConfigBool("NPM_PROXY_HSTS_SUBDOMAINS", false)),
            AdvancedConfig = GetProxyLabelValue(labels, "proxy", prefix, "advanced.config", index) ?? string.Empty,
            PreferredNetwork = GetPreferredNetwork(labels),
            LabelSource = ProxyLabelSource.Npm,
            WebsocketsExplicitlySet = websocketsExplicit,
        };

        var certIdStr = GetProxyLabelValue(labels, "proxy", prefix, "ssl.certificate.id", index);
        if (!string.IsNullOrEmpty(certIdStr) && int.TryParse(certIdStr, out var certId))
            config.CertificateId = certId;

        var accessListIdStr = GetProxyLabelValue(labels, "proxy", prefix, "accesslist.id", index);
        if (!string.IsNullOrEmpty(accessListIdStr) && int.TryParse(accessListIdStr, out var accessListId))
            config.AccessListId = accessListId;

        return config;
    }

    private Dictionary<int, ProxyConfiguration> ParseGoDoxyProxyConfigs(IDictionary<string, string> labels)
    {
        if (!HasGoDoxyProxyLabels(labels))
            return new Dictionary<int, ProxyConfiguration>();

        var aliases = GetGoDoxyAliases(labels);
        if (aliases.Count == 0)
        {
            _logger.LogDebug("GoDoxy proxy labels present but no aliases found");
            return new Dictionary<int, ProxyConfiguration>();
        }

        var shortcutPorts = SplitCsv(GetGoDoxyLabel(labels, "proxy.ports"));
        var shortcutHosts = SplitCsv(GetGoDoxyLabel(labels, "proxy.hosts"));
        var shortcutSchemes = SplitCsv(
            GetGoDoxyLabel(labels, "proxy.schemes")
            ?? GetGoDoxyLabel(labels, "proxy.protocols")
            ?? GetGoDoxyLabel(labels, "proxy.protos"));

        // Build one candidate per alias (1-based GoDoxy index), then group by host/port/scheme
        var candidates = new List<ProxyConfiguration>();
        for (var i = 0; i < aliases.Count; i++)
        {
            var godoxyIndex = i + 1; // 1-based
            var internalIndex = i;   // 0-based provisional

            var scheme = GetGoDoxyIndexedOrShortcut(labels, godoxyIndex, "scheme", shortcutSchemes, i) ?? "http";
            if (!IsHttpScheme(scheme))
            {
                _logger.LogDebug("Skipping GoDoxy alias {Alias} with non-HTTP scheme {Scheme}", aliases[i], scheme);
                continue;
            }

            var portRaw = GetGoDoxyIndexedOrShortcut(labels, godoxyIndex, "port", shortcutPorts, i);
            int? port = null;
            if (!string.IsNullOrEmpty(portRaw))
            {
                if (!TryParsePort(portRaw, out var parsedPort))
                {
                    _logger.LogWarning("Invalid GoDoxy proxy port for alias {Alias}: {Port}", aliases[i], portRaw);
                    continue;
                }
                port = parsedPort;
            }

            var host = GetGoDoxyIndexedOrShortcut(labels, godoxyIndex, "host", shortcutHosts, i)?.Trim() ?? string.Empty;
            var homepage = ParseHomepage(GetGoDoxyIndexedField(labels, godoxyIndex, "homepage"));
            var showHomepage = GetGoDoxyBool(labels, godoxyIndex, "homepage.show", true);
            if (!showHomepage && homepage != null)
                homepage.Show = false;
            else if (!showHomepage)
                homepage = new HomepageInfo { Show = false };

            candidates.Add(new ProxyConfiguration
            {
                Index = internalIndex,
                DomainNames = new List<string> { ExpandDomainAlias(aliases[i]) },
                ForwardHost = host,
                ForwardPort = port,
                ForwardScheme = scheme.ToLowerInvariant(),
                SslForced = GetConfigBool("NPM_PROXY_SSL_FORCE", false),
                CachingEnabled = GetConfigBool("NPM_PROXY_CACHING", false),
                BlockExploits = GetConfigBool("NPM_PROXY_BLOCK_EXPLOITS", true),
                // GoDoxy handles websockets automatically — default on unless env says otherwise was set;
                // prefer true for GoDoxy-originated routes when env default is false.
                AllowWebsocketUpgrade = true,
                Http2Support = GetConfigBool("NPM_PROXY_HTTP2", false),
                HstsEnabled = GetConfigBool("NPM_PROXY_HSTS", false),
                HstsSubdomains = GetConfigBool("NPM_PROXY_HSTS_SUBDOMAINS", false),
                PreferredNetwork = GetPreferredNetwork(labels),
                Homepage = homepage,
                LabelSource = ProxyLabelSource.GoDoxy,
                WebsocketsExplicitlySet = false,
            });
        }

        return GroupGoDoxyCandidates(candidates);
    }

    private Dictionary<int, ProxyConfiguration> GroupGoDoxyCandidates(List<ProxyConfiguration> candidates)
    {
        var groups = new List<ProxyConfiguration>();

        foreach (var candidate in candidates)
        {
            var existing = groups.FirstOrDefault(g =>
                string.Equals(g.ForwardHost, candidate.ForwardHost, StringComparison.OrdinalIgnoreCase) &&
                g.ForwardPort == candidate.ForwardPort &&
                string.Equals(g.ForwardScheme, candidate.ForwardScheme, StringComparison.OrdinalIgnoreCase));

            if (existing != null)
            {
                existing.DomainNames.AddRange(candidate.DomainNames);
                // Keep first homepage that is shown
                if ((existing.Homepage == null || existing.Homepage.Show == false) &&
                    candidate.Homepage != null && candidate.Homepage.Show != false)
                {
                    existing.Homepage = candidate.Homepage;
                }
            }
            else
            {
                groups.Add(candidate);
            }
        }

        var result = new Dictionary<int, ProxyConfiguration>();
        for (var i = 0; i < groups.Count; i++)
        {
            groups[i].Index = i;
            result[i] = groups[i];
        }

        return result;
    }

    private Dictionary<int, ProxyConfiguration> MergeProxyConfigs(
        Dictionary<int, ProxyConfiguration> godoxy,
        Dictionary<int, ProxyConfiguration> npm)
    {
        var indices = godoxy.Keys.Union(npm.Keys).OrderBy(i => i);
        var merged = new Dictionary<int, ProxyConfiguration>();

        foreach (var index in indices)
        {
            godoxy.TryGetValue(index, out var g);
            npm.TryGetValue(index, out var n);

            if (g == null && n != null)
            {
                merged[index] = n;
                continue;
            }

            if (g != null && n == null)
            {
                merged[index] = g;
                continue;
            }

            // Both present: start from GoDoxy, overlay npm non-empty / explicit fields
            var result = CloneConfig(g!);
            result.LabelSource = ProxyLabelSource.Merged;

            if (n!.DomainNames.Count > 0)
                result.DomainNames = new List<string>(n.DomainNames);

            if (!string.IsNullOrEmpty(n.ForwardHost))
                result.ForwardHost = n.ForwardHost;

            if (n.ForwardPort.HasValue)
                result.ForwardPort = n.ForwardPort;

            if (!string.IsNullOrEmpty(n.ForwardScheme))
                result.ForwardScheme = n.ForwardScheme;

            // npm always carries SSL/feature flags (from labels or env); prefer npm when present
            result.SslForced = n.SslForced;
            result.CachingEnabled = n.CachingEnabled;
            result.BlockExploits = n.BlockExploits;
            result.Http2Support = n.Http2Support;
            result.HstsEnabled = n.HstsEnabled;
            result.HstsSubdomains = n.HstsSubdomains;

            if (n.WebsocketsExplicitlySet)
            {
                result.AllowWebsocketUpgrade = n.AllowWebsocketUpgrade;
                result.WebsocketsExplicitlySet = true;
            }
            // else keep GoDoxy websockets=true default

            if (!string.IsNullOrEmpty(n.AdvancedConfig))
                result.AdvancedConfig = n.AdvancedConfig;

            if (n.CertificateId.HasValue)
                result.CertificateId = n.CertificateId;

            if (n.AccessListId.HasValue)
                result.AccessListId = n.AccessListId;

            if (!string.IsNullOrEmpty(n.PreferredNetwork))
                result.PreferredNetwork = n.PreferredNetwork;

            // Prefer GoDoxy homepage for UI when present
            result.Homepage ??= n.Homepage;

            merged[index] = result;
        }

        return merged;
    }

    private static ProxyConfiguration CloneConfig(ProxyConfiguration source) => new()
    {
        Index = source.Index,
        DomainNames = new List<string>(source.DomainNames),
        ForwardScheme = source.ForwardScheme,
        ForwardHost = source.ForwardHost,
        ForwardPort = source.ForwardPort,
        AccessListId = source.AccessListId,
        CertificateId = source.CertificateId,
        SslForced = source.SslForced,
        CachingEnabled = source.CachingEnabled,
        BlockExploits = source.BlockExploits,
        AdvancedConfig = source.AdvancedConfig,
        AllowWebsocketUpgrade = source.AllowWebsocketUpgrade,
        Http2Support = source.Http2Support,
        HstsEnabled = source.HstsEnabled,
        HstsSubdomains = source.HstsSubdomains,
        PreferredNetwork = source.PreferredNetwork,
        Homepage = source.Homepage == null ? null : new HomepageInfo
        {
            Name = source.Homepage.Name,
            Icon = source.Homepage.Icon,
            Description = source.Homepage.Description,
            Category = source.Homepage.Category,
            Show = source.Homepage.Show,
        },
        LabelSource = source.LabelSource,
        WebsocketsExplicitlySet = source.WebsocketsExplicitlySet,
    };

    private static bool HasGoDoxyProxyLabels(IDictionary<string, string> labels) =>
        labels.Keys.Any(k =>
            k.Equals("proxy.aliases", StringComparison.OrdinalIgnoreCase) ||
            k.Equals("proxy.ports", StringComparison.OrdinalIgnoreCase) ||
            k.Equals("proxy.hosts", StringComparison.OrdinalIgnoreCase) ||
            k.Equals("proxy.schemes", StringComparison.OrdinalIgnoreCase) ||
            k.Equals("proxy.protocols", StringComparison.OrdinalIgnoreCase) ||
            k.Equals("proxy.protos", StringComparison.OrdinalIgnoreCase) ||
            k.Equals("proxy.network", StringComparison.OrdinalIgnoreCase) ||
            k.Equals("proxy.exclude", StringComparison.OrdinalIgnoreCase) ||
            k.StartsWith("proxy.#", StringComparison.OrdinalIgnoreCase));

    private static List<string> GetGoDoxyAliases(IDictionary<string, string> labels)
    {
        var aliasesRaw = GetGoDoxyLabel(labels, "proxy.aliases");
        return string.IsNullOrWhiteSpace(aliasesRaw) ? new List<string>() : SplitCsv(aliasesRaw);
    }

    private string? GetGoDoxyIndexedOrShortcut(
        IDictionary<string, string> labels,
        int godoxyIndex,
        string field,
        List<string> shortcuts,
        int zeroBasedIndex)
    {
        var explicitValue = GetGoDoxyIndexedField(labels, godoxyIndex, field);
        var shortcutValue = zeroBasedIndex < shortcuts.Count ? shortcuts[zeroBasedIndex] : null;

        if (!string.IsNullOrEmpty(explicitValue) && !string.IsNullOrEmpty(shortcutValue) &&
            !string.Equals(explicitValue, shortcutValue, StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogWarning(
                "GoDoxy proxy.#{Index}.{Field} conflicts with shortcut; using explicit value {Explicit}",
                godoxyIndex, field, explicitValue);
        }

        if (!string.IsNullOrEmpty(explicitValue))
            return explicitValue;

        return string.IsNullOrEmpty(shortcutValue) ? null : shortcutValue;
    }

    private static string? GetGoDoxyIndexedField(IDictionary<string, string> labels, int godoxyIndex, string field)
    {
        var key = $"proxy.#{godoxyIndex}.{field}";
        return labels.TryGetValue(key, out var value) ? value : null;
    }

    private static bool GetGoDoxyBool(IDictionary<string, string> labels, int godoxyIndex, string field, bool defaultValue)
    {
        var value = GetGoDoxyIndexedField(labels, godoxyIndex, field);
        if (string.IsNullOrEmpty(value))
            return defaultValue;
        return value.ToLowerInvariant() is "true" or "1" or "yes" or "on";
    }

    private static string? GetGoDoxyLabel(IDictionary<string, string> labels, string key) =>
        labels.TryGetValue(key, out var value) ? value : null;

    private static HomepageInfo? ParseHomepage(string? yaml)
    {
        if (string.IsNullOrWhiteSpace(yaml))
            return null;

        var info = new HomepageInfo { Show = true };
        foreach (var rawLine in yaml.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var line = rawLine.Trim();
            if (line.StartsWith('#') || !line.Contains(':'))
                continue;

            var colon = line.IndexOf(':');
            var key = line[..colon].Trim().ToLowerInvariant();
            var value = line[(colon + 1)..].Trim().Trim('"', '\'');

            switch (key)
            {
                case "name":
                    info.Name = value;
                    break;
                case "icon":
                    info.Icon = value;
                    break;
                case "description":
                    info.Description = value;
                    break;
                case "category":
                    info.Category = value;
                    break;
                case "show":
                    info.Show = value.ToLowerInvariant() is "true" or "1" or "yes" or "on";
                    break;
            }
        }

        return info;
    }

    private static bool IsHttpScheme(string scheme) =>
        scheme.Equals("http", StringComparison.OrdinalIgnoreCase) ||
        scheme.Equals("https", StringComparison.OrdinalIgnoreCase);

    private static bool TryParsePort(string raw, out int port)
    {
        // Support GoDoxy listen:proxy format — use proxy (right-hand) side
        var value = raw.Contains(':') ? raw.Split(':').Last() : raw;
        return int.TryParse(value.Trim(), out port);
    }

    private static List<string> SplitCsv(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return new List<string>();

        return value.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(s => s.Trim())
            .Where(s => s.Length > 0)
            .ToList();
    }

    private string? GetLabelValue(IDictionary<string, string> labels, string key, int? index)
    {
        if (labels.TryGetValue($"npm.{key}", out var value))
            return value;

        if (labels.TryGetValue($"npm-{key}", out value))
            return value;

        return null;
    }

    private bool GetConfigBool(string key, bool defaultValue)
    {
        return _settings.GetBool(key, defaultValue);
    }

    /// <summary>
    /// Short aliases without a dot become {alias}.{PROXY_BASE_DOMAIN} when configured
    /// (GoDoxy-style: proxy.aliases=home → home.example.com).
    /// </summary>
    private string ExpandDomainAlias(string alias)
    {
        var trimmed = alias.Trim();
        if (string.IsNullOrEmpty(trimmed) || trimmed.Contains('.'))
            return trimmed;

        var baseDomain = _settings.Get("PROXY_BASE_DOMAIN")?.Trim().TrimStart('.');
        if (string.IsNullOrWhiteSpace(baseDomain))
            return trimmed;

        return $"{trimmed}.{baseDomain}";
    }

    private string? GetProxyLabelValue(IDictionary<string, string> labels, string type, string prefix, string suffix, int index)
    {
        if (index == 0)
        {
            var explicitValue = GetLabelValue(labels, $"{type}.0.{suffix}", index);
            if (!string.IsNullOrEmpty(explicitValue))
                return explicitValue;
        }

        return GetLabelValue(labels, $"{type}.{prefix}{suffix}", index);
    }

    private bool GetProxyBoolLabel(IDictionary<string, string> labels, string type, string prefix, string suffix, int index, bool defaultValue)
    {
        var value = GetProxyLabelValue(labels, type, prefix, suffix, index);
        if (string.IsNullOrEmpty(value))
            return defaultValue;
        return value.ToLowerInvariant() is "true" or "1" or "yes" or "on";
    }

    public Dictionary<int, StreamConfiguration> ParseStreamLabels(IDictionary<string, string> labels)
    {
        var configs = new Dictionary<int, StreamConfiguration>();
        var indices = GetStreamIndices(labels);

        foreach (var index in indices)
        {
            var config = ParseStreamConfig(labels, index);
            if (config != null)
                configs[index] = config;
        }

        return configs;
    }

    private HashSet<int> GetStreamIndices(IDictionary<string, string> labels)
    {
        var indices = new HashSet<int>();

        foreach (var key in labels.Keys)
        {
            if (key.StartsWith("npm.stream.") || key.StartsWith("npm-stream."))
            {
                var parts = key.Split('.');
                if (parts.Length >= 3 && int.TryParse(parts[2], out var index) && index >= 0 && index < 100)
                    indices.Add(index);
            }
        }

        if (GetLabelValue(labels, "stream.incoming.port", null) != null)
            indices.Add(0);

        return indices;
    }

    private StreamConfiguration? ParseStreamConfig(IDictionary<string, string> labels, int index)
    {
        var prefix = index > 0 ? $"{index}." : "";

        var incomingPortStr = GetProxyLabelValue(labels, "stream", prefix, "incoming.port", index);
        if (string.IsNullOrEmpty(incomingPortStr) || !int.TryParse(incomingPortStr, out var incomingPort))
        {
            _logger.LogDebug("No valid npm.stream.incoming.port found for index {Index}", index);
            return null;
        }

        int? forwardPort = null;
        var forwardPortStr = GetProxyLabelValue(labels, "stream", prefix, "forward.port", index);
        if (!string.IsNullOrEmpty(forwardPortStr) && int.TryParse(forwardPortStr, out var parsedPort))
            forwardPort = parsedPort;

        var forwardHost = GetProxyLabelValue(labels, "stream", prefix, "forward.host", index);
        var sslValue = GetProxyLabelValue(labels, "stream", prefix, "ssl", index);

        return new StreamConfiguration
        {
            Index = index,
            IncomingPort = incomingPort,
            ForwardHost = forwardHost?.Trim() ?? string.Empty,
            ForwardPort = forwardPort,
            TcpForwarding = GetProxyBoolLabel(labels, "stream", prefix, "forward.tcp", index, true),
            UdpForwarding = GetProxyBoolLabel(labels, "stream", prefix, "forward.udp", index, false),
            SslCertificate = sslValue?.Trim()
        };
    }

    public ProxyHostRequest ToProxyHostRequest(
        ProxyConfiguration config,
        string containerId,
        string syncInstanceId,
        string npmUrl,
        bool uiDisabled = false)
    {
        var meta = new Dictionary<string, object>
        {
            ["managed_by"] = "npm-docker-sync",
            ["sync_instance_id"] = syncInstanceId,
            ["npm_url"] = npmUrl,
            ["container_id"] = containerId,
            ["proxy_index"] = config.Index,
            ["created_at"] = DateTime.UtcNow.ToString("o"),
            ["ui_disabled"] = uiDisabled,
        };

        return new ProxyHostRequest
        {
            DomainNames = config.DomainNames,
            ForwardScheme = config.ForwardScheme,
            ForwardHost = config.ForwardHost,
            ForwardPort = config.ForwardPort ?? 0,
            AccessListId = config.AccessListId ?? 0,
            NpmplusAccessListIds = config.AccessListId is > 0
                ? new List<int> { config.AccessListId.Value }
                : new List<int>(),
            NpmplusAccessListType = config.AccessListId is > 0 ? "custom" : "public",
            CertificateId = config.CertificateId ?? 0,
            SslForced = config.SslForced,
            CachingEnabled = config.CachingEnabled,
            BlockExploits = config.BlockExploits,
            AllowWebsocketUpgrade = config.AllowWebsocketUpgrade,
            Http2Support = config.Http2Support,
            HstsEnabled = config.HstsEnabled,
            HstsSubdomains = config.HstsSubdomains,
            AdvancedConfig = config.AdvancedConfig,
            Enabled = !uiDisabled,
            NpmplusAuthRequest = string.IsNullOrWhiteSpace(config.AuthRequest) ? "none" : config.AuthRequest,
            NpmplusAuthRequestUpstream = config.AuthRequestUpstream ?? string.Empty,
            NpmplusHttp3Support = false,
            TrustForwardedProto = false,
            NpmplusLocationConfig = string.Empty,
            NpmplusNoindex = false,
            NpmplusCrowdsecAppsec = false,
            NpmplusProxyResponseBuffering = false,
            NpmplusProxyRequestBuffering = false,
            NpmplusDisableUriSanitisation = false,
            NpmplusUpstreamCompression = false,
            NpmplusFancyindex = false,
            NpmplusXFrameOptions = "SAMEORIGIN",
            Meta = meta,
            Locations = ToProxyLocationRequests(config.Locations),
        };
    }

    public static List<ProxyLocationRequest> ToProxyLocationRequests(List<CustomLocation>? locations)
    {
        if (locations == null || locations.Count == 0)
            return new List<ProxyLocationRequest>();

        return locations.Select(loc => ProxyLocationRequest.Create(
            loc.Path,
            loc.ForwardScheme ?? "http",
            loc.ForwardHost ?? string.Empty,
            loc.ForwardPort ?? 0,
            loc.ForwardPath)).ToList();
    }

    public StreamRequest ToStreamRequest(StreamConfiguration config, string containerId, string syncInstanceId, string npmUrl)
    {
        return new StreamRequest
        {
            IncomingPort = config.IncomingPort,
            ForwardingHost = config.ForwardHost,
            ForwardingPort = config.ForwardPort ?? 0,
            TcpForwarding = config.TcpForwarding ? 1 : 0,
            UdpForwarding = config.UdpForwarding ? 1 : 0,
            CertificateId = config.CertificateId ?? 0,
            Meta = new Dictionary<string, object>
            {
                ["managed_by"] = "npm-docker-sync",
                ["sync_instance_id"] = syncInstanceId,
                ["npm_url"] = npmUrl,
                ["container_id"] = containerId,
                ["stream_index"] = config.Index,
                ["created_at"] = DateTime.UtcNow.ToString("o")
            }
        };
    }
}

public enum ProxyLabelSource
{
    Npm,
    GoDoxy,
    Merged,
}

public class HomepageInfo
{
    public string? Name { get; set; }
    public string? Icon { get; set; }
    public string? Description { get; set; }
    public string? Category { get; set; }
    public bool Show { get; set; } = true;
}

public class ProxyConfiguration
{
    public int Index { get; set; } = 0;
    public List<string> DomainNames { get; set; } = new();
    public string ForwardScheme { get; set; } = "http";
    public string ForwardHost { get; set; } = string.Empty;
    public int? ForwardPort { get; set; }
    public int? AccessListId { get; set; }
    public int? CertificateId { get; set; }
    public bool SslForced { get; set; }
    public bool CachingEnabled { get; set; }
    public bool BlockExploits { get; set; } = true;
    public string AdvancedConfig { get; set; } = string.Empty;
    public bool AllowWebsocketUpgrade { get; set; }
    public bool Http2Support { get; set; }
    public bool HstsEnabled { get; set; }
    public bool HstsSubdomains { get; set; }
    public string? PreferredNetwork { get; set; }
    public HomepageInfo? Homepage { get; set; }
    public ProxyLabelSource LabelSource { get; set; } = ProxyLabelSource.Npm;
    public bool WebsocketsExplicitlySet { get; set; }
    public string? AuthRequest { get; set; }
    public string? AuthRequestUpstream { get; set; }
    /// <summary>Null = do not send / preserve on update; empty = clear; list = set.</summary>
    public List<CustomLocation>? Locations { get; set; }
}

public class StreamConfiguration
{
    public int Index { get; set; } = 0;
    public int IncomingPort { get; set; }
    public string ForwardHost { get; set; } = string.Empty;
    public int? ForwardPort { get; set; }
    public bool TcpForwarding { get; set; } = true;
    public bool UdpForwarding { get; set; } = false;
    public string? SslCertificate { get; set; }
    public int? CertificateId { get; set; }
}
