using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class DockerMonitorService : BackgroundService
{
    private readonly ILogger<DockerMonitorService> _logger;
    private readonly DockerClient _dockerClient;
    private readonly SyncOrchestrator _syncOrchestrator;
    private readonly DockerNetworkService _networkService;
    private readonly SettingsStore _settings;
    private readonly string _dockerHost;

    public DockerMonitorService(
        ILogger<DockerMonitorService> logger,
        SyncOrchestrator syncOrchestrator,
        DockerNetworkService networkService,
        SettingsStore settings,
        IConfiguration configuration)
    {
        _logger = logger;
        _syncOrchestrator = syncOrchestrator;
        _networkService = networkService;
        _settings = settings;
        _dockerHost = configuration["DOCKER_HOST"] ?? "unix:///var/run/docker.sock";

        _dockerClient = new DockerClientConfiguration(new Uri(_dockerHost))
            .CreateClient();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Docker Monitor Service starting. Connecting to: {DockerHost}", _dockerHost);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await _networkService.InitializeAsync(stoppingToken);
                await RestoreStateWithRetry(stoppingToken);
                await PerformInitialScan(stoppingToken);
                await MonitorDockerEvents(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Docker Monitor Service error; retrying in 10s (web UI stays available)");
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }
    }

    private async Task RestoreStateWithRetry(CancellationToken stoppingToken)
    {
        var attempt = 0;
        while (!stoppingToken.IsCancellationRequested)
        {
            attempt++;
            try
            {
                await _syncOrchestrator.RestoreStateFromNpm(_dockerClient, stoppingToken);
                return;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                var delay = TimeSpan.FromSeconds(Math.Min(30, 3 * attempt));
                _logger.LogWarning(ex,
                    "Failed to reach NPMplus/NPM (attempt {Attempt}). Retrying in {DelaySeconds}s. " +
                    "If using HTTPS with a self-signed cert, set NPM_TLS_SKIP_VERIFY=true.",
                    attempt, delay.TotalSeconds);
                await Task.Delay(delay, stoppingToken);
            }
        }
    }

    private async Task PerformInitialScan(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Performing initial scan of containers");

        var containers = await _dockerClient.Containers.ListContainersAsync(
            new ContainersListParameters { All = false },
            stoppingToken);

        var autoBridge = _settings.GetBool("AUTO_BRIDGE_EXPOSED");
        var processed = 0;
        foreach (var container in containers)
        {
            var labels = container.Labels ?? new Dictionary<string, string>();
            var containerName = container.Names.FirstOrDefault()?.TrimStart('/') ?? container.ID;

            if (HasProxyLabels(labels) || autoBridge)
            {
                _logger.LogInformation("Found container for sync: {ContainerName}", containerName);
                await _syncOrchestrator.ProcessContainer(container.ID, containerName, labels, stoppingToken);
                processed++;
            }
        }

        _logger.LogInformation("Initial scan completed. Processed {Count} containers", processed);
    }

    private async Task MonitorDockerEvents(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Starting Docker event monitoring");

        var eventParameters = new ContainerEventsParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                ["type"] = new Dictionary<string, bool> { ["container"] = true }
            }
        };

        var progress = new Progress<Message>(message =>
        {
            try
            {
                if (message.Type == "container")
                {
                    HandleContainerEvent(message, stoppingToken).GetAwaiter().GetResult();
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error handling Docker event: {Action} for {ID}",
                    message.Action, message.Actor?.ID);
            }
        });

        await _dockerClient.System.MonitorEventsAsync(eventParameters, progress, stoppingToken);
    }

    private async Task HandleContainerEvent(Message message, CancellationToken stoppingToken)
    {
        var action = message.Action;
        var containerId = message.Actor?.ID;

        if (string.IsNullOrEmpty(containerId))
            return;

        _logger.LogDebug("Container event: {Action} for {ContainerId}", action, containerId);

        if (action is "start" or "update")
        {
            try
            {
                var container = await _dockerClient.Containers.InspectContainerAsync(containerId, stoppingToken);
                var labels = container.Config?.Labels ?? new Dictionary<string, string>();
                var containerName = container.Name.TrimStart('/');

                if (HasProxyLabels(labels) || _settings.GetBool("AUTO_BRIDGE_EXPOSED"))
                {
                    _logger.LogInformation("Container {Name} {Action}", containerName, action);
                    await _syncOrchestrator.ProcessContainer(containerId, containerName, labels, stoppingToken);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error inspecting container {ContainerId} for {Action} event", containerId, action);
            }
        }
        else if (action is "stop" or "die" or "destroy")
        {
            var containerName = containerId;
            if (message.Actor?.Attributes != null && message.Actor.Attributes.TryGetValue("name", out var name))
            {
                containerName = name;
            }
            _logger.LogInformation("Container stopped/removed: {ContainerName}", containerName);
            await _syncOrchestrator.RemoveContainer(containerId, containerName, stoppingToken);
        }
    }

    private static bool HasProxyLabels(IDictionary<string, string> labels) =>
        labels.Any(l =>
            l.Key.StartsWith("npm.") ||
            l.Key.StartsWith("npm-") ||
            l.Key.StartsWith("proxy.", StringComparison.OrdinalIgnoreCase));

    public override void Dispose()
    {
        _dockerClient?.Dispose();
        base.Dispose();
    }
}
