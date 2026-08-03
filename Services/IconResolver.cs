using System.Collections.Concurrent;
using System.Net.Http;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class IconResolver
{
    private static readonly Regex NonAlnum = new(@"[^a-z0-9]+", RegexOptions.Compiled);
    private readonly HttpClient _httpClient;
    private readonly ILogger<IconResolver> _logger;
    private readonly ConcurrentDictionary<string, bool> _probeCache = new(StringComparer.OrdinalIgnoreCase);

    public IconResolver(HttpClient httpClient, ILogger<IconResolver> logger)
    {
        _httpClient = httpClient;
        _logger = logger;
        _httpClient.Timeout = TimeSpan.FromSeconds(3);
    }

    public static string ToSlug(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return string.Empty;
        var slug = NonAlnum.Replace(name.Trim().ToLowerInvariant(), "-").Trim('-');
        return slug;
    }

    public static string CdnUrl(string slug, string format = "png") =>
        $"https://cdn.jsdelivr.net/gh/selfhst/icons/{format}/{slug}.{format}";

    public async Task<string?> ResolveAsync(
        string? overrideIcon,
        string? labelIcon,
        string? displayName,
        string? containerName,
        CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(overrideIcon))
            return overrideIcon.Trim();

        if (!string.IsNullOrWhiteSpace(labelIcon))
        {
            var label = labelIcon.Trim();
            if (label.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                label.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                label.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
                label.StartsWith("/"))
                return label;

            // Treat plain names as selfh.st references
            var fromLabel = ToSlug(label);
            if (!string.IsNullOrEmpty(fromLabel))
            {
                var url = CdnUrl(fromLabel);
                if (await ExistsAsync(url, cancellationToken))
                    return url;
            }
        }

        foreach (var candidate in new[] { displayName, containerName })
        {
            var slug = ToSlug(candidate);
            if (string.IsNullOrEmpty(slug))
                continue;

            var url = CdnUrl(slug);
            if (await ExistsAsync(url, cancellationToken))
                return url;

            // Strip common docker compose suffixes: -1, _server, etc.
            var trimmed = Regex.Replace(slug, @"-(server|frontend|backend|core|app|web|\d+)$", "");
            if (trimmed != slug && !string.IsNullOrEmpty(trimmed))
            {
                url = CdnUrl(trimmed);
                if (await ExistsAsync(url, cancellationToken))
                    return url;
            }
        }

        return null;
    }

    private async Task<bool> ExistsAsync(string url, CancellationToken cancellationToken)
    {
        if (_probeCache.TryGetValue(url, out var cached))
            return cached;

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Head, url);
            using var res = await _httpClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            var ok = res.IsSuccessStatusCode;
            _probeCache[url] = ok;
            return ok;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Icon probe failed for {Url}", url);
            _probeCache[url] = false;
            return false;
        }
    }
}
