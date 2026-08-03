using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class KomodoClient
{
    private readonly SettingsStore _settings;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<KomodoClient> _logger;
    private readonly ConcurrentDictionary<string, (DateTime Expires, KomodoMatch? Match)> _cache = new();

    public KomodoClient(
        SettingsStore settings,
        IHttpClientFactory httpClientFactory,
        ILogger<KomodoClient> logger)
    {
        _settings = settings;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public bool IsConfigured()
    {
        return !string.IsNullOrWhiteSpace(_settings.Get("KOMODO_URL"))
               && !string.IsNullOrWhiteSpace(_settings.Get("KOMODO_SERVER"))
               && !string.IsNullOrWhiteSpace(_settings.Get("KOMODO_API_KEY"))
               && !string.IsNullOrWhiteSpace(_settings.Get("KOMODO_API_SECRET"));
    }

    public async Task<KomodoMatch?> FindResourceForContainerAsync(string containerNameOrId, CancellationToken cancellationToken)
    {
        if (!IsConfigured())
            return null;

        var cacheKey = containerNameOrId;
        if (_cache.TryGetValue(cacheKey, out var cached) && cached.Expires > DateTime.UtcNow)
            return cached.Match;

        try
        {
            var baseUrl = _settings.Get("KOMODO_URL")!.TrimEnd('/');
            var server = _settings.Get("KOMODO_SERVER")!;
            var client = _httpClientFactory.CreateClient(nameof(KomodoClient));

            using var req = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/read/GetResourceMatchingContainer");
            req.Headers.TryAddWithoutValidation("X-Api-Key", _settings.Get("KOMODO_API_KEY"));
            req.Headers.TryAddWithoutValidation("X-Api-Secret", _settings.Get("KOMODO_API_SECRET"));
            req.Content = JsonContent.Create(new { server, container = containerNameOrId });

            using var res = await client.SendAsync(req, cancellationToken);
            var body = await res.Content.ReadAsStringAsync(cancellationToken);
            if (!res.IsSuccessStatusCode)
            {
                _logger.LogDebug("Komodo lookup failed for {Container}: {Status} {Body}",
                    containerNameOrId, (int)res.StatusCode, body.Length > 200 ? body[..200] : body);
                _cache[cacheKey] = (DateTime.UtcNow.AddMinutes(2), null);
                return null;
            }

            var match = ParseMatch(body, baseUrl);
            _cache[cacheKey] = (DateTime.UtcNow.AddMinutes(5), match);
            return match;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Komodo lookup error for {Container}", containerNameOrId);
            _cache[cacheKey] = (DateTime.UtcNow.AddMinutes(2), null);
            return null;
        }
    }

    private static KomodoMatch? ParseMatch(string body, string baseUrl)
    {
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;

        // Response shapes vary; try common fields
        string? type = null;
        string? id = null;
        string? name = null;

        if (root.TryGetProperty("type", out var typeEl))
            type = typeEl.GetString();
        if (root.TryGetProperty("resource_type", out var rt))
            type ??= rt.GetString();

        if (root.TryGetProperty("id", out var idEl))
            id = idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : idEl.ToString();
        if (root.TryGetProperty("name", out var nameEl))
            name = nameEl.GetString();

        if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
        {
            if (data.TryGetProperty("type", out var dt))
                type ??= dt.GetString();
            if (data.TryGetProperty("id", out var di))
                id ??= di.ValueKind == JsonValueKind.String ? di.GetString() : di.ToString();
            if (data.TryGetProperty("name", out var dn))
                name ??= dn.GetString();
        }

        // Nested resource object
        foreach (var prop in new[] { "stack", "deployment", "resource" })
        {
            if (!root.TryGetProperty(prop, out var nested) || nested.ValueKind != JsonValueKind.Object)
                continue;
            type ??= prop;
            if (nested.TryGetProperty("id", out var ni))
                id ??= ni.ValueKind == JsonValueKind.String ? ni.GetString() : ni.ToString();
            if (nested.TryGetProperty("name", out var nn))
                name ??= nn.GetString();
        }

        if (string.IsNullOrWhiteSpace(name) && string.IsNullOrWhiteSpace(id))
            return null;

        type ??= "stack";
        var display = name ?? id!;
        var path = type.Contains("deploy", StringComparison.OrdinalIgnoreCase)
            ? $"/deployments/{Uri.EscapeDataString(display)}"
            : $"/stacks/{Uri.EscapeDataString(display)}";

        return new KomodoMatch
        {
            ResourceType = type,
            ResourceId = id,
            ResourceName = name,
            Url = $"{baseUrl}{path}",
        };
    }
}

public class KomodoMatch
{
    public string ResourceType { get; set; } = "stack";
    public string? ResourceId { get; set; }
    public string? ResourceName { get; set; }
    public string Url { get; set; } = string.Empty;
}
