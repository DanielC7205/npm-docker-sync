using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class NginxProxyManagerClient
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<NginxProxyManagerClient> _logger;
    private readonly string _baseUrl;
    private readonly string _email;
    private readonly string _password;
    private string? _token;
    private string? _sessionCookieHeader;
    private DateTime _tokenExpiry = DateTime.MinValue;

    public NginxProxyManagerClient(
        HttpClient httpClient,
        ILogger<NginxProxyManagerClient> logger,
        IConfiguration configuration)
    {
        _httpClient = httpClient;
        _logger = logger;

        var rawUrl = configuration["NPM_URL"] ?? throw new ArgumentException("NPM_URL is required");
        _baseUrl = UrlNormalizer.Normalize(rawUrl);
        _email = configuration["NPM_EMAIL"] ?? throw new ArgumentException("NPM_EMAIL is required");
        _password = configuration["NPM_PASSWORD"] ?? throw new ArgumentException("NPM_PASSWORD is required");

        _httpClient.BaseAddress = new Uri(_baseUrl);

        if (IsTruthy(configuration["NPM_TLS_SKIP_VERIFY"]))
        {
            _logger.LogWarning("NPM_TLS_SKIP_VERIFY is enabled — TLS certificate validation is disabled for NPM API calls");
        }

        _logger.LogInformation("NPM API base URL: {BaseUrl}", _baseUrl);
    }

    private static bool IsTruthy(string? value) =>
        value?.ToLowerInvariant() is "true" or "1" or "yes" or "on";

    private async Task EnsureAuthenticated(CancellationToken cancellationToken)
    {
        if ((!string.IsNullOrEmpty(_token) || !string.IsNullOrEmpty(_sessionCookieHeader)) &&
            DateTime.UtcNow < _tokenExpiry)
            return;

        _logger.LogInformation("Authenticating with NPMplus / NPM at {BaseUrl}", _baseUrl);

        var loginRequest = new
        {
            identity = _email,
            secret = _password
        };

        var response = await _httpClient.PostAsJsonAsync("/api/tokens", loginRequest, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogError(
                "NPMplus/NPM authentication failed: {StatusCode} {Reason}. Body: {Body}",
                (int)response.StatusCode,
                response.ReasonPhrase,
                Truncate(body, 500));
            throw new HttpRequestException(
                $"NPMplus/NPM authentication failed: {(int)response.StatusCode} {response.ReasonPhrase}. Body: {Truncate(body, 200)}");
        }

        // Classic NPM returns { "token": "...", "expires": "..." }
        TokenResponse? result = null;
        try
        {
            result = JsonSerializer.Deserialize<TokenResponse>(body, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Auth response was not classic NPM JSON token payload");
        }

        // NPMplus sets an HttpOnly session cookie and may omit token from the JSON body
        var cookies = ExtractCookies(response);
        _sessionCookieHeader = cookies.Count > 0 ? string.Join("; ", cookies.Select(c => $"{c.Name}={c.Value}")) : null;

        _token = result?.Token
                 ?? cookies.FirstOrDefault(c =>
                        c.Name.Contains("token", StringComparison.OrdinalIgnoreCase) &&
                        c.Value.StartsWith("eyJ", StringComparison.Ordinal)).Value;

        if (string.IsNullOrEmpty(_token) && string.IsNullOrEmpty(_sessionCookieHeader))
        {
            _logger.LogError(
                "Authentication succeeded but no token/cookie was returned. Body: {Body}; Set-Cookie present: {HasCookies}",
                Truncate(body, 500),
                response.Headers.Contains("Set-Cookie"));
            throw new Exception($"Failed to obtain authentication token/cookie. Response: {Truncate(body, 200)}");
        }

        if (!string.IsNullOrEmpty(result?.Expires) && DateTime.TryParse(result.Expires, out var expiresAt))
            _tokenExpiry = expiresAt.ToUniversalTime();
        else
            _tokenExpiry = DateTime.UtcNow.AddHours(23);

        ApplyAuthHeaders();

        _logger.LogInformation(
            "Successfully authenticated with NPMplus / NPM (bearer={HasBearer}, cookie={HasCookie})",
            !string.IsNullOrEmpty(_token),
            !string.IsNullOrEmpty(_sessionCookieHeader));
    }

    private void ApplyAuthHeaders()
    {
        _httpClient.DefaultRequestHeaders.Authorization = null;
        _httpClient.DefaultRequestHeaders.Remove("Cookie");

        if (!string.IsNullOrEmpty(_token))
            _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _token);

        if (!string.IsNullOrEmpty(_sessionCookieHeader))
            _httpClient.DefaultRequestHeaders.TryAddWithoutValidation("Cookie", _sessionCookieHeader);
    }

    private static List<(string Name, string Value)> ExtractCookies(HttpResponseMessage response)
    {
        var cookies = new List<(string Name, string Value)>();

        // Prefer NonValidated — HttpClient may hide Set-Cookie from the typed Headers collection
        if (response.Headers.NonValidated.TryGetValues("Set-Cookie", out var setCookies))
        {
            foreach (var setCookie in setCookies)
            {
                var firstSegment = setCookie.Split(';', 2)[0];
                var eq = firstSegment.IndexOf('=');
                if (eq <= 0)
                    continue;

                var name = firstSegment[..eq].Trim();
                var value = firstSegment[(eq + 1)..].Trim();
                if (name.Length > 0 && value.Length > 0)
                    cookies.Add((name, value));
            }
        }

        return cookies;
    }

    private static string Truncate(string value, int max) =>
        string.IsNullOrEmpty(value) ? string.Empty :
        value.Length <= max ? value : value[..max] + "...";

    public async Task<List<ProxyHost>> GetProxyHostsAsync(CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);

        var response = await _httpClient.GetAsync("/api/nginx/proxy-hosts", cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogError("Failed to list proxy hosts: {Status} {Body}",
                (int)response.StatusCode, Truncate(body, 500));
            response.EnsureSuccessStatusCode();
        }

        var hosts = DeserializeProxyHostList(body);
        _logger.LogInformation("Listed {Count} proxy host(s) from NPM", hosts.Count);
        if (hosts.Count > 0 && _logger.IsEnabled(LogLevel.Debug))
        {
            var sample = hosts.Take(5).Select(h =>
                $"#{h.Id}:[{string.Join(",", h.DomainNames ?? new List<string>())}]");
            _logger.LogDebug("Proxy host sample: {Sample}", string.Join("; ", sample));
        }

        return hosts;
    }

    private List<ProxyHost> DeserializeProxyHostList(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
            return new List<ProxyHost>();

        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        try
        {
            // Classic NPM / NPMplus: raw array
            if (body.TrimStart().StartsWith('['))
            {
                return JsonSerializer.Deserialize<List<ProxyHost>>(body, options) ?? new List<ProxyHost>();
            }

            // Some forks wrap as { "data": [ ... ] }
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                doc.RootElement.TryGetProperty("data", out var data) &&
                data.ValueKind == JsonValueKind.Array)
            {
                return JsonSerializer.Deserialize<List<ProxyHost>>(data.GetRawText(), options)
                       ?? new List<ProxyHost>();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialize proxy host list. Body: {Body}", Truncate(body, 500));
            throw;
        }

        _logger.LogWarning("Unexpected proxy-hosts response shape. Body: {Body}", Truncate(body, 300));
        return new List<ProxyHost>();
    }

    public async Task<ProxyHost?> GetProxyHostByDomainAsync(string domain, CancellationToken cancellationToken)
    {
        var hosts = await GetProxyHostsAsync(cancellationToken);

        var exactMatch = hosts.FirstOrDefault(h =>
            h.DomainNames?.Any(d => string.Equals(d, domain, StringComparison.OrdinalIgnoreCase)) == true);

        if (exactMatch != null)
        {
            _logger.LogDebug("Found exact match for domain {Domain} in proxy host {HostId}", domain, exactMatch.Id);
            return exactMatch;
        }

        _logger.LogDebug("No proxy host found for domain {Domain} (searched {Count} hosts)", domain, hosts.Count);
        return null;
    }

    public async Task<ProxyHost?> GetProxyHostByDomainsAsync(IEnumerable<string> domains, CancellationToken cancellationToken)
    {
        var hosts = await GetProxyHostsAsync(cancellationToken);
        var domainList = domains.ToList();

        var matchingHost = hosts.FirstOrDefault(h =>
            h.DomainNames?.Any(hostDomain =>
                domainList.Any(d => string.Equals(d, hostDomain, StringComparison.OrdinalIgnoreCase))) == true);

        if (matchingHost != null)
        {
            _logger.LogInformation(
                "Found proxy host {HostId} overlapping domains: host=[{HostDomains}] search=[{SearchDomains}]",
                matchingHost.Id,
                string.Join(", ", matchingHost.DomainNames ?? new List<string>()),
                string.Join(", ", domainList));
        }
        else
        {
            _logger.LogInformation(
                "No proxy host found for domains [{Domains}] (searched {Count} hosts)",
                string.Join(", ", domainList), hosts.Count);
        }

        return matchingHost;
    }

    public async Task<ProxyHost?> GetProxyHostByIdAsync(int hostId, CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);

        try
        {
            var response = await _httpClient.GetAsync($"/api/nginx/proxy-hosts/{hostId}", cancellationToken);
            response.EnsureSuccessStatusCode();

            var host = await response.Content.ReadFromJsonAsync<ProxyHost>(cancellationToken);
            return host;
        }
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            _logger.LogDebug("Proxy host {HostId} not found", hostId);
            return null;
        }
    }

    public async Task<ProxyHost> CreateProxyHostAsync(ProxyHostRequest request, CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);
        NormalizeLocationsForNpmplus(request);

        _logger.LogInformation("Creating proxy host for domains: {Domains}", string.Join(", ", request.DomainNames));

        var response = await _httpClient.PostAsJsonAsync("/api/nginx/proxy-hosts", request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Failed to create proxy host ({(int)response.StatusCode} {response.ReasonPhrase}): {Truncate(body, 500)}",
                null,
                response.StatusCode);
        }

        var result = JsonSerializer.Deserialize<ProxyHost>(body, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });
        return result ?? throw new Exception("Failed to create proxy host");
    }

    public async Task<ProxyHost> UpdateProxyHostAsync(int hostId, ProxyHostRequest request, CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);
        NormalizeLocationsForNpmplus(request);

        _logger.LogInformation("Updating proxy host {HostId} for domains: {Domains}",
            hostId, string.Join(", ", request.DomainNames));

        var response = await _httpClient.PutAsJsonAsync($"/api/nginx/proxy-hosts/{hostId}", request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Failed to update proxy host {hostId} ({(int)response.StatusCode} {response.ReasonPhrase}): {Truncate(body, 500)}",
                null,
                response.StatusCode);
        }

        var result = JsonSerializer.Deserialize<ProxyHost>(body, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });
        return result ?? throw new Exception("Failed to update proxy host");
    }

    /// <summary>
    /// NPMplus location schema requires npmplus_access_list_* and rejects unknown props (e.g. forward_path).
    /// </summary>
    private static void NormalizeLocationsForNpmplus(ProxyHostRequest request)
    {
        foreach (var loc in request.Locations)
        {
            loc.NpmplusAccessListIds ??= new List<int>();
            if (string.IsNullOrWhiteSpace(loc.NpmplusAccessListType))
                loc.NpmplusAccessListType = "public";
            loc.AdvancedConfig ??= string.Empty;
        }
    }

    public async Task DeleteProxyHostAsync(int hostId, CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);

        _logger.LogInformation("Deleting proxy host {HostId}", hostId);

        var response = await _httpClient.DeleteAsync($"/api/nginx/proxy-hosts/{hostId}", cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    public async Task<ProxyHost> SetProxyHostEnabledAsync(int hostId, bool enabled, CancellationToken cancellationToken)
    {
        var existing = await GetProxyHostByIdAsync(hostId, cancellationToken)
            ?? throw new InvalidOperationException($"Proxy host {hostId} not found");

        var meta = existing.Meta != null
            ? new Dictionary<string, object>(existing.Meta)
            : new Dictionary<string, object>();
        meta["ui_disabled"] = !enabled;

        var accessListIds = existing.NpmplusAccessListIds ?? new List<int>();
        if (accessListIds.Count == 0 && existing.AccessListId is > 0)
            accessListIds = new List<int> { existing.AccessListId.Value };

        var request = new ProxyHostRequest
        {
            DomainNames = existing.DomainNames ?? new List<string>(),
            ForwardScheme = existing.ForwardScheme ?? "http",
            ForwardHost = existing.ForwardHost ?? string.Empty,
            ForwardPort = existing.ForwardPort,
            AccessListId = existing.AccessListId ?? 0,
            NpmplusAccessListIds = accessListIds,
            NpmplusAccessListType = existing.NpmplusAccessListType
                ?? (accessListIds.Count > 0 ? "custom" : "public"),
            CertificateId = existing.CertificateId ?? 0,
            SslForced = existing.SslForced != 0,
            CachingEnabled = existing.CachingEnabled != 0,
            BlockExploits = existing.BlockExploits != 0,
            AdvancedConfig = existing.AdvancedConfig ?? string.Empty,
            AllowWebsocketUpgrade = existing.AllowWebsocketUpgrade != 0,
            Http2Support = existing.Http2Support != 0,
            HstsEnabled = existing.HstsEnabled != 0,
            HstsSubdomains = existing.HstsSubdomains != 0,
            Enabled = enabled,
            NpmplusAuthRequest = existing.NpmplusAuthRequest ?? "none",
            NpmplusAuthRequestUpstream = existing.NpmplusAuthRequestUpstream ?? string.Empty,
            Meta = meta,
            Locations = existing.Locations ?? new List<ProxyLocationRequest>(),
        };

        return await UpdateProxyHostAsync(hostId, request, cancellationToken);
    }

    public static bool IsUiDisabled(ProxyHost host)
    {
        if (host.Meta == null)
            return host.Enabled == 0;

        if (host.Meta.TryGetValue("ui_disabled", out var disabled))
        {
            var text = disabled?.ToString()?.ToLowerInvariant();
            if (text is "true" or "1" or "yes" or "on")
                return true;
            if (text is "false" or "0" or "no" or "off")
                return false;
            if (disabled is bool b)
                return b;
            if (disabled is System.Text.Json.JsonElement je)
            {
                if (je.ValueKind == System.Text.Json.JsonValueKind.True) return true;
                if (je.ValueKind == System.Text.Json.JsonValueKind.False) return false;
                if (je.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    var s = je.GetString()?.ToLowerInvariant();
                    return s is "true" or "1" or "yes" or "on";
                }
            }
        }

        return host.Enabled == 0;
    }

    public async Task<List<Stream>> GetStreamsAsync(CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);

        var response = await _httpClient.GetAsync("/api/nginx/streams", cancellationToken);
        response.EnsureSuccessStatusCode();

        var streams = await response.Content.ReadFromJsonAsync<List<Stream>>(cancellationToken);
        return streams ?? new List<Stream>();
    }

    public async Task<Stream> CreateStreamAsync(StreamRequest request, CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);

        _logger.LogInformation("Creating stream for incoming port: {IncomingPort} -> {ForwardHost}:{ForwardPort}",
            request.IncomingPort, request.ForwardingHost, request.ForwardingPort);

        var response = await _httpClient.PostAsJsonAsync("/api/nginx/streams", request, cancellationToken);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<Stream>(cancellationToken);
        return result ?? throw new Exception("Failed to create stream");
    }

    public async Task DeleteStreamAsync(int streamId, CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);

        _logger.LogInformation("Deleting stream {StreamId}", streamId);

        var response = await _httpClient.DeleteAsync($"/api/nginx/streams/{streamId}", cancellationToken);
        response.EnsureSuccessStatusCode();
    }

    public async Task<List<Certificate>> GetCertificatesAsync(CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);

        var response = await _httpClient.GetAsync("/api/nginx/certificates", cancellationToken);
        response.EnsureSuccessStatusCode();

        var certificates = await response.Content.ReadFromJsonAsync<List<Certificate>>(cancellationToken);
        return certificates ?? new List<Certificate>();
    }

    public async Task<T?> GetAsync<T>(string path, CancellationToken cancellationToken)
    {
        await EnsureAuthenticated(cancellationToken);

        var response = await _httpClient.GetAsync(path, cancellationToken);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadFromJsonAsync<T>(cancellationToken);
    }

    public static bool IsAutomationManaged(ProxyHost host, string syncInstanceId)
    {
        if (host.Meta == null)
            return false;

        // Check if managed by npm-docker-sync
        if (!host.Meta.TryGetValue("managed_by", out var managedBy) ||
            managedBy?.ToString() != "npm-docker-sync")
            return false;

        // Check if managed by THIS sync instance
        if (host.Meta.TryGetValue("sync_instance_id", out var instance))
        {
            return instance?.ToString() == syncInstanceId;
        }

        // Backward compatibility: if no sync_instance_id, assume it's ours
        // (for proxies created before this feature was added)
        return true;
    }

    public static string? GetManagedContainerId(ProxyHost host)
    {
        if (host.Meta == null)
            return null;

        return host.Meta.TryGetValue("container_id", out var containerId)
            ? containerId?.ToString()
            : null;
    }

    public static int? GetProxyIndex(ProxyHost host)
    {
        if (host.Meta == null)
            return null;

        if (host.Meta.TryGetValue("proxy_index", out var index) && int.TryParse(index?.ToString(), out var indexInt))
            return indexInt;

        return null;
    }

    public static string? GetManagedInstanceId(ProxyHost host)
    {
        if (host.Meta == null)
            return null;

        return host.Meta.TryGetValue("sync_instance_id", out var instance)
            ? instance?.ToString()
            : null;
    }

    // Stream helper methods
    public static bool IsStreamAutomationManaged(Stream stream, string syncInstanceId)
    {
        if (stream.Meta == null)
            return false;

        // Check if managed by npm-docker-sync
        if (!stream.Meta.TryGetValue("managed_by", out var managedBy) ||
            managedBy?.ToString() != "npm-docker-sync")
            return false;

        // Check if managed by THIS sync instance
        if (stream.Meta.TryGetValue("sync_instance_id", out var instance))
        {
            return instance?.ToString() == syncInstanceId;
        }

        // Backward compatibility: if no sync_instance_id, assume it's ours
        return true;
    }

    public static string? GetStreamContainerId(Stream stream)
    {
        if (stream.Meta == null)
            return null;

        return stream.Meta.TryGetValue("container_id", out var containerId)
            ? containerId?.ToString()
            : null;
    }

    public static int? GetStreamIndex(Stream stream)
    {
        if (stream.Meta == null)
            return null;

        if (stream.Meta.TryGetValue("stream_index", out var index) && int.TryParse(index?.ToString(), out var indexInt))
            return indexInt;

        return null;
    }

    public static string? GetManagedNpmUrl(ProxyHost host)
    {
        if (host.Meta == null)
            return null;

        return host.Meta.TryGetValue("npm_url", out var url)
            ? url?.ToString()
            : null;
    }
}

