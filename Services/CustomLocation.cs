using System.Text.Json.Serialization;

namespace NpmDockerSync.Services;

/// <summary>
/// UI / override model for an NPM custom location (path-based upstream).
/// Linked mode resolves host/port/scheme from another route at sync time.
/// </summary>
public class CustomLocation
{
    /// <summary>"manual" or "linked"</summary>
    public string Mode { get; set; } = "manual";

    public string Path { get; set; } = "/";

    public string? ForwardScheme { get; set; }
    public string? ForwardHost { get; set; }
    public int? ForwardPort { get; set; }

    /// <summary>Optional path rewrite on the upstream (classic NPM forward_path).</summary>
    public string? ForwardPath { get; set; }

    public string? LinkedContainerId { get; set; }
    public int? LinkedProxyIndex { get; set; }
}

/// <summary>
/// NPMplus custom location payload. Shape matches the Proxy Hosts UI PUT body
/// (see ZoeyVid/NPMplus location schema — additionalProperties: false).
/// </summary>
public class ProxyLocationRequest
{
    [JsonPropertyName("id")]
    public int? Id { get; set; }

    [JsonPropertyName("npmplus_enabled")]
    public bool NpmplusEnabled { get; set; } = true;

    [JsonPropertyName("path")]
    public string Path { get; set; } = "/";

    [JsonPropertyName("location_type")]
    public string LocationType { get; set; } = string.Empty;

    [JsonPropertyName("advanced_config")]
    public string AdvancedConfig { get; set; } = string.Empty;

    [JsonPropertyName("forward_scheme")]
    public string ForwardScheme { get; set; } = "http";

    [JsonPropertyName("forward_host")]
    public string ForwardHost { get; set; } = string.Empty;

    [JsonPropertyName("forward_port")]
    public int ForwardPort { get; set; }

    /// <summary>
    /// Classic NPM path rewrite. Not in the NPMplus location schema — never serialized.
    /// </summary>
    [JsonIgnore]
    public string? ForwardPath { get; set; }

    [JsonPropertyName("npmplus_access_list_ids")]
    public List<int> NpmplusAccessListIds { get; set; } = new();

    [JsonPropertyName("caching_enabled")]
    public bool CachingEnabled { get; set; }

    [JsonPropertyName("block_exploits")]
    public bool BlockExploits { get; set; }

    [JsonPropertyName("allow_websocket_upgrade")]
    public bool AllowWebsocketUpgrade { get; set; } = true;

    [JsonPropertyName("npmplus_noindex")]
    public bool NpmplusNoindex { get; set; }

    [JsonPropertyName("npmplus_crowdsec_appsec")]
    public bool NpmplusCrowdsecAppsec { get; set; }

    [JsonPropertyName("npmplus_proxy_response_buffering")]
    public bool NpmplusProxyResponseBuffering { get; set; }

    [JsonPropertyName("npmplus_proxy_request_buffering")]
    public bool NpmplusProxyRequestBuffering { get; set; }

    [JsonPropertyName("npmplus_disable_uri_sanitisation")]
    public bool NpmplusDisableUriSanitisation { get; set; }

    [JsonPropertyName("npmplus_spoof_host_header")]
    public bool NpmplusSpoofHostHeader { get; set; }

    [JsonPropertyName("npmplus_upstream_compression")]
    public bool NpmplusUpstreamCompression { get; set; }

    [JsonPropertyName("npmplus_fancyindex")]
    public bool NpmplusFancyindex { get; set; }

    [JsonPropertyName("npmplus_x_frame_options")]
    public string NpmplusXFrameOptions { get; set; } = "SAMEORIGIN";

    [JsonPropertyName("npmplus_auth_request")]
    public string NpmplusAuthRequest { get; set; } = "none";

    [JsonPropertyName("npmplus_auth_request_upstream")]
    public string NpmplusAuthRequestUpstream { get; set; } = string.Empty;

    /// <summary>
    /// Location ACL mode. UI default is "global" (inherit host ACL). Also: public, custom.
    /// </summary>
    [JsonPropertyName("npmplus_access_list_type")]
    public string NpmplusAccessListType { get; set; } = "global";

    /// <summary>Build a location with the same defaults the NPMplus web UI sends.</summary>
    public static ProxyLocationRequest Create(
        string path,
        string forwardScheme,
        string forwardHost,
        int forwardPort,
        string? forwardPath = null)
    {
        return new ProxyLocationRequest
        {
            Id = null,
            NpmplusEnabled = true,
            Path = string.IsNullOrWhiteSpace(path) ? "/" : path.Trim(),
            LocationType = string.Empty,
            AdvancedConfig = string.Empty,
            ForwardScheme = string.IsNullOrWhiteSpace(forwardScheme) ? "http" : forwardScheme.Trim().ToLowerInvariant(),
            ForwardHost = forwardHost?.Trim() ?? string.Empty,
            ForwardPort = forwardPort,
            ForwardPath = string.IsNullOrWhiteSpace(forwardPath) ? null : forwardPath.Trim(),
            NpmplusAccessListIds = new List<int>(),
            CachingEnabled = false,
            BlockExploits = false,
            AllowWebsocketUpgrade = true,
            NpmplusNoindex = false,
            NpmplusCrowdsecAppsec = false,
            NpmplusProxyResponseBuffering = false,
            NpmplusProxyRequestBuffering = false,
            NpmplusDisableUriSanitisation = false,
            NpmplusSpoofHostHeader = false,
            NpmplusUpstreamCompression = false,
            NpmplusFancyindex = false,
            NpmplusXFrameOptions = "SAMEORIGIN",
            NpmplusAuthRequest = "none",
            NpmplusAuthRequestUpstream = string.Empty,
            NpmplusAccessListType = "global",
        };
    }

    /// <summary>Fill any missing NPMplus-required fields after deserialize / round-trip.</summary>
    public void EnsureNpmplusDefaults()
    {
        NpmplusAccessListIds ??= new List<int>();
        if (string.IsNullOrWhiteSpace(NpmplusAccessListType))
            NpmplusAccessListType = "global";
        AdvancedConfig ??= string.Empty;
        LocationType ??= string.Empty;
        if (string.IsNullOrWhiteSpace(NpmplusXFrameOptions))
            NpmplusXFrameOptions = "SAMEORIGIN";
        if (string.IsNullOrWhiteSpace(NpmplusAuthRequest))
            NpmplusAuthRequest = "none";
        NpmplusAuthRequestUpstream ??= string.Empty;
    }
}

public class HostCandidate
{
    public string Host { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string Source { get; set; } = string.Empty;
}
