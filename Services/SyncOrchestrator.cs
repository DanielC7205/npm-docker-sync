using System.Collections.Concurrent;
using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class SyncOrchestrator
{
    private readonly ILogger<SyncOrchestrator> _logger;
    private readonly NginxProxyManagerClient _npmClient;
    private readonly LabelParser _labelParser;
    private readonly DockerNetworkService _networkService;
    private readonly CertificateService _certificateService;
    private readonly InstanceIdentifier _instanceIdentifier;
    private readonly DockerClient _dockerClient;
    private readonly SettingsStore _settings;
    private readonly IconResolver _iconResolver;
    private readonly KomodoClient _komodoClient;
    private readonly NpmMirrorSyncService? _mirrorSyncService;
    private readonly DateTime _startedAt = DateTime.UtcNow;
    private string? _instanceId;

    private string NpmUrl => UrlNormalizer.Normalize(
        _settings.Get("NPM_URL")
        ?? throw new ArgumentException("NPM_URL is required"));

    private bool AdoptExisting => _settings.GetBool("NPM_ADOPT_EXISTING");

    // Key format: "containerId:proxyIndex" -> NPM proxy host ID
    private readonly ConcurrentDictionary<string, int> _containerProxyMap = new();
    // Key format: "containerId:streamIndex" -> NPM stream ID
    private readonly ConcurrentDictionary<string, int> _containerStreamMap = new();
    // Key format: "containerId" -> hash of sync-relevant labels
    private readonly ConcurrentDictionary<string, string> _containerLabelHashes = new();
    // Key format: "containerId:proxyIndex" -> UI disabled
    private readonly ConcurrentDictionary<string, bool> _uiDisabledProxies = new();
    // Last known parsed proxy configs for UI (containerId -> configs)
    private readonly ConcurrentDictionary<string, Dictionary<int, ProxyConfiguration>> _lastProxyConfigs = new();
    // Last known container display names
    private readonly ConcurrentDictionary<string, string> _containerNames = new();

    public SyncOrchestrator(
        ILogger<SyncOrchestrator> logger,
        NginxProxyManagerClient npmClient,
        LabelParser labelParser,
        DockerNetworkService networkService,
        CertificateService certificateService,
        InstanceIdentifier instanceIdentifier,
        DockerClient dockerClient,
        SettingsStore settings,
        IconResolver iconResolver,
        KomodoClient komodoClient,
        IServiceProvider serviceProvider)
    {
        _logger = logger;
        _npmClient = npmClient;
        _labelParser = labelParser;
        _networkService = networkService;
        _certificateService = certificateService;
        _instanceIdentifier = instanceIdentifier;
        _dockerClient = dockerClient;
        _settings = settings;
        _iconResolver = iconResolver;
        _komodoClient = komodoClient;

        _mirrorSyncService = serviceProvider.GetService(typeof(NpmMirrorSyncService)) as NpmMirrorSyncService;

        _logger.LogInformation("Using normalized NPM URL: {NpmUrl}", NpmUrl);
        if (AdoptExisting)
            _logger.LogInformation("NPM_ADOPT_EXISTING is enabled — unmanaged overlapping proxy hosts will be claimed");
    }

    public async Task RestoreStateFromNpm(DockerClient dockerClient, CancellationToken cancellationToken)
    {
        await EnsureInstanceIdAsync(cancellationToken);

        _logger.LogInformation("Restoring state from NPM for instance {InstanceId}...", _instanceId);

        try
        {
            var allProxies = await _npmClient.GetProxyHostsAsync(cancellationToken);
            var managedProxies = allProxies.Where(p => NginxProxyManagerClient.IsAutomationManaged(p, _instanceId!)).ToList();

            var containerIds = new HashSet<string>();

            foreach (var proxy in managedProxies)
            {
                var containerId = NginxProxyManagerClient.GetManagedContainerId(proxy);
                var proxyIndex = NginxProxyManagerClient.GetProxyIndex(proxy);

                if (containerId != null && proxyIndex.HasValue)
                {
                    var proxyKey = $"{containerId}:{proxyIndex.Value}";
                    _containerProxyMap.TryAdd(proxyKey, proxy.Id);

                    if (NginxProxyManagerClient.IsUiDisabled(proxy))
                        _uiDisabledProxies[proxyKey] = true;

                    _logger.LogDebug("Restored proxy mapping: {ProxyKey} -> NPM host {HostId}", proxyKey, proxy.Id);
                    containerIds.Add(containerId);
                }
            }

            var allStreams = await _npmClient.GetStreamsAsync(cancellationToken);
            var managedStreams = allStreams.Where(s => NginxProxyManagerClient.IsStreamAutomationManaged(s, _instanceId!)).ToList();

            foreach (var stream in managedStreams)
            {
                var containerId = NginxProxyManagerClient.GetStreamContainerId(stream);
                var streamIndex = NginxProxyManagerClient.GetStreamIndex(stream);

                if (containerId != null && streamIndex.HasValue)
                {
                    var streamKey = $"{containerId}:{streamIndex.Value}";
                    _containerStreamMap.TryAdd(streamKey, stream.Id);
                    _logger.LogDebug("Restored stream mapping: {StreamKey} -> NPM stream {StreamId}", streamKey, stream.Id);
                    containerIds.Add(containerId);
                }
            }

            _logger.LogDebug("Restoring label hashes for {Count} containers", containerIds.Count);
            foreach (var containerId in containerIds)
            {
                try
                {
                    var container = await dockerClient.Containers.InspectContainerAsync(containerId, cancellationToken);
                    if (container?.Config?.Labels != null)
                    {
                        var labelHash = ComputeLabelHash(container.Config.Labels);
                        _containerLabelHashes.TryAdd(containerId, labelHash);

                        var name = container.Name.TrimStart('/');
                        _containerNames[containerId] = name;

                        var configs = _labelParser.ParseLabels(container.Config.Labels);
                        _lastProxyConfigs[containerId] = configs;
                    }
                }
                catch (DockerContainerNotFoundException)
                {
                    _logger.LogWarning("Container {ContainerId} no longer exists, skipping label hash restoration", containerId);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to restore label hash for container {ContainerId}", containerId);
                }
            }

            _logger.LogInformation(
                "State restored: {ProxyCount}/{TotalProxies} managed proxy(s), {StreamCount} stream(s), {HashCount} label hash(es)",
                managedProxies.Count, allProxies.Count, managedStreams.Count, _containerLabelHashes.Count);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to restore state from NPM");
            throw;
        }
    }

    public async Task ProcessContainer(string containerId, string containerName, IDictionary<string, string> labels, CancellationToken cancellationToken)
    {
        try
        {
            await EnsureInstanceIdAsync(cancellationToken);

            _containerNames[containerId] = containerName;

            var proxyConfigs = _labelParser.ParseLabels(labels);
            var streamConfigs = _labelParser.ParseStreamLabels(labels);

            if (proxyConfigs.Count == 0 && !_labelParser.IsExcluded(labels))
            {
                var auto = await TryBuildAutoBridgeConfigAsync(containerId, containerName, labels, cancellationToken);
                if (auto != null)
                    proxyConfigs[0] = auto;
            }

            var currentLabelHash = proxyConfigs.Count > 0 || streamConfigs.Count > 0
                ? ComputeSyncHash(labels, proxyConfigs, streamConfigs)
                : string.Empty;

            _lastProxyConfigs[containerId] = proxyConfigs;

            var hasChanged = !_containerLabelHashes.TryGetValue(containerId, out var previousHash) ||
                             previousHash != currentLabelHash;

            if (!hasChanged)
            {
                var hasExistingProxies = _containerProxyMap.Keys.Any(k => k.StartsWith($"{containerId}:"));
                var hasExistingStreams = _containerStreamMap.Keys.Any(k => k.StartsWith($"{containerId}:"));

                if (hasExistingProxies || hasExistingStreams)
                {
                    _logger.LogInformation("✓ Container {ContainerName} unchanged - {ProxyCount} proxy(s), {StreamCount} stream(s) already managed",
                        containerName,
                        _containerProxyMap.Keys.Count(k => k.StartsWith($"{containerId}:")),
                        _containerStreamMap.Keys.Count(k => k.StartsWith($"{containerId}:")));
                }
                else
                {
                    _logger.LogDebug("Labels unchanged for container {ContainerName}, skipping", containerName);
                }
                return;
            }

            if (previousHash != null && previousHash != currentLabelHash)
            {
                _logger.LogInformation("Labels changed for container {ContainerName}, reprocessing", containerName);
            }
            else if (string.IsNullOrEmpty(currentLabelHash))
            {
                _logger.LogDebug("No sync labels or auto-bridge candidate for container {ContainerName}", containerName);
                // If we previously managed this container via auto-bridge and it's no longer eligible, clean up
                if (_containerProxyMap.Keys.Any(k => k.StartsWith($"{containerId}:")) ||
                    _containerStreamMap.Keys.Any(k => k.StartsWith($"{containerId}:")))
                {
                    await ProcessProxyHosts(containerId, containerName, new Dictionary<int, ProxyConfiguration>(), cancellationToken);
                    await ProcessStreams(containerId, containerName, new Dictionary<int, StreamConfiguration>(), cancellationToken);
                    _containerLabelHashes.TryRemove(containerId, out _);
                    _lastProxyConfigs.TryRemove(containerId, out _);
                }
                return;
            }
            else
            {
                _logger.LogInformation("Processing container {ContainerName} with {ProxyCount} proxy(s) and {StreamCount} stream(s)",
                    containerName, proxyConfigs.Count, streamConfigs.Count);
            }

            await ProcessProxyHosts(containerId, containerName, proxyConfigs, cancellationToken);
            await ProcessStreams(containerId, containerName, streamConfigs, cancellationToken);

            _containerLabelHashes.AddOrUpdate(containerId, currentLabelHash, (_, _) => currentLabelHash);
            _mirrorSyncService?.RequestSync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing container {ContainerId}", containerId);
        }
    }

    private async Task<ProxyConfiguration?> TryBuildAutoBridgeConfigAsync(
        string containerId,
        string containerName,
        IDictionary<string, string> labels,
        CancellationToken cancellationToken)
    {
        if (!_settings.GetBool("AUTO_BRIDGE_EXPOSED"))
            return null;

        var baseDomain = _settings.Get("PROXY_BASE_DOMAIN")?.Trim().TrimStart('.');
        if (string.IsNullOrWhiteSpace(baseDomain))
        {
            _logger.LogDebug("AUTO_BRIDGE_EXPOSED is on but PROXY_BASE_DOMAIN is not set; skipping {Container}", containerName);
            return null;
        }

        if (labels.TryGetValue("npm.proxy.autobridge", out var ab) &&
            ab.Equals("false", StringComparison.OrdinalIgnoreCase))
            return null;
        if (labels.TryGetValue("proxy.autobridge", out ab) &&
            ab.Equals("false", StringComparison.OrdinalIgnoreCase))
            return null;

        var excludeRaw = _settings.Get("AUTO_BRIDGE_EXCLUDE")
            ?? "npmplus,npm-docker-sync,nginx-proxy-manager";
        var excludes = excludeRaw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (excludes.Any(ex => containerName.Contains(ex, StringComparison.OrdinalIgnoreCase)))
            return null;

        var port = await _networkService.InferForwardPort(containerId, cancellationToken);
        if (!port.HasValue)
            return null;

        var slug = IconResolver.ToSlug(containerName);
        if (string.IsNullOrEmpty(slug))
            return null;

        var domain = $"{slug}.{baseDomain}";
        _logger.LogInformation(
            "Auto-bridging container {ContainerName} → {Domain}:{Port}",
            containerName, domain, port.Value);

        return new ProxyConfiguration
        {
            Index = 0,
            DomainNames = new List<string> { domain },
            ForwardPort = port,
            ForwardScheme = "http",
            SslForced = _settings.GetBool("NPM_PROXY_SSL_FORCE"),
            CachingEnabled = _settings.GetBool("NPM_PROXY_CACHING"),
            BlockExploits = _settings.GetBool("NPM_PROXY_BLOCK_EXPLOITS", true),
            AllowWebsocketUpgrade = _settings.GetBool("NPM_PROXY_WEBSOCKETS"),
            Http2Support = _settings.GetBool("NPM_PROXY_HTTP2"),
            HstsEnabled = _settings.GetBool("NPM_PROXY_HSTS"),
            HstsSubdomains = _settings.GetBool("NPM_PROXY_HSTS_SUBDOMAINS"),
            LabelSource = ProxyLabelSource.GoDoxy,
            Homepage = new HomepageInfo { Name = containerName, Category = "Auto", Show = true },
        };
    }

    private string ComputeSyncHash(
        IDictionary<string, string> labels,
        Dictionary<int, ProxyConfiguration> proxies,
        Dictionary<int, StreamConfiguration> streams)
    {
        var parts = new List<string>
        {
            ComputeLabelHash(labels),
            $"ab={_settings.GetBool("AUTO_BRIDGE_EXPOSED")}",
            $"bd={_settings.Get("PROXY_BASE_DOMAIN")}",
            $"ssl={_settings.GetBool("NPM_PROXY_SSL_FORCE")}",
        };

        foreach (var (index, config) in proxies.OrderBy(p => p.Key))
        {
            parts.Add(
                $"p{index}:{string.Join(",", config.DomainNames)}:{config.ForwardPort}:{config.SslForced}:{config.LabelSource}");
        }

        foreach (var (index, config) in streams.OrderBy(s => s.Key))
            parts.Add($"s{index}:{config.IncomingPort}:{config.ForwardPort}");

        var combined = string.Join("|", parts);
        if (proxies.Count == 0 && streams.Count == 0)
            return string.Empty;

        return Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(combined)));
    }

    public async Task SyncNowAsync(string containerId, CancellationToken cancellationToken)
    {
        var container = await _dockerClient.Containers.InspectContainerAsync(containerId, cancellationToken);
        var name = container.Name.TrimStart('/');
        var labels = container.Config?.Labels ?? new Dictionary<string, string>();

        // Force reprocess by clearing hash
        _containerLabelHashes.TryRemove(containerId, out _);
        await ProcessContainer(containerId, name, labels, cancellationToken);
    }

    public async Task SetEnabledAsync(string containerId, int index, bool enabled, CancellationToken cancellationToken)
    {
        await EnsureInstanceIdAsync(cancellationToken);

        var proxyKey = $"{containerId}:{index}";
        if (!_containerProxyMap.TryGetValue(proxyKey, out var hostId))
            throw new InvalidOperationException($"No synced proxy host for container {containerId} index {index}");

        await _npmClient.SetProxyHostEnabledAsync(hostId, enabled, cancellationToken);

        if (enabled)
            _uiDisabledProxies.TryRemove(proxyKey, out _);
        else
            _uiDisabledProxies[proxyKey] = true;

        _logger.LogInformation("Proxy {ProxyKey} (host {HostId}) set enabled={Enabled}", proxyKey, hostId, enabled);
    }

    public async Task<List<RouteInfo>> GetRoutesAsync(CancellationToken cancellationToken)
    {
        await EnsureInstanceIdAsync(cancellationToken);

        var routes = new List<RouteInfo>();
        var containers = await _dockerClient.Containers.ListContainersAsync(
            new ContainersListParameters { All = false },
            cancellationToken);

        var allProxies = await _npmClient.GetProxyHostsAsync(cancellationToken);
        var managedByDomain = new Dictionary<string, ProxyHost>(StringComparer.OrdinalIgnoreCase);

        foreach (var proxy in allProxies)
        {
            if (proxy.DomainNames == null) continue;
            foreach (var domain in proxy.DomainNames)
                managedByDomain[domain] = proxy;
        }

        foreach (var container in containers)
        {
            var containerId = container.ID;
            var containerName = container.Names.FirstOrDefault()?.TrimStart('/') ?? containerId[..12];
            var labels = container.Labels ?? new Dictionary<string, string>();

            if (_labelParser.IsExcluded(labels))
            {
                routes.Add(new RouteInfo
                {
                    ContainerId = containerId,
                    ContainerName = containerName,
                    Index = 0,
                    Name = containerName,
                    Domains = new List<string>(),
                    Status = RouteStatus.Excluded,
                    Category = "Docker",
                    LabelSource = "godoxy",
                });
                continue;
            }

            var configs = _labelParser.ParseLabels(labels);
            if (configs.Count == 0 && !_labelParser.IsExcluded(labels))
            {
                var auto = await TryBuildAutoBridgeConfigAsync(containerId, containerName, labels, cancellationToken);
                if (auto != null)
                    configs[0] = auto;
            }

            if (configs.Count == 0)
                continue;

            _lastProxyConfigs[containerId] = configs;
            _containerNames[containerId] = containerName;

            foreach (var (index, config) in configs)
            {
                if (config.Homepage?.Show == false)
                    continue;

                var proxyKey = $"{containerId}:{index}";
                _containerProxyMap.TryGetValue(proxyKey, out var mappedHostId);

                ProxyHost? npmHost = null;
                if (mappedHostId != 0)
                    npmHost = allProxies.FirstOrDefault(p => p.Id == mappedHostId);

                npmHost ??= config.DomainNames
                    .Select(d => managedByDomain.TryGetValue(d, out var h) ? h : null)
                    .FirstOrDefault(h => h != null);

                var status = ResolveStatus(proxyKey, config, npmHost);
                var uiDisabled = _uiDisabledProxies.ContainsKey(proxyKey) ||
                                 (npmHost != null && NginxProxyManagerClient.IsUiDisabled(npmHost));

                var routeOverride = _settings.GetRouteOverride(containerId, index);
                if (routeOverride != null)
                    ApplyRouteOverride(containerId, index, config);

                ApplyDefaultAuthRequest(config);

                // Prefer live NPM host forward target; otherwise infer for display
                var forwardHost = !string.IsNullOrWhiteSpace(config.ForwardHost)
                    ? config.ForwardHost
                    : npmHost?.ForwardHost;
                var forwardPort = config.ForwardPort
                    ?? (npmHost is { ForwardPort: > 0 } ? npmHost.ForwardPort : null);
                var forwardScheme = !string.IsNullOrWhiteSpace(config.ForwardScheme)
                    ? config.ForwardScheme
                    : (npmHost?.ForwardScheme ?? "http");

                if (string.IsNullOrWhiteSpace(forwardHost))
                {
                    try
                    {
                        forwardHost = await _networkService.InferForwardHost(
                            containerId, null, cancellationToken, config.PreferredNetwork);
                    }
                    catch
                    {
                        // leave empty for UI
                    }
                }

                if (!forwardPort.HasValue)
                {
                    try
                    {
                        forwardPort = await _networkService.InferForwardPort(containerId, cancellationToken);
                    }
                    catch
                    {
                        // leave empty for UI
                    }
                }

                var icon = await _iconResolver.ResolveAsync(
                    routeOverride?.Icon,
                    config.Homepage?.Icon,
                    config.Homepage?.Name,
                    containerName,
                    cancellationToken);

                KomodoMatch? komodo = null;
                try
                {
                    komodo = await _komodoClient.FindResourceForContainerAsync(containerName, cancellationToken);
                }
                catch
                {
                    // ignored
                }

                routes.Add(new RouteInfo
                {
                    ContainerId = containerId,
                    ContainerName = containerName,
                    Index = index,
                    Name = !string.IsNullOrWhiteSpace(routeOverride?.DisplayName)
                        ? routeOverride!.DisplayName!.Trim()
                        : (config.Homepage?.Name ?? containerName),
                    Description = config.Homepage?.Description,
                    Icon = icon,
                    Category = config.Homepage?.Category
                               ?? (config.LabelSource == ProxyLabelSource.GoDoxy ? "Docker" : "NPM"),
                    Domains = config.DomainNames,
                    ForwardHost = forwardHost,
                    ForwardPort = forwardPort,
                    ForwardScheme = forwardScheme,
                    Status = status,
                    NpmHostId = npmHost?.Id,
                    Enabled = npmHost == null ? null : !uiDisabled && npmHost.Enabled == 1,
                    LabelSource = config.LabelSource.ToString().ToLowerInvariant(),
                    SslForced = config.SslForced,
                    Http2Support = config.Http2Support,
                    HstsEnabled = config.HstsEnabled,
                    HstsSubdomains = config.HstsSubdomains,
                    AllowWebsocketUpgrade = config.AllowWebsocketUpgrade,
                    CachingEnabled = config.CachingEnabled,
                    BlockExploits = config.BlockExploits,
                    CertificateId = config.CertificateId ?? npmHost?.CertificateId,
                    AuthRequest = config.AuthRequest ?? npmHost?.NpmplusAuthRequest,
                    AuthRequestUpstream = config.AuthRequestUpstream ?? npmHost?.NpmplusAuthRequestUpstream,
                    AuthExempt = routeOverride?.AuthExempt,
                    Hidden = routeOverride?.Hidden == true,
                    HasUiOverride = routeOverride != null,
                    KomodoUrl = komodo?.Url,
                    KomodoResourceType = komodo?.ResourceType,
                    KomodoResourceName = komodo?.ResourceName,
                });
            }
        }

        return routes.OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public async Task<DashboardStats> GetStatsAsync(CancellationToken cancellationToken)
    {
        var routes = await GetRoutesAsync(cancellationToken);
        var visible = routes.Where(r => !r.Hidden).ToList();
        var uptime = DateTime.UtcNow - _startedAt;

        return new DashboardStats
        {
            UptimeSeconds = (long)uptime.TotalSeconds,
            Total = visible.Count(r => r.Status != RouteStatus.Excluded),
            Synced = visible.Count(r => r.Status == RouteStatus.Synced),
            Missing = visible.Count(r => r.Status == RouteStatus.Missing),
            Disabled = visible.Count(r => r.Status == RouteStatus.Disabled),
            Conflict = visible.Count(r => r.Status == RouteStatus.Conflict),
        };
    }

    private RouteStatus ResolveStatus(string proxyKey, ProxyConfiguration config, ProxyHost? npmHost)
    {
        if (npmHost == null)
        {
            if (_containerProxyMap.ContainsKey(proxyKey))
                return RouteStatus.Missing;
            return RouteStatus.Missing;
        }

        if (!NginxProxyManagerClient.IsAutomationManaged(npmHost, _instanceId!))
        {
            // Domain exists but not ours
            if (!_containerProxyMap.ContainsKey(proxyKey))
                return RouteStatus.Conflict;
        }

        if (_uiDisabledProxies.ContainsKey(proxyKey) || NginxProxyManagerClient.IsUiDisabled(npmHost) || npmHost.Enabled == 0)
            return RouteStatus.Disabled;

        return RouteStatus.Synced;
    }

    private async Task ProcessProxyHosts(string containerId, string containerName, Dictionary<int, ProxyConfiguration> configs, CancellationToken cancellationToken)
    {
        var existingProxyKeys = _containerProxyMap.Keys
            .Where(k => k.StartsWith($"{containerId}:"))
            .ToList();

        var existingIndices = existingProxyKeys
            .Select(k => int.Parse(k.Split(':')[1]))
            .ToHashSet();

        var newIndices = configs.Keys.ToHashSet();

        foreach (var index in existingIndices.Except(newIndices))
        {
            await RemoveProxy(containerId, containerName, index, cancellationToken);
            _uiDisabledProxies.TryRemove($"{containerId}:{index}", out _);
        }

        foreach (var (index, config) in configs)
            await ProcessProxyConfig(containerId, containerName, index, config, cancellationToken);
    }

    private async Task ProcessStreams(string containerId, string containerName, Dictionary<int, StreamConfiguration> configs, CancellationToken cancellationToken)
    {
        var existingStreamKeys = _containerStreamMap.Keys
            .Where(k => k.StartsWith($"{containerId}:"))
            .ToList();

        var existingIndices = existingStreamKeys
            .Select(k => int.Parse(k.Split(':')[1]))
            .ToHashSet();

        var newIndices = configs.Keys.ToHashSet();

        foreach (var index in existingIndices.Except(newIndices))
            await RemoveStream(containerId, containerName, index, cancellationToken);

        foreach (var (index, config) in configs)
            await ProcessStreamConfig(containerId, containerName, index, config, cancellationToken);
    }

    private async Task ProcessProxyConfig(string containerId, string containerName, int index, ProxyConfiguration config, CancellationToken cancellationToken)
    {
        ApplyRouteOverride(containerId, index, config);
        ApplyDefaultAuthRequest(config);

        if (string.IsNullOrEmpty(config.ForwardHost))
        {
            config.ForwardHost = await _networkService.InferForwardHost(
                containerId, null, cancellationToken, config.PreferredNetwork);
        }

        if (!config.ForwardPort.HasValue)
        {
            var inferredPort = await _networkService.InferForwardPort(containerId, cancellationToken);
            if (inferredPort.HasValue)
            {
                config.ForwardPort = inferredPort.Value;
            }
            else
            {
                _logger.LogError("❌ Cannot create proxy for container {ContainerName} proxy {Index}: No port specified and unable to auto-detect port from container",
                    containerName, index);
                return;
            }
        }

        if (!config.CertificateId.HasValue || config.CertificateId == 0)
        {
            var mapped = _certificateService.ResolveFromDomainMap(config.DomainNames);
            if (mapped.HasValue)
            {
                config.CertificateId = mapped.Value;
                config.SslForced = true;
                _logger.LogInformation("CERT_DOMAIN_MAP selected certificate {CertId} for proxy {Index}", mapped.Value, index);
            }
        }

        if (config.SslForced && (!config.CertificateId.HasValue || config.CertificateId == 0))
        {
            var certId = await _certificateService.FindMatchingCertificateAsync(config.DomainNames, cancellationToken);
            if (certId.HasValue)
            {
                config.CertificateId = certId.Value;
                _logger.LogInformation("Auto-selected certificate ID {CertId} for proxy {Index} domains: {Domains}",
                    certId.Value, index, string.Join(", ", config.DomainNames));
            }
            else
            {
                _logger.LogWarning("SSL forced but no matching certificate found for proxy {Index} domains: {Domains}",
                    index, string.Join(", ", config.DomainNames));
            }
        }

        _logger.LogInformation("Processing container {ContainerId} proxy {Index} with domains: {Domains}, host: {ForwardHost}:{ForwardPort}, cert_id: {CertId}",
            containerId, index, string.Join(", ", config.DomainNames), config.ForwardHost, config.ForwardPort, config.CertificateId?.ToString() ?? "none");

        var proxyKey = $"{containerId}:{index}";

        if (_containerProxyMap.TryGetValue(proxyKey, out var existingHostId))
        {
            _logger.LogInformation("Labels changed for container {ContainerName} proxy {Index}. Deleting and recreating proxy host {HostId}.",
                containerName, index, existingHostId);
            await RemoveProxy(containerId, containerName, index, cancellationToken);
        }

        await CreateOrUpdateProxyHost(containerId, index, config, cancellationToken);
    }

    private async Task ProcessStreamConfig(string containerId, string containerName, int index, StreamConfiguration config, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(config.ForwardHost))
            config.ForwardHost = await _networkService.InferForwardHost(containerId, null, cancellationToken);

        if (!config.ForwardPort.HasValue)
        {
            var inferredPort = await _networkService.InferForwardPort(containerId, cancellationToken);
            if (inferredPort.HasValue)
            {
                config.ForwardPort = inferredPort.Value;
            }
            else
            {
                _logger.LogError("❌ Cannot create stream for container {ContainerName} stream {Index}: No forward port specified and unable to auto-detect port from container",
                    containerName, index);
                return;
            }
        }

        if (!string.IsNullOrEmpty(config.SslCertificate))
        {
            if (int.TryParse(config.SslCertificate, out var certId))
            {
                config.CertificateId = certId;
            }
            else
            {
                var matchedCertId = await _certificateService.FindMatchingCertificateAsync(
                    new List<string> { config.SslCertificate }, cancellationToken);

                if (matchedCertId.HasValue)
                {
                    config.CertificateId = matchedCertId.Value;
                }
                else
                {
                    _logger.LogError("❌ Cannot create stream for container {ContainerName} stream {Index}: SSL certificate specified ({Domain}) but no matching certificate found",
                        containerName, index, config.SslCertificate);
                    return;
                }
            }
        }

        if (!config.TcpForwarding && !config.UdpForwarding)
        {
            _logger.LogError("❌ Cannot create stream for container {ContainerName} stream {Index}: At least one of TCP or UDP forwarding must be enabled",
                containerName, index);
            return;
        }

        var streamKey = $"{containerId}:{index}";

        if (_containerStreamMap.TryGetValue(streamKey, out var existingStreamId))
        {
            _logger.LogInformation("Labels changed for container {ContainerName} stream {Index}. Deleting and recreating stream {StreamId}.",
                containerName, index, existingStreamId);
            await RemoveStream(containerId, containerName, index, cancellationToken);
        }

        await CreateStream(containerId, containerName, index, config, cancellationToken);
    }

    public async Task RemoveContainer(string containerId, string containerName, CancellationToken cancellationToken)
    {
        try
        {
            var proxyKeys = _containerProxyMap.Keys
                .Where(k => k.StartsWith($"{containerId}:"))
                .ToList();

            var streamKeys = _containerStreamMap.Keys
                .Where(k => k.StartsWith($"{containerId}:"))
                .ToList();

            if (proxyKeys.Count == 0 && streamKeys.Count == 0)
            {
                _logger.LogDebug("No proxy or stream mappings found for container {ContainerName}", containerName);
                _containerLabelHashes.TryRemove(containerId, out _);
                _lastProxyConfigs.TryRemove(containerId, out _);
                _containerNames.TryRemove(containerId, out _);
                return;
            }

            _logger.LogInformation("Removing {ProxyCount} proxy(s) and {StreamCount} stream(s) for container {ContainerName}",
                proxyKeys.Count, streamKeys.Count, containerName);

            foreach (var proxyKey in proxyKeys)
            {
                var index = int.Parse(proxyKey.Split(':')[1]);
                await RemoveProxy(containerId, containerName, index, cancellationToken);
                _uiDisabledProxies.TryRemove(proxyKey, out _);
            }

            foreach (var streamKey in streamKeys)
            {
                var index = int.Parse(streamKey.Split(':')[1]);
                await RemoveStream(containerId, containerName, index, cancellationToken);
            }

            _containerLabelHashes.TryRemove(containerId, out _);
            _lastProxyConfigs.TryRemove(containerId, out _);
            _containerNames.TryRemove(containerId, out _);
            _mirrorSyncService?.RequestSync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error removing container {ContainerName}", containerName);
        }
    }

    private async Task RemoveProxy(string containerId, string containerName, int index, CancellationToken cancellationToken)
    {
        var proxyKey = $"{containerId}:{index}";

        if (_containerProxyMap.TryRemove(proxyKey, out var proxyHostId))
        {
            _logger.LogInformation("Removing proxy host {HostId} for container {ContainerName} proxy {Index}",
                proxyHostId, containerName, index);

            try
            {
                await _npmClient.DeleteProxyHostAsync(proxyHostId, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error deleting proxy host {HostId} for container {ContainerName} proxy {Index}",
                    proxyHostId, containerName, index);
            }
        }
    }

    private async Task RemoveStream(string containerId, string containerName, int index, CancellationToken cancellationToken)
    {
        var streamKey = $"{containerId}:{index}";

        if (_containerStreamMap.TryRemove(streamKey, out var streamId))
        {
            _logger.LogInformation("Removing stream {StreamId} for container {ContainerName} stream {Index}",
                streamId, containerName, index);

            try
            {
                await _npmClient.DeleteStreamAsync(streamId, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error deleting stream {StreamId} for container {ContainerName} stream {Index}",
                    streamId, containerName, index);
            }
        }
    }

    private async Task CreateStream(string containerId, string containerName, int index, StreamConfiguration config, CancellationToken cancellationToken)
    {
        var streamKey = $"{containerId}:{index}";

        try
        {
            var request = _labelParser.ToStreamRequest(config, containerId, _instanceId!, NpmUrl);
            var stream = await _npmClient.CreateStreamAsync(request, cancellationToken);

            _containerStreamMap.AddOrUpdate(streamKey, stream.Id, (_, _) => stream.Id);

            var protocols = new List<string>();
            if (config.TcpForwarding) protocols.Add("tcp");
            if (config.UdpForwarding) protocols.Add("udp");

            _logger.LogInformation("✅ Created stream {{id={StreamId}, incoming={IncomingPort}, forward={ForwardHost}:{ForwardPort}, protocol={Protocol}}}",
                stream.Id, config.IncomingPort, config.ForwardHost, config.ForwardPort, string.Join("+", protocols));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "❌ Failed to create stream for container {ContainerName} stream {Index}", containerName, index);
            throw;
        }
    }

    private async Task CreateOrUpdateProxyHost(string containerId, int index, ProxyConfiguration config, CancellationToken cancellationToken)
    {
        if (config.DomainNames == null || config.DomainNames.Count == 0)
        {
            _logger.LogWarning("No domain names configured for container {ContainerId} proxy {Index}", containerId, index);
            return;
        }

        var proxyKey = $"{containerId}:{index}";
        var uiDisabled = _uiDisabledProxies.ContainsKey(proxyKey);

        var existingHost = await _npmClient.GetProxyHostByDomainsAsync(config.DomainNames, cancellationToken);

        if (existingHost != null)
        {
            if (!NginxProxyManagerClient.IsAutomationManaged(existingHost, _instanceId!))
            {
                if (!AdoptExisting)
                {
                    _logger.LogError(
                        "⚠️ CONFLICT: Found existing proxy host {HostId} with domains [{ExistingDomains}] that overlaps with requested domains [{RequestedDomains}]",
                        existingHost.Id,
                        string.Join(", ", existingHost.DomainNames ?? new List<string>()),
                        string.Join(", ", config.DomainNames));
                    _logger.LogError(
                        "⚠️ This proxy is NOT managed by this automation instance (ID: {InstanceId}). Set NPM_ADOPT_EXISTING=true to claim it.",
                        _instanceId);
                    return;
                }

                _logger.LogWarning(
                    "Adopting unmanaged proxy host {HostId} for domains [{Domains}] (NPM_ADOPT_EXISTING)",
                    existingHost.Id, string.Join(", ", config.DomainNames));
                await UpdateExistingProxyHost(proxyKey, existingHost.Id, containerId, config, uiDisabled, cancellationToken);
                return;
            }

            // Preserve UI disabled from existing host meta before update
            if (NginxProxyManagerClient.IsUiDisabled(existingHost))
            {
                uiDisabled = true;
                _uiDisabledProxies[proxyKey] = true;
            }

            _logger.LogInformation("Found existing automation-managed proxy host {HostId}. Updating in place...", existingHost.Id);
            await UpdateExistingProxyHost(proxyKey, existingHost.Id, containerId, config, uiDisabled, cancellationToken);
            return;
        }

        try
        {
            var request = _labelParser.ToProxyHostRequest(config, containerId, _instanceId!, NpmUrl, uiDisabled);
            var newHost = await _npmClient.CreateProxyHostAsync(request, cancellationToken);
            RecordCreatedProxy(proxyKey, newHost.Id, config, uiDisabled);
        }
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.BadRequest)
        {
            var isDomainConflict = ex.Message.Contains("already in use", StringComparison.OrdinalIgnoreCase);
            _logger.LogError(ex,
                "❌ Failed to create proxy host for container {ContainerId} proxy {Index}: {Message}",
                containerId, index, ex.Message);

            if (!isDomainConflict)
                throw;

            // Domain taken — try to resolve via fresh lookup (race / missed list deserialize)
            existingHost = await _npmClient.GetProxyHostByDomainsAsync(config.DomainNames, cancellationToken);
            if (existingHost == null)
            {
                _logger.LogError(
                    "Domain conflict reported by NPM but no overlapping proxy host was found — domain may belong to a redirection/dead host");
                return;
            }

            if (!NginxProxyManagerClient.IsAutomationManaged(existingHost, _instanceId!) && !AdoptExisting)
            {
                _logger.LogError(
                    "⚠️ CONFLICT: proxy host {HostId} owns overlapping domains and is not managed by instance {InstanceId}. Set NPM_ADOPT_EXISTING=true to claim it.",
                    existingHost.Id, _instanceId);
                return;
            }

            if (NginxProxyManagerClient.IsUiDisabled(existingHost))
            {
                uiDisabled = true;
                _uiDisabledProxies[proxyKey] = true;
            }

            _logger.LogInformation("Recovering from domain conflict by updating proxy host {HostId}", existingHost.Id);
            await UpdateExistingProxyHost(proxyKey, existingHost.Id, containerId, config, uiDisabled, cancellationToken);
        }
    }

    private async Task UpdateExistingProxyHost(
        string proxyKey,
        int hostId,
        string containerId,
        ProxyConfiguration config,
        bool uiDisabled,
        CancellationToken cancellationToken)
    {
        var request = _labelParser.ToProxyHostRequest(config, containerId, _instanceId!, NpmUrl, uiDisabled);
        var updated = await _npmClient.UpdateProxyHostAsync(hostId, request, cancellationToken);
        RecordCreatedProxy(proxyKey, updated.Id, config, uiDisabled);
    }

    private void RecordCreatedProxy(string proxyKey, int hostId, ProxyConfiguration config, bool uiDisabled)
    {
        _containerProxyMap.AddOrUpdate(proxyKey, hostId, (_, _) => hostId);

        var options = new List<string>();
        if (config.SslForced) options.Add("ssl");
        if (config.AllowWebsocketUpgrade) options.Add("websockets");
        if (config.Http2Support) options.Add("http2");
        if (config.HstsEnabled) options.Add("hsts");
        if (config.CachingEnabled) options.Add("cache");
        if (config.BlockExploits) options.Add("block_exploits");
        if (uiDisabled) options.Add("disabled");

        _logger.LogInformation(
            "✅ Synced proxy host {{id={HostId}, domains=[{Domains}], forward={Scheme}://{Host}:{Port}, options={Options}}}",
            hostId,
            string.Join(",", config.DomainNames),
            config.ForwardScheme,
            config.ForwardHost,
            config.ForwardPort,
            options.Count > 0 ? string.Join("+", options) : "none");
    }

    public async Task UpdateRouteOverrideAsync(string containerId, int index, RouteOverride patch, CancellationToken cancellationToken)
    {
        var existing = _settings.GetRouteOverride(containerId, index) ?? new RouteOverride();
        MergeOverride(existing, patch);
        _settings.UpsertRouteOverride(containerId, index, existing);

        // Force re-sync so NPM picks up changes
        _containerLabelHashes.TryRemove(containerId, out _);
        await SyncNowAsync(containerId, cancellationToken);
    }

    public async Task ClearRouteOverrideAsync(string containerId, int index, CancellationToken cancellationToken)
    {
        _settings.DeleteRouteOverride(containerId, index);
        _containerLabelHashes.TryRemove(containerId, out _);
        await SyncNowAsync(containerId, cancellationToken);
    }

    private void ApplyRouteOverride(string containerId, int index, ProxyConfiguration config)
    {
        var ov = _settings.GetRouteOverride(containerId, index);
        if (ov == null)
            return;

        if (!string.IsNullOrWhiteSpace(ov.DisplayName))
        {
            config.Homepage ??= new HomepageInfo();
            config.Homepage.Name = ov.DisplayName.Trim();
        }

        if (ov.Domains != null)
        {
            var expanded = ov.Domains
                .SelectMany(d => (d ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                .Where(d => !string.IsNullOrWhiteSpace(d))
                .Select(ExpandDomainAlias)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (expanded.Count > 0)
                config.DomainNames = expanded;
        }

        if (!string.IsNullOrWhiteSpace(ov.ForwardHost))
            config.ForwardHost = ov.ForwardHost;
        if (ov.ForwardPort.HasValue)
            config.ForwardPort = ov.ForwardPort;
        if (!string.IsNullOrWhiteSpace(ov.ForwardScheme))
            config.ForwardScheme = ov.ForwardScheme;
        if (ov.SslForced.HasValue)
            config.SslForced = ov.SslForced.Value;
        if (ov.Http2Support.HasValue)
            config.Http2Support = ov.Http2Support.Value;
        if (ov.HstsEnabled.HasValue)
            config.HstsEnabled = ov.HstsEnabled.Value;
        if (ov.HstsSubdomains.HasValue)
            config.HstsSubdomains = ov.HstsSubdomains.Value;
        if (ov.AllowWebsocketUpgrade.HasValue)
            config.AllowWebsocketUpgrade = ov.AllowWebsocketUpgrade.Value;
        if (ov.CachingEnabled.HasValue)
            config.CachingEnabled = ov.CachingEnabled.Value;
        if (ov.BlockExploits.HasValue)
            config.BlockExploits = ov.BlockExploits.Value;
        if (ov.CertificateId.HasValue)
            config.CertificateId = ov.CertificateId;
        if (ov.AdvancedConfig != null)
            config.AdvancedConfig = ov.AdvancedConfig;

        if (ov.AuthExempt == true)
        {
            config.AuthRequest = "none";
            config.AuthRequestUpstream = string.Empty;
        }
        else
        {
            if (!string.IsNullOrWhiteSpace(ov.AuthRequest))
                config.AuthRequest = ov.AuthRequest;
            if (ov.AuthRequestUpstream != null)
                config.AuthRequestUpstream = ov.AuthRequestUpstream;
        }

        if (ov.Icon != null)
        {
            config.Homepage ??= new HomepageInfo();
            config.Homepage.Icon = IconResolver.NormalizeIconUrl(ov.Icon) ?? string.Empty;
        }
    }

    private string ExpandDomainAlias(string alias)
    {
        var trimmed = alias.Trim();
        if (trimmed.Contains('.'))
            return trimmed;

        var baseDomain = _settings.Get("PROXY_BASE_DOMAIN")?.Trim().TrimStart('.');
        if (string.IsNullOrWhiteSpace(baseDomain))
            return trimmed;

        return $"{trimmed}.{baseDomain}";
    }

    private void ApplyDefaultAuthRequest(ProxyConfiguration config)
    {
        if (!string.IsNullOrWhiteSpace(config.AuthRequest))
            return;

        var defaultAuth = _settings.Get("AUTH_REQUEST_DEFAULT");
        if (string.IsNullOrWhiteSpace(defaultAuth) || defaultAuth.Equals("none", StringComparison.OrdinalIgnoreCase))
        {
            config.AuthRequest = "none";
            return;
        }

        config.AuthRequest = defaultAuth;
        config.AuthRequestUpstream = _settings.Get("AUTH_REQUEST_UPSTREAM") ?? string.Empty;
    }

    private static void MergeOverride(RouteOverride target, RouteOverride patch)
    {
        if (patch.DisplayName != null) target.DisplayName = string.IsNullOrWhiteSpace(patch.DisplayName) ? null : patch.DisplayName.Trim();
        if (patch.Domains != null)
        {
            target.Domains = patch.Domains
                .SelectMany(d => (d ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                .Where(d => !string.IsNullOrWhiteSpace(d))
                .ToList();
            if (target.Domains.Count == 0)
                target.Domains = null;
        }
        if (patch.Hidden.HasValue) target.Hidden = patch.Hidden;
        if (patch.ForwardHost != null) target.ForwardHost = patch.ForwardHost;
        if (patch.ForwardPort.HasValue) target.ForwardPort = patch.ForwardPort;
        if (patch.ForwardScheme != null) target.ForwardScheme = patch.ForwardScheme;
        if (patch.SslForced.HasValue) target.SslForced = patch.SslForced;
        if (patch.Http2Support.HasValue) target.Http2Support = patch.Http2Support;
        if (patch.HstsEnabled.HasValue) target.HstsEnabled = patch.HstsEnabled;
        if (patch.HstsSubdomains.HasValue) target.HstsSubdomains = patch.HstsSubdomains;
        if (patch.AllowWebsocketUpgrade.HasValue) target.AllowWebsocketUpgrade = patch.AllowWebsocketUpgrade;
        if (patch.CachingEnabled.HasValue) target.CachingEnabled = patch.CachingEnabled;
        if (patch.BlockExploits.HasValue) target.BlockExploits = patch.BlockExploits;
        if (patch.CertificateId.HasValue) target.CertificateId = patch.CertificateId;
        if (patch.AuthRequest != null) target.AuthRequest = patch.AuthRequest;
        if (patch.AuthRequestUpstream != null) target.AuthRequestUpstream = patch.AuthRequestUpstream;
        if (patch.AuthExempt.HasValue) target.AuthExempt = patch.AuthExempt;
        if (patch.Icon != null)
            target.Icon = string.IsNullOrWhiteSpace(patch.Icon)
                ? null
                : IconResolver.NormalizeIconUrl(patch.Icon);
        if (patch.AdvancedConfig != null) target.AdvancedConfig = patch.AdvancedConfig;
    }

    private async Task EnsureInstanceIdAsync(CancellationToken cancellationToken)
    {
        if (_instanceId == null)
        {
            _instanceId = await _instanceIdentifier.GetInstanceIdAsync(cancellationToken);
            _logger.LogInformation("Sync instance ID: {InstanceId}", _instanceId);
        }
    }

    private string ComputeLabelHash(IDictionary<string, string> labels)
    {
        var syncLabels = labels
            .Where(l =>
                l.Key.StartsWith("npm.") ||
                l.Key.StartsWith("npm-") ||
                l.Key.StartsWith("proxy.", StringComparison.OrdinalIgnoreCase))
            .OrderBy(l => l.Key)
            .Select(l => $"{l.Key}={l.Value}")
            .ToList();

        if (syncLabels.Count == 0)
            return string.Empty;

        var combined = string.Join("|", syncLabels);
        return Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(combined)));
    }
}

public enum RouteStatus
{
    Synced,
    Missing,
    Disabled,
    Excluded,
    Conflict,
}

public class RouteInfo
{
    public string ContainerId { get; set; } = string.Empty;
    public string ContainerName { get; set; } = string.Empty;
    public int Index { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string? Category { get; set; }
    public List<string> Domains { get; set; } = new();
    public string? ForwardHost { get; set; }
    public int? ForwardPort { get; set; }
    public string? ForwardScheme { get; set; }
    public RouteStatus Status { get; set; }
    public int? NpmHostId { get; set; }
    public bool? Enabled { get; set; }
    public string LabelSource { get; set; } = "npm";
    public bool? SslForced { get; set; }
    public bool? Http2Support { get; set; }
    public bool? HstsEnabled { get; set; }
    public bool? HstsSubdomains { get; set; }
    public bool? AllowWebsocketUpgrade { get; set; }
    public bool? CachingEnabled { get; set; }
    public bool? BlockExploits { get; set; }
    public int? CertificateId { get; set; }
    public string? AuthRequest { get; set; }
    public string? AuthRequestUpstream { get; set; }
    public bool? AuthExempt { get; set; }
    public bool Hidden { get; set; }
    public bool HasUiOverride { get; set; }
    public string? KomodoUrl { get; set; }
    public string? KomodoResourceType { get; set; }
    public string? KomodoResourceName { get; set; }
}

public class DashboardStats
{
    public long UptimeSeconds { get; set; }
    public int Total { get; set; }
    public int Synced { get; set; }
    public int Missing { get; set; }
    public int Disabled { get; set; }
    public int Conflict { get; set; }
}
