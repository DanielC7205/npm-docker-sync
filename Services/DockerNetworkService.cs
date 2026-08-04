using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class DockerNetworkService
{
    private readonly ILogger<DockerNetworkService> _logger;
    private readonly DockerClient _dockerClient;
    private readonly string? _npmContainerName;
    private readonly string? _dockerHostIp;
    private string? _detectedDockerHostIp;
    private HashSet<string>? _npmNetworks;
    private bool _npmIsHostNetwork;

    public DockerNetworkService(
        ILogger<DockerNetworkService> logger,
        DockerClient dockerClient,
        IConfiguration configuration)
    {
        _logger = logger;
        _dockerClient = dockerClient;
        _npmContainerName = configuration["NPM_CONTAINER_NAME"];
        _dockerHostIp = configuration["DOCKER_HOST_IP"];
    }

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        // Detect NPM container networks if container name is provided
        if (!string.IsNullOrEmpty(_npmContainerName))
        {
            await DetectNpmNetworks(cancellationToken);
        }

        // Detect Docker host IP if not explicitly provided
        if (string.IsNullOrEmpty(_dockerHostIp))
        {
            await DetectDockerHostIp(cancellationToken);
        }
        else
        {
            _detectedDockerHostIp = _dockerHostIp;
        }

        _logger.LogInformation(
            "Network detection initialized. Docker Host IP: {HostIp}, NPM Networks: {Networks}, NPM host mode: {HostMode}",
            _detectedDockerHostIp ?? "not detected",
            _npmNetworks != null ? string.Join(", ", _npmNetworks) : "not detected",
            _npmIsHostNetwork);
    }

    private async Task DetectNpmNetworks(CancellationToken cancellationToken)
    {
        try
        {
            _logger.LogInformation("Looking for NPM container: {ContainerName}", _npmContainerName);

            var containers = await _dockerClient.Containers.ListContainersAsync(
                new ContainersListParameters { All = true },
                cancellationToken);

            var npmContainer = containers.FirstOrDefault(c =>
                c.Names.Any(n => n.TrimStart('/') == _npmContainerName) ||
                c.ID.StartsWith(_npmContainerName!));

            if (npmContainer == null)
            {
                _logger.LogWarning("NPM container '{Name}' not found", _npmContainerName);
                return;
            }

            var containerDetails = await _dockerClient.Containers.InspectContainerAsync(npmContainer.ID, cancellationToken);

            if (containerDetails.NetworkSettings?.Networks != null)
            {
                _npmNetworks = containerDetails.NetworkSettings.Networks.Keys.ToHashSet();
                _logger.LogInformation("NPM container found on networks: {Networks}",
                    string.Join(", ", _npmNetworks));
            }

            _npmIsHostNetwork = IsHostNetworkMode(containerDetails);
            if (_npmIsHostNetwork)
            {
                _logger.LogInformation(
                    "NPM container uses host networking — will forward to container bridge IPs (no published ports required)");
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error detecting NPM container networks");
        }
    }

    private async Task DetectDockerHostIp(CancellationToken cancellationToken)
    {
        try
        {
            // Strategy 1: Try host.docker.internal first (works on Docker Desktop and with --add-host)
            // This is the most reliable way to reach the host from a container
            if (await TestHostReachability("host.docker.internal", cancellationToken))
            {
                _detectedDockerHostIp = "host.docker.internal";
                _logger.LogInformation("Using host.docker.internal for Docker host");
                return;
            }

            // Strategy 2: Use Docker bridge gateway
            // Works if target ports are exposed on 0.0.0.0 (all interfaces)
            var networks = await _dockerClient.Networks.ListNetworksAsync(new NetworksListParameters(), cancellationToken);
            var bridgeNetwork = networks.FirstOrDefault(n => n.Name == "bridge");

            if (bridgeNetwork?.IPAM?.Config != null && bridgeNetwork.IPAM.Config.Count > 0)
            {
                var gateway = bridgeNetwork.IPAM.Config[0].Gateway;
                if (!string.IsNullOrEmpty(gateway))
                {
                    _detectedDockerHostIp = gateway;
                    _logger.LogInformation("Using Docker bridge gateway IP: {IP}", gateway);
                    _logger.LogWarning("Using bridge gateway. Ensure target ports are exposed on 0.0.0.0 or set DOCKER_HOST_IP env var");
                    return;
                }
            }

            // Strategy 3: Final fallback
            _detectedDockerHostIp = "host.docker.internal";
            _logger.LogWarning("Could not detect Docker host IP. Using 'host.docker.internal' - may not work on all systems");
            _logger.LogWarning("Consider setting DOCKER_HOST_IP environment variable to your host's IP address");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error detecting Docker host IP");
            _detectedDockerHostIp = "host.docker.internal";
        }
    }

    private async Task<bool> TestHostReachability(string hostname, CancellationToken cancellationToken)
    {
        try
        {
            // Try to resolve the hostname
            var addresses = await System.Net.Dns.GetHostAddressesAsync(hostname);
            return addresses.Length > 0;
        }
        catch
        {
            return false;
        }
    }

    public async Task<string> InferForwardHost(
        string containerId,
        string? explicitHost,
        CancellationToken cancellationToken,
        string? preferredNetwork = null)
    {
        // If explicitly provided, use it
        if (!string.IsNullOrEmpty(explicitHost))
            return explicitHost;

        try
        {
            // Get container details
            var container = await _dockerClient.Containers.InspectContainerAsync(containerId, cancellationToken);
            var containerName = container.Name.TrimStart('/');
            var containerNetworks = container.NetworkSettings?.Networks?.Keys.ToHashSet()
                ?? new HashSet<string>();
            var targetIsHostNetwork = IsHostNetworkMode(container);

            // NPMplus/GoDoxy-style host networking: the proxy shares the host netns and can
            // reach any container's bridge IP:internal-port without publishing ports.
            if (_npmIsHostNetwork)
            {
                if (targetIsHostNetwork)
                {
                    _logger.LogInformation(
                        "Container {ContainerName} also uses host networking. Using 127.0.0.1 as forward host.",
                        containerName);
                    return "127.0.0.1";
                }

                var hostModeIp = GetBestContainerIp(container, preferredNetwork);
                if (!string.IsNullOrEmpty(hostModeIp))
                {
                    _logger.LogInformation(
                        "NPM is host-networked. Using container IP {Ip} for {ContainerName} (no published port needed).",
                        hostModeIp, containerName);
                    return hostModeIp;
                }

                _logger.LogWarning(
                    "NPM is host-networked but no IP found for {ContainerName}; falling back to other strategies",
                    containerName);
            }

            // GoDoxy proxy.network: prefer that network when the container is attached
            if (!string.IsNullOrEmpty(preferredNetwork) && containerNetworks.Contains(preferredNetwork))
            {
                _logger.LogInformation(
                    "Container {ContainerName} preferred network {Network} present. Using container name as forward host.",
                    containerName, preferredNetwork);
                return containerName;
            }

            // Shared bridge/overlay networks (ignore "host"/"none" — those are not Docker DNS)
            if (_npmNetworks != null && containerNetworks.Count > 0)
            {
                var sharedNetworks = _npmNetworks
                    .Intersect(containerNetworks)
                    .Where(n => !IsPseudoNetwork(n))
                    .ToList();

                if (sharedNetworks.Count > 0)
                {
                    _logger.LogInformation("Container {ContainerName} shares network(s) with NPM: {Networks}. Using container name as forward host.",
                        containerName, string.Join(", ", sharedNetworks));
                    return containerName;
                }
            }

            // Different bridge networks: published host port path
            if (!string.IsNullOrEmpty(_detectedDockerHostIp))
            {
                _logger.LogInformation("Container {ContainerName} is not on NPM network. Using Docker host IP: {HostIp}",
                    containerName, _detectedDockerHostIp);
                return _detectedDockerHostIp;
            }

            // Fallback to container name (might not work, but it's a reasonable guess)
            _logger.LogWarning("Could not determine optimal forward host for {ContainerName}, using container name as fallback",
                containerName);
            return containerName;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error inferring forward host for container {ContainerId}", containerId);
            throw;
        }
    }

    /// <summary>
    /// Pick a routable container IP. Prefer <paramref name="preferredNetwork"/>, then
    /// user-defined networks over the default <c>bridge</c>.
    /// </summary>
    private static string? GetBestContainerIp(ContainerInspectResponse container, string? preferredNetwork)
    {
        var networks = container.NetworkSettings?.Networks;
        if (networks == null || networks.Count == 0)
            return null;

        static bool Usable(EndpointSettings? ep) =>
            ep != null &&
            !string.IsNullOrWhiteSpace(ep.IPAddress) &&
            ep.IPAddress != "0.0.0.0";

        if (!string.IsNullOrEmpty(preferredNetwork) &&
            networks.TryGetValue(preferredNetwork, out var preferred) &&
            Usable(preferred))
        {
            return preferred.IPAddress;
        }

        string? bridgeIp = null;
        foreach (var (name, endpoint) in networks)
        {
            if (IsPseudoNetwork(name) || !Usable(endpoint))
                continue;

            if (!string.Equals(name, "bridge", StringComparison.OrdinalIgnoreCase))
                return endpoint.IPAddress;

            bridgeIp ??= endpoint.IPAddress;
        }

        return bridgeIp;
    }

    private static bool IsHostNetworkMode(ContainerInspectResponse container)
    {
        var mode = container.HostConfig?.NetworkMode;
        if (!string.IsNullOrEmpty(mode) &&
            mode.Equals("host", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var networks = container.NetworkSettings?.Networks;
        return networks != null &&
               networks.Count > 0 &&
               networks.Keys.All(n => n.Equals("host", StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsPseudoNetwork(string name) =>
        name.Equals("host", StringComparison.OrdinalIgnoreCase) ||
        name.Equals("none", StringComparison.OrdinalIgnoreCase);

    public async Task<int?> InferForwardPort(string containerId, CancellationToken cancellationToken)
    {
        var candidates = await ListCandidatePortsAsync(containerId, cancellationToken);
        if (candidates.Count == 0)
            return null;

        var preferred = PreferPort(candidates);
        try
        {
            var container = await _dockerClient.Containers.InspectContainerAsync(containerId, cancellationToken);
            var containerName = container.Name.TrimStart('/');
            _logger.LogInformation("Container {ContainerName} auto-detected port: {Port} (from {Count} candidate(s))",
                containerName, preferred, candidates.Count);
        }
        catch
        {
            // ignore name lookup
        }

            return preferred;
    }

    /// <summary>
    /// Hostnames NPMplus might use to reach this container (DNS name, aliases, IPs, host gateway).
    /// </summary>
    public async Task<List<HostCandidate>> ListCandidateHostsAsync(string containerId, CancellationToken cancellationToken)
    {
        var results = new List<HostCandidate>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Add(string host, string label, string source)
        {
            host = host.Trim();
            if (string.IsNullOrEmpty(host) || !seen.Add(host)) return;
            results.Add(new HostCandidate { Host = host, Label = label, Source = source });
        }

        try
        {
            var container = await _dockerClient.Containers.InspectContainerAsync(containerId, cancellationToken);
            var containerName = container.Name.TrimStart('/');
            var networks = container.NetworkSettings?.Networks;

            var sharesNpm = false;
            if (_npmNetworks != null && networks != null)
            {
                sharesNpm = networks.Keys.Any(n =>
                    _npmNetworks.Contains(n) && !IsPseudoNetwork(n));
            }

            if (_npmIsHostNetwork && IsHostNetworkMode(container))
                Add("127.0.0.1", "Localhost (both host-networked)", "host-local");

            var bestIp = _npmIsHostNetwork ? GetBestContainerIp(container, null) : null;
            if (!string.IsNullOrEmpty(bestIp))
                Add(bestIp, "Container bridge IP (NPM host mode)", "host-mode-ip");

            Add(containerName,
                sharesNpm ? "Container DNS (shared network with NPM)" : "Container DNS name",
                sharesNpm ? "shared-network" : "container-name");

            if (networks != null)
            {
                foreach (var (netName, endpoint) in networks)
                {
                    if (endpoint.Aliases != null)
                    {
                        foreach (var alias in endpoint.Aliases)
                        {
                            if (string.Equals(alias, containerName, StringComparison.OrdinalIgnoreCase))
                                continue;
                            Add(alias, $"Network alias on {netName}", "alias");
                        }
                    }

                    var ip = endpoint.IPAddress;
                    if (!string.IsNullOrWhiteSpace(ip) && ip != "0.0.0.0")
                    {
                        var onNpm = _npmNetworks != null &&
                                    _npmNetworks.Contains(netName) &&
                                    !IsPseudoNetwork(netName);
                        Add(ip,
                            onNpm ? $"Container IP on {netName} (NPM network)" : $"Container IP on {netName}",
                            onNpm ? "shared-ip" : "ip");
                    }
                }
            }

            var dockerHost = _detectedDockerHostIp ?? _dockerHostIp;
            if (!string.IsNullOrWhiteSpace(dockerHost))
                Add(dockerHost, "Docker host IP / gateway", "docker-host");

            Add("host.docker.internal", "Docker Desktop host gateway", "host-gateway");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to list candidate hosts for {ContainerId}", containerId);
        }

        return results;
    }

    public string? DetectedDockerHostIp => _detectedDockerHostIp ?? _dockerHostIp;

    /// <summary>
    /// Candidate container-internal ports — does not require host port publishing (-p).
    /// Sources: EXPOSE, runtime port map keys, common env vars (PORT, …), image EXPOSE.
    /// </summary>
    public async Task<List<int>> ListCandidatePortsAsync(string containerId, CancellationToken cancellationToken)
    {
        var ports = new SortedSet<int>();
        try
        {
            var container = await _dockerClient.Containers.InspectContainerAsync(containerId, cancellationToken);

            AddExposedPortKeys(ports, container.Config?.ExposedPorts?.Keys);
            AddExposedPortKeys(ports, container.NetworkSettings?.Ports?.Keys);
            AddPortsFromEnv(ports, container.Config?.Env);

            // Image metadata often has EXPOSE even when the running config was stripped
            if (ports.Count == 0 && !string.IsNullOrWhiteSpace(container.Image))
            {
                try
                {
                    var image = await _dockerClient.Images.InspectImageAsync(container.Image, cancellationToken);
                    AddExposedPortKeys(ports, image.Config?.ExposedPorts?.Keys);
                    AddPortsFromEnv(ports, image.Config?.Env);
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Could not inspect image for port candidates on {ContainerId}", containerId);
                }
            }

            if (ports.Count == 0)
            {
                var name = container.Name.TrimStart('/');
                _logger.LogWarning(
                    "Container {ContainerName} has no EXPOSE/env/image ports. " +
                    "Add EXPOSE in the Dockerfile, set proxy.port / npm.proxy.port, or set PORT in the container env.",
                    name);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error listing candidate ports for container {ContainerId}", containerId);
        }

        return ports.ToList();
    }

    private static void AddExposedPortKeys(SortedSet<int> ports, IEnumerable<string>? keys)
    {
        if (keys == null)
            return;

        foreach (var key in keys)
        {
            var portStr = key.Split('/')[0];
            if (int.TryParse(portStr, out var port) && port is > 0 and < 65536)
                ports.Add(port);
        }
    }

    private static void AddPortsFromEnv(SortedSet<int> ports, IList<string>? env)
    {
        if (env == null)
            return;

        foreach (var entry in env)
        {
            var eq = entry.IndexOf('=');
            if (eq <= 0)
                continue;

            var key = entry[..eq];
            if (!IsPortEnvKey(key))
                continue;

            var value = entry[(eq + 1)..].Trim();
            // Support "8080" or "0.0.0.0:8080" or "tcp://:8080"
            var lastColon = value.LastIndexOf(':');
            if (lastColon >= 0 && lastColon < value.Length - 1)
                value = value[(lastColon + 1)..];

            if (int.TryParse(value, out var port) && port is > 0 and < 65536)
                ports.Add(port);
        }
    }

    private static bool IsPortEnvKey(string key) =>
        key.Equals("PORT", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("HTTP_PORT", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("HTTPS_PORT", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("SERVER_PORT", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("APP_PORT", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("WEB_PORT", StringComparison.OrdinalIgnoreCase) ||
        key.Equals("LISTEN_PORT", StringComparison.OrdinalIgnoreCase) ||
        key.EndsWith("_PORT", StringComparison.OrdinalIgnoreCase);

    private static int PreferPort(IReadOnlyList<int> candidates)
    {
        // Prefer typical HTTP app ports over high ephemeral / DB ports
        int[] preferred = [80, 8080, 3000, 8000, 5000, 443, 8443, 5173, 4200, 8096];
        foreach (var p in preferred)
        {
            if (candidates.Contains(p))
                return p;
        }

        // Prefer ports in common app range over databases (5432, 6379, …)
        var appish = candidates.FirstOrDefault(p => p is >= 80 and <= 9999 && p is not (5432 or 3306 or 6379 or 27017 or 11211));
        return appish != 0 ? appish : candidates[0];
    }

    public string? GetDockerHostIp() => _detectedDockerHostIp;
}
