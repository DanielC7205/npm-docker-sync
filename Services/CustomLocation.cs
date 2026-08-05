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

/// <summary>Typed NPM / NPMplus location payload.</summary>
public class ProxyLocationRequest
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = "/";

    [JsonPropertyName("forward_scheme")]
    public string ForwardScheme { get; set; } = "http";

    [JsonPropertyName("forward_host")]
    public string ForwardHost { get; set; } = string.Empty;

    [JsonPropertyName("forward_port")]
    public int ForwardPort { get; set; }

    /// <summary>
    /// Classic NPM path rewrite. NPMplus location schema uses additionalProperties:false
    /// and does not allow forward_path, so this is never serialized on the wire.
    /// </summary>
    [JsonIgnore]
    public string? ForwardPath { get; set; }

    [JsonPropertyName("npmplus_access_list_ids")]
    public List<int>? NpmplusAccessListIds { get; set; } = new();

    [JsonPropertyName("npmplus_access_list_type")]
    public string? NpmplusAccessListType { get; set; } = "public";

    [JsonPropertyName("advanced_config")]
    public string? AdvancedConfig { get; set; } = string.Empty;
}

public class HostCandidate
{
    public string Host { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string Source { get; set; } = string.Empty;
}
