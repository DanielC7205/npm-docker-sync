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

    /// <summary>
    /// Bare names (no protocol) become selfh.st CDN URLs: …/png/{slug}.png
    /// Full URLs, data URIs, and absolute paths are left unchanged.
    /// </summary>
    public static string? NormalizeIconUrl(string? icon)
    {
        if (string.IsNullOrWhiteSpace(icon))
            return null;

        var value = icon.Trim();
        if (value.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            value.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
            value.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
            value.StartsWith("/"))
            return value;

        var bare = Regex.Replace(value, @"\.(png|svg|webp)$", "", RegexOptions.IgnoreCase);
        var slug = ToSlug(bare);
        return string.IsNullOrEmpty(slug) ? null : CdnUrl(slug);
    }

    public async Task<string?> ResolveAsync(
        string? overrideIcon,
        string? labelIcon,
        string? displayName,
        string? containerName,
        CancellationToken cancellationToken)
    {
        var normalizedOverride = NormalizeIconUrl(overrideIcon);
        if (!string.IsNullOrWhiteSpace(normalizedOverride))
            return normalizedOverride;

        if (!string.IsNullOrWhiteSpace(labelIcon))
        {
            var label = labelIcon.Trim();
            if (label.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                label.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                label.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
                label.StartsWith("/"))
                return label;

            var fromLabel = NormalizeIconUrl(label);
            if (!string.IsNullOrEmpty(fromLabel) && await ExistsAsync(fromLabel, cancellationToken))
                return fromLabel;
        }

        foreach (var candidate in new[] { displayName, containerName })
        {
            var slug = ToSlug(candidate);
            if (string.IsNullOrEmpty(slug))
                continue;

            var url = CdnUrl(slug);
            if (await ExistsAsync(url, cancellationToken))
                return url;

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
