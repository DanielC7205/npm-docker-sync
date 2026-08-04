using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace NpmDockerSync.Services;

public class SettingsStore
{
    private readonly string _dbPath;
    private readonly IConfiguration _configuration;
    private readonly ILogger<SettingsStore> _logger;
    private readonly object _lock = new();

    private static readonly HashSet<string> SecretKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "NPM_PASSWORD",
        "OIDC_CLIENT_SECRET",
        "KOMODO_API_SECRET",
        "WEB_UI_TOKEN",
        "TUNNEL_API_TOKEN",
        "NPM_MIRROR_PASSWORD",
    };

    public static readonly string[] SettingKeys =
    {
        "NPM_URL", "NPM_EMAIL", "NPM_PASSWORD", "NPM_CONTAINER_NAME", "DOCKER_HOST_IP",
        "NPM_TLS_SKIP_VERIFY", "NPM_ADOPT_EXISTING",
        "NPM_PROXY_SSL_FORCE", "NPM_PROXY_CACHING", "NPM_PROXY_BLOCK_EXPLOITS",
        "NPM_PROXY_WEBSOCKETS", "NPM_PROXY_HTTP2", "NPM_PROXY_HSTS", "NPM_PROXY_HSTS_SUBDOMAINS",
        "NPM_PROXY_DEFAULT_CERTIFICATE_ID", "CERT_DOMAIN_MAP",
        "SYNC_INSTANCE_ID",
        "OIDC_AUTHORITY", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_SCOPES", "OIDC_CALLBACK_PATH",
        "KOMODO_URL", "KOMODO_SERVER", "KOMODO_API_KEY", "KOMODO_API_SECRET",
        "WEB_UI_TOKEN", "TUNNEL_API_TOKEN",
        "AUTH_REQUEST_DEFAULT", "AUTH_REQUEST_UPSTREAM",
        "PROXY_BASE_DOMAIN",
        "AUTO_BRIDGE_EXPOSED", "AUTO_BRIDGE_EXCLUDE",
        "TUNNEL_BASE_DOMAIN", "TUNNEL_FORWARD_HOST", "TUNNEL_DEFAULT_TTL_MINUTES", "TUNNEL_REQUIRE_AUTH",
    };

    public SettingsStore(IConfiguration configuration, ILogger<SettingsStore> logger)
    {
        _configuration = configuration;
        _logger = logger;
        _dbPath = configuration["SQLITE_PATH"] ?? "/data/npm-docker-sync.db";

        var dir = Path.GetDirectoryName(_dbPath);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        Initialize();
        _logger.LogInformation("Settings store ready at {Path}", _dbPath);
    }

    private string ConnectionString => $"Data Source={_dbPath}";

    private void Initialize()
    {
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS route_overrides (
                    container_id TEXT NOT NULL,
                    proxy_index INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (container_id, proxy_index)
                );
                CREATE TABLE IF NOT EXISTS tunnels (
                    id TEXT PRIMARY KEY NOT NULL,
                    slug TEXT NOT NULL,
                    domain TEXT NOT NULL,
                    forward_host TEXT NOT NULL,
                    forward_port INTEGER NOT NULL,
                    forward_scheme TEXT NOT NULL,
                    npm_host_id INTEGER,
                    expires_at TEXT NOT NULL,
                    created_by TEXT,
                    label TEXT,
                    created_at TEXT NOT NULL
                );
                """;
            cmd.ExecuteNonQuery();
        }
    }

    private SqliteConnection Open()
    {
        var conn = new SqliteConnection(ConnectionString);
        conn.Open();
        return conn;
    }

    /// <summary>DB value if set, otherwise environment/config.</summary>
    public string? Get(string key)
    {
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT value FROM app_settings WHERE key = $k";
            cmd.Parameters.AddWithValue("$k", key);
            var result = cmd.ExecuteScalar() as string;
            if (result != null)
                return result;
        }

        return _configuration[key];
    }

    public bool GetBool(string key, bool defaultValue = false)
    {
        var value = Get(key);
        if (string.IsNullOrWhiteSpace(value))
            return defaultValue;
        return value.ToLowerInvariant() is "true" or "1" or "yes" or "on";
    }

    public int GetInt(string key, int defaultValue)
    {
        var value = Get(key);
        return int.TryParse(value, out var n) ? n : defaultValue;
    }

    public void Set(string key, string? value)
    {
        lock (_lock)
        {
            using var conn = Open();
            if (value == null)
            {
                using var del = conn.CreateCommand();
                del.CommandText = "DELETE FROM app_settings WHERE key = $k";
                del.Parameters.AddWithValue("$k", key);
                del.ExecuteNonQuery();
                return;
            }

            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO app_settings(key, value) VALUES ($k, $v)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """;
            cmd.Parameters.AddWithValue("$k", key);
            cmd.Parameters.AddWithValue("$v", value);
            cmd.ExecuteNonQuery();
        }
    }

    public bool IsAuthConfigured()
    {
        var token = Get("WEB_UI_TOKEN");
        var tunnelToken = Get("TUNNEL_API_TOKEN");
        var oidcAuthority = Get("OIDC_AUTHORITY");
        var oidcClientId = Get("OIDC_CLIENT_ID");
        return !string.IsNullOrWhiteSpace(token)
               || !string.IsNullOrWhiteSpace(tunnelToken)
               || (!string.IsNullOrWhiteSpace(oidcAuthority) && !string.IsNullOrWhiteSpace(oidcClientId));
    }

    public bool IsOidcConfigured()
    {
        return !string.IsNullOrWhiteSpace(Get("OIDC_AUTHORITY"))
               && !string.IsNullOrWhiteSpace(Get("OIDC_CLIENT_ID"));
    }

    public Dictionary<string, object?> GetPublicSettings()
    {
        var result = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in SettingKeys)
        {
            var value = Get(key);
            if (SecretKeys.Contains(key))
            {
                result[key] = null;
                result[$"{key}_SET"] = !string.IsNullOrEmpty(value);
            }
            else
            {
                result[key] = value;
            }
        }

        result["WEB_UI_PORT"] = _configuration["WEB_UI_PORT"] ?? "8080";
        result["SQLITE_PATH"] = _dbPath;
        result["AUTH_CONFIGURED"] = IsAuthConfigured();
        result["OIDC_CONFIGURED"] = IsOidcConfigured();
        return result;
    }

    public void UpdateSettings(Dictionary<string, string?> updates)
    {
        lock (_lock)
        {
            using var conn = Open();
            using var tx = conn.BeginTransaction();
            foreach (var (key, value) in updates)
            {
                if (!SettingKeys.Contains(key, StringComparer.OrdinalIgnoreCase))
                    continue;

                // Skip blank secret updates (means "leave unchanged")
                if (SecretKeys.Contains(key) && string.IsNullOrWhiteSpace(value))
                    continue;

                if (value == null)
                {
                    using var del = conn.CreateCommand();
                    del.Transaction = tx;
                    del.CommandText = "DELETE FROM app_settings WHERE key = $k";
                    del.Parameters.AddWithValue("$k", key);
                    del.ExecuteNonQuery();
                    continue;
                }

                using var cmd = conn.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = """
                    INSERT INTO app_settings(key, value) VALUES ($k, $v)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """;
                cmd.Parameters.AddWithValue("$k", key);
                cmd.Parameters.AddWithValue("$v", value);
                cmd.ExecuteNonQuery();
            }

            tx.Commit();
        }
    }

    public RouteOverride? GetRouteOverride(string containerId, int index)
    {
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT payload FROM route_overrides WHERE container_id = $c AND proxy_index = $i";
            cmd.Parameters.AddWithValue("$c", containerId);
            cmd.Parameters.AddWithValue("$i", index);
            var json = cmd.ExecuteScalar() as string;
            if (string.IsNullOrEmpty(json))
                return null;
            return JsonSerializer.Deserialize<RouteOverride>(json, JsonOpts());
        }
    }

    public Dictionary<(string ContainerId, int Index), RouteOverride> GetAllRouteOverrides()
    {
        var result = new Dictionary<(string, int), RouteOverride>();
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT container_id, proxy_index, payload FROM route_overrides";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var containerId = reader.GetString(0);
                var index = reader.GetInt32(1);
                var json = reader.GetString(2);
                var ov = JsonSerializer.Deserialize<RouteOverride>(json, JsonOpts());
                if (ov != null)
                    result[(containerId, index)] = ov;
            }
        }

        return result;
    }

    public void UpsertRouteOverride(string containerId, int index, RouteOverride overrideData)
    {
        var json = JsonSerializer.Serialize(overrideData, JsonOpts());
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO route_overrides(container_id, proxy_index, payload, updated_at)
                VALUES ($c, $i, $p, $t)
                ON CONFLICT(container_id, proxy_index) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """;
            cmd.Parameters.AddWithValue("$c", containerId);
            cmd.Parameters.AddWithValue("$i", index);
            cmd.Parameters.AddWithValue("$p", json);
            cmd.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("o"));
            cmd.ExecuteNonQuery();
        }
    }

    public void DeleteRouteOverride(string containerId, int index)
    {
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM route_overrides WHERE container_id = $c AND proxy_index = $i";
            cmd.Parameters.AddWithValue("$c", containerId);
            cmd.Parameters.AddWithValue("$i", index);
            cmd.ExecuteNonQuery();
        }
    }

    public void InsertTunnel(TunnelRecord tunnel)
    {
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO tunnels(id, slug, domain, forward_host, forward_port, forward_scheme,
                    npm_host_id, expires_at, created_by, label, created_at)
                VALUES ($id, $slug, $domain, $host, $port, $scheme, $npm, $exp, $by, $label, $created)
                """;
            cmd.Parameters.AddWithValue("$id", tunnel.Id);
            cmd.Parameters.AddWithValue("$slug", tunnel.Slug);
            cmd.Parameters.AddWithValue("$domain", tunnel.Domain);
            cmd.Parameters.AddWithValue("$host", tunnel.ForwardHost);
            cmd.Parameters.AddWithValue("$port", tunnel.ForwardPort);
            cmd.Parameters.AddWithValue("$scheme", tunnel.ForwardScheme);
            cmd.Parameters.AddWithValue("$npm", (object?)tunnel.NpmHostId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$exp", tunnel.ExpiresAt.ToString("o"));
            cmd.Parameters.AddWithValue("$by", (object?)tunnel.CreatedBy ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$label", (object?)tunnel.Label ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$created", tunnel.CreatedAt.ToString("o"));
            cmd.ExecuteNonQuery();
        }
    }

    public List<TunnelRecord> ListTunnels()
    {
        var list = new List<TunnelRecord>();
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT id, slug, domain, forward_host, forward_port, forward_scheme, npm_host_id, expires_at, created_by, label, created_at FROM tunnels ORDER BY created_at DESC";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
                list.Add(ReadTunnel(reader));
        }

        return list;
    }

    public TunnelRecord? GetTunnel(string id)
    {
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT id, slug, domain, forward_host, forward_port, forward_scheme, npm_host_id, expires_at, created_by, label, created_at FROM tunnels WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", id);
            using var reader = cmd.ExecuteReader();
            if (!reader.Read())
                return null;
            return ReadTunnel(reader);
        }
    }

    public void UpdateTunnel(TunnelRecord tunnel)
    {
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                UPDATE tunnels SET npm_host_id = $npm, expires_at = $exp
                WHERE id = $id
                """;
            cmd.Parameters.AddWithValue("$npm", (object?)tunnel.NpmHostId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$exp", tunnel.ExpiresAt.ToString("o"));
            cmd.Parameters.AddWithValue("$id", tunnel.Id);
            cmd.ExecuteNonQuery();
        }
    }

    public void DeleteTunnel(string id)
    {
        lock (_lock)
        {
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "DELETE FROM tunnels WHERE id = $id";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
    }

    private static TunnelRecord ReadTunnel(SqliteDataReader reader) => new()
    {
        Id = reader.GetString(0),
        Slug = reader.GetString(1),
        Domain = reader.GetString(2),
        ForwardHost = reader.GetString(3),
        ForwardPort = reader.GetInt32(4),
        ForwardScheme = reader.GetString(5),
        NpmHostId = reader.IsDBNull(6) ? null : reader.GetInt32(6),
        ExpiresAt = DateTime.Parse(reader.GetString(7)).ToUniversalTime(),
        CreatedBy = reader.IsDBNull(8) ? null : reader.GetString(8),
        Label = reader.IsDBNull(9) ? null : reader.GetString(9),
        CreatedAt = DateTime.Parse(reader.GetString(10)).ToUniversalTime(),
    };

    private static JsonSerializerOptions JsonOpts() => new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };
}

public class RouteOverride
{
    public string? DisplayName { get; set; }
    public List<string>? Domains { get; set; }
    public bool? Hidden { get; set; }
    public string? ForwardHost { get; set; }
    public int? ForwardPort { get; set; }
    public string? ForwardScheme { get; set; }
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
    public string? Icon { get; set; }
    public string? AdvancedConfig { get; set; }
}

public class TunnelRecord
{
    public string Id { get; set; } = string.Empty;
    public string Slug { get; set; } = string.Empty;
    public string Domain { get; set; } = string.Empty;
    public string ForwardHost { get; set; } = string.Empty;
    public int ForwardPort { get; set; }
    public string ForwardScheme { get; set; } = "http";
    public int? NpmHostId { get; set; }
    public DateTime ExpiresAt { get; set; }
    public string? CreatedBy { get; set; }
    public string? Label { get; set; }
    public DateTime CreatedAt { get; set; }
}
