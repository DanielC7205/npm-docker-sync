using System.Text.Json;

namespace NpmDockerSync.Services;

/// <summary>
/// Persists UI route overrides in NPM proxy host meta so names/icons/SSL survive SQLite loss or redeploys.
/// </summary>
public static class RouteOverrideMeta
{
    public const string MetaKey = "ui_route_override";

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    public static void Attach(Dictionary<string, object> meta, RouteOverride? overrideData)
    {
        if (overrideData == null)
            return;

        meta[MetaKey] = JsonSerializer.Serialize(overrideData, JsonOpts);
    }

    public static RouteOverride? TryParse(ProxyHost host)
    {
        if (host.Meta == null || !host.Meta.TryGetValue(MetaKey, out var raw) || raw == null)
            return null;

        try
        {
            var json = raw switch
            {
                string s => s,
                System.Text.Json.JsonElement je => je.GetRawText(),
                _ => raw.ToString() ?? string.Empty,
            };

            if (string.IsNullOrWhiteSpace(json))
                return null;

            return JsonSerializer.Deserialize<RouteOverride>(json, JsonOpts);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Fills empty override fields from NPM-backed copy (SQLite wins when already set).</summary>
    public static void MergeMissingFields(RouteOverride target, RouteOverride source)
    {
        if (string.IsNullOrWhiteSpace(target.DisplayName) && !string.IsNullOrWhiteSpace(source.DisplayName))
            target.DisplayName = source.DisplayName;
        if ((target.Domains == null || target.Domains.Count == 0) && source.Domains is { Count: > 0 })
            target.Domains = source.Domains.ToList();
        if (!target.Hidden.HasValue && source.Hidden.HasValue)
            target.Hidden = source.Hidden;
        if (string.IsNullOrWhiteSpace(target.ForwardHost) && !string.IsNullOrWhiteSpace(source.ForwardHost))
            target.ForwardHost = source.ForwardHost;
        if (!target.ForwardPort.HasValue && source.ForwardPort.HasValue)
            target.ForwardPort = source.ForwardPort;
        if (string.IsNullOrWhiteSpace(target.ForwardScheme) && !string.IsNullOrWhiteSpace(source.ForwardScheme))
            target.ForwardScheme = source.ForwardScheme;
        if (!target.SslForced.HasValue && source.SslForced.HasValue)
            target.SslForced = source.SslForced;
        if (!target.Http2Support.HasValue && source.Http2Support.HasValue)
            target.Http2Support = source.Http2Support;
        if (!target.HstsEnabled.HasValue && source.HstsEnabled.HasValue)
            target.HstsEnabled = source.HstsEnabled;
        if (!target.HstsSubdomains.HasValue && source.HstsSubdomains.HasValue)
            target.HstsSubdomains = source.HstsSubdomains;
        if (!target.AllowWebsocketUpgrade.HasValue && source.AllowWebsocketUpgrade.HasValue)
            target.AllowWebsocketUpgrade = source.AllowWebsocketUpgrade;
        if (!target.CachingEnabled.HasValue && source.CachingEnabled.HasValue)
            target.CachingEnabled = source.CachingEnabled;
        if (!target.BlockExploits.HasValue && source.BlockExploits.HasValue)
            target.BlockExploits = source.BlockExploits;
        if (!target.CertificateId.HasValue && source.CertificateId is > 0)
            target.CertificateId = source.CertificateId;
        if (string.IsNullOrWhiteSpace(target.AuthRequest) && !string.IsNullOrWhiteSpace(source.AuthRequest))
            target.AuthRequest = source.AuthRequest;
        if (target.AuthRequestUpstream == null && source.AuthRequestUpstream != null)
            target.AuthRequestUpstream = source.AuthRequestUpstream;
        if (!target.AuthExempt.HasValue && source.AuthExempt.HasValue)
            target.AuthExempt = source.AuthExempt;
        if (string.IsNullOrWhiteSpace(target.Icon) && !string.IsNullOrWhiteSpace(source.Icon))
            target.Icon = source.Icon;
        if (string.IsNullOrWhiteSpace(target.AdvancedConfig) && !string.IsNullOrWhiteSpace(source.AdvancedConfig))
            target.AdvancedConfig = source.AdvancedConfig;
        if (target.Locations == null && source.Locations != null)
            target.Locations = source.Locations;
        if (target.Manual != true && source.Manual == true)
            target.Manual = true;
    }
}