public class TokenResponse
{
    [JsonPropertyName("token")]
    public string? Token { get; set; }

    [JsonPropertyName("expires")]
    public string? Expires { get; set; }
}

public class ProxyHost
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("created_on")]
    public string? CreatedOn { get; set; }

    [JsonPropertyName("modified_on")]
    public string? ModifiedOn { get; set; }

    [JsonPropertyName("owner_user_id")]
    public int OwnerUserId { get; set; }

    [JsonPropertyName("domain_names")]
    public List<string>? DomainNames { get; set; }

    [JsonPropertyName("forward_scheme")]
    public string? ForwardScheme { get; set; }

    [JsonPropertyName("forward_host")]
    public string? ForwardHost { get; set; }

    [JsonPropertyName("forward_port")]
    public int ForwardPort { get; set; }

    [JsonPropertyName("access_list_id")]
    public int? AccessListId { get; set; }

    [JsonPropertyName("npmplus_access_list_ids")]
    public List<int>? NpmplusAccessListIds { get; set; }

    [JsonPropertyName("npmplus_access_list_type")]
    public string? NpmplusAccessListType { get; set; }

    [JsonPropertyName("certificate_id")]
    public int? CertificateId { get; set; }

    [JsonPropertyName("ssl_forced")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int SslForced { get; set; }

    [JsonPropertyName("caching_enabled")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int CachingEnabled { get; set; }

    [JsonPropertyName("block_exploits")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int BlockExploits { get; set; }

    [JsonPropertyName("advanced_config")]
    public string? AdvancedConfig { get; set; }

    [JsonPropertyName("enabled")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int Enabled { get; set; }

    [JsonPropertyName("http2_support")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int Http2Support { get; set; }

    [JsonPropertyName("hsts_enabled")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int HstsEnabled { get; set; }

    [JsonPropertyName("hsts_subdomains")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int HstsSubdomains { get; set; }

    [JsonPropertyName("allow_websocket_upgrade")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int AllowWebsocketUpgrade { get; set; }

    [JsonPropertyName("meta")]
    public Dictionary<string, object>? Meta { get; set; }

    [JsonPropertyName("npmplus_auth_request")]
    public string? NpmplusAuthRequest { get; set; }

    [JsonPropertyName("npmplus_auth_request_upstream")]
    public string? NpmplusAuthRequestUpstream { get; set; }

    [JsonPropertyName("locations")]
    public List<ProxyLocationRequest>? Locations { get; set; }
}

public class ProxyHostRequest
{
    [JsonPropertyName("domain_names")]
    public List<string> DomainNames { get; set; } = new();

    [JsonPropertyName("forward_scheme")]
    public string ForwardScheme { get; set; } = "http";

    [JsonPropertyName("forward_host")]
    public string ForwardHost { get; set; } = string.Empty;

    [JsonPropertyName("forward_port")]
    public int ForwardPort { get; set; }

    /// <summary>
    /// Classic NPM access list id. Not sent to NPMplus (uses npmplus_access_list_* instead).
    /// </summary>
    [JsonIgnore]
    public int AccessListId { get; set; }

    [JsonPropertyName("npmplus_access_list_ids")]
    public List<int> NpmplusAccessListIds { get; set; } = new();

    [JsonPropertyName("npmplus_access_list_type")]
    public string NpmplusAccessListType { get; set; } = "public";

    [JsonPropertyName("certificate_id")]
    public int CertificateId { get; set; }

    [JsonPropertyName("ssl_forced")]
    public bool SslForced { get; set; }

    [JsonPropertyName("caching_enabled")]
    public bool CachingEnabled { get; set; }

    [JsonPropertyName("block_exploits")]
    public bool BlockExploits { get; set; } = true;

    [JsonPropertyName("advanced_config")]
    public string AdvancedConfig { get; set; } = string.Empty;

    [JsonPropertyName("meta")]
    public Dictionary<string, object> Meta { get; set; } = new();

    [JsonPropertyName("allow_websocket_upgrade")]
    public bool AllowWebsocketUpgrade { get; set; }

    [JsonPropertyName("http2_support")]
    public bool Http2Support { get; set; }

    [JsonPropertyName("hsts_enabled")]
    public bool HstsEnabled { get; set; }

    [JsonPropertyName("hsts_subdomains")]
    public bool HstsSubdomains { get; set; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    [JsonPropertyName("npmplus_auth_request")]
    public string NpmplusAuthRequest { get; set; } = "none";

    [JsonPropertyName("npmplus_auth_request_upstream")]
    public string NpmplusAuthRequestUpstream { get; set; } = string.Empty;

    [JsonPropertyName("locations")]
    public List<ProxyLocationRequest> Locations { get; set; } = new();
}

public class Certificate
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("created_on")]
    public string? CreatedOn { get; set; }

    [JsonPropertyName("modified_on")]
    public string? ModifiedOn { get; set; }

    [JsonPropertyName("provider")]
    public string? Provider { get; set; }

    [JsonPropertyName("nice_name")]
    public string? NiceName { get; set; }

    [JsonPropertyName("domain_names")]
    public List<string>? DomainNames { get; set; }

    [JsonPropertyName("expires_on")]
    public string? ExpiresOn { get; set; }

    [JsonPropertyName("owner_user_id")]
    public int OwnerUserId { get; set; }

    [JsonPropertyName("is_deleted")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int IsDeleted { get; set; }
}

public class AccessList
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("items")]
    public List<AccessListItem>? Items { get; set; }

    [JsonPropertyName("satisfy_any")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int SatisfyAny { get; set; }

    [JsonPropertyName("pass_auth")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int PassAuth { get; set; }

    [JsonPropertyName("is_deleted")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int IsDeleted { get; set; }
}

public class AccessListItem
{
    [JsonPropertyName("username")]
    public string? Username { get; set; }

    [JsonPropertyName("directive")]
    public string? Directive { get; set; }

    [JsonPropertyName("address")]
    public string? Address { get; set; }
}

public class RedirectionHost
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("domain_names")]
    public List<string>? DomainNames { get; set; }

    [JsonPropertyName("forward_domain_name")]
    public string? ForwardDomainName { get; set; }

    [JsonPropertyName("forward_scheme")]
    public string? ForwardScheme { get; set; }

    [JsonPropertyName("certificate_id")]
    public int? CertificateId { get; set; }

    [JsonPropertyName("ssl_forced")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int SslForced { get; set; }

    [JsonPropertyName("hsts_enabled")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int HstsEnabled { get; set; }

    [JsonPropertyName("hsts_subdomains")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int HstsSubdomains { get; set; }

    [JsonPropertyName("http2_support")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int Http2Support { get; set; }

    [JsonPropertyName("block_exploits")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int BlockExploits { get; set; }

    [JsonPropertyName("preserve_path")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int PreservePath { get; set; }

    [JsonPropertyName("advanced_config")]
    public string? AdvancedConfig { get; set; }

    [JsonPropertyName("is_deleted")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int IsDeleted { get; set; }
}

public class Stream
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("incoming_port")]
    public int IncomingPort { get; set; }

    [JsonPropertyName("forwarding_host")]
    public string? ForwardingHost { get; set; }

    [JsonPropertyName("forwarding_port")]
    public int ForwardingPort { get; set; }

    [JsonPropertyName("tcp_forwarding")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int TcpForwarding { get; set; }

    [JsonPropertyName("udp_forwarding")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int UdpForwarding { get; set; }

    [JsonPropertyName("certificate_id")]
    public int? CertificateId { get; set; }

    [JsonPropertyName("meta")]
    public Dictionary<string, object>? Meta { get; set; }

    [JsonPropertyName("is_deleted")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int IsDeleted { get; set; }
}

public class StreamRequest
{
    [JsonPropertyName("incoming_port")]
    public int IncomingPort { get; set; }

    [JsonPropertyName("forwarding_host")]
    public string ForwardingHost { get; set; } = string.Empty;

    [JsonPropertyName("forwarding_port")]
    public int ForwardingPort { get; set; }

    [JsonPropertyName("tcp_forwarding")]
    public int TcpForwarding { get; set; } = 1;

    [JsonPropertyName("udp_forwarding")]
    public int UdpForwarding { get; set; } = 0;

    [JsonPropertyName("certificate_id")]
    public int CertificateId { get; set; } = 0;

    [JsonPropertyName("meta")]
    public Dictionary<string, object> Meta { get; set; } = new();
}

public class DeadHost
{
    [JsonPropertyName("id")]
    public int Id { get; set; }

    [JsonPropertyName("domain_names")]
    public List<string>? DomainNames { get; set; }

    [JsonPropertyName("certificate_id")]
    public int? CertificateId { get; set; }

    [JsonPropertyName("ssl_forced")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int SslForced { get; set; }

    [JsonPropertyName("hsts_enabled")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int HstsEnabled { get; set; }

    [JsonPropertyName("hsts_subdomains")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int HstsSubdomains { get; set; }

    [JsonPropertyName("http2_support")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int Http2Support { get; set; }

    [JsonPropertyName("advanced_config")]
    public string? AdvancedConfig { get; set; }

    [JsonPropertyName("is_deleted")]
    [JsonConverter(typeof(BoolToIntConverter))]
    public int IsDeleted { get; set; }
}
