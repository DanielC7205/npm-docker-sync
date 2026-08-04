import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { fetchSettings, saveSettings, type AppSettings, type AuthStatus } from '@/lib/api'

const SECTIONS: { title: string; keys: { key: string; label: string; secret?: boolean; bool?: boolean }[] }[] = [
  {
    title: 'NPM Connection',
    keys: [
      { key: 'NPM_URL', label: 'NPM URL' },
      { key: 'NPM_EMAIL', label: 'Email' },
      { key: 'NPM_PASSWORD', label: 'Password', secret: true },
      { key: 'NPM_CONTAINER_NAME', label: 'NPM container name' },
      { key: 'DOCKER_HOST_IP', label: 'Docker host IP' },
      { key: 'NPM_TLS_SKIP_VERIFY', label: 'Skip TLS verify', bool: true },
      { key: 'NPM_ADOPT_EXISTING', label: 'Adopt existing hosts', bool: true },
    ],
  },
  {
    title: 'Proxy defaults',
    keys: [
      { key: 'PROXY_BASE_DOMAIN', label: 'Base domain for short aliases (e.g. example.com)' },
      { key: 'AUTO_BRIDGE_EXPOSED', label: 'Auto-bridge containers with exposed ports', bool: true },
      { key: 'AUTO_BRIDGE_EXCLUDE', label: 'Auto-bridge name excludes (comma-separated)' },
      { key: 'NPM_PROXY_SSL_FORCE', label: 'Force SSL (default TLS)', bool: true },
      { key: 'NPM_PROXY_WEBSOCKETS', label: 'WebSockets', bool: true },
      { key: 'NPM_PROXY_HTTP2', label: 'HTTP/2', bool: true },
      { key: 'NPM_PROXY_HSTS', label: 'HSTS', bool: true },
      { key: 'NPM_PROXY_BLOCK_EXPLOITS', label: 'Block exploits', bool: true },
    ],
  },
  {
    title: 'Route OAuth (NPMplus auth_request)',
    keys: [
      { key: 'AUTH_REQUEST_DEFAULT', label: 'Default provider (none/authentik/oauth2proxy/…)' },
      { key: 'AUTH_REQUEST_UPSTREAM', label: 'Upstream override' },
    ],
  },
  {
    title: 'Web UI Auth',
    keys: [
      { key: 'WEB_UI_TOKEN', label: 'API bearer token', secret: true },
      { key: 'OIDC_AUTHORITY', label: 'OIDC authority' },
      { key: 'OIDC_CLIENT_ID', label: 'OIDC client ID' },
      { key: 'OIDC_CLIENT_SECRET', label: 'OIDC client secret', secret: true },
      { key: 'OIDC_SCOPES', label: 'OIDC scopes' },
    ],
  },
  {
    title: 'Komodo',
    keys: [
      { key: 'KOMODO_URL', label: 'Komodo URL' },
      { key: 'KOMODO_SERVER', label: 'Server id/name' },
      { key: 'KOMODO_API_KEY', label: 'API key' },
      { key: 'KOMODO_API_SECRET', label: 'API secret', secret: true },
    ],
  },
  {
    title: 'Dev tunnels',
    keys: [
      { key: 'TUNNEL_BASE_DOMAIN', label: 'Base domain (e.g. tunnels.example.com)' },
      { key: 'TUNNEL_FORWARD_HOST', label: 'Default forward host (LAN/Tailscale IP)' },
      { key: 'TUNNEL_DEFAULT_TTL_MINUTES', label: 'Default TTL (minutes)' },
      { key: 'TUNNEL_REQUIRE_AUTH', label: 'Require route OAuth on tunnels', bool: true },
      { key: 'TUNNEL_API_TOKEN', label: 'Tunnel API token', secret: true },
    ],
  },
]

export function SettingsPage({ auth }: { auth: AuthStatus | null }) {
  const [settings, setSettings] = useState<AppSettings>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void fetchSettings()
      .then((s) => {
        setSettings(s)
        const d: Record<string, string> = {}
        for (const section of SECTIONS) {
          for (const field of section.keys) {
            if (field.secret) {
              d[field.key] = ''
            } else if (field.bool) {
              d[field.key] = String(s[field.key] === true || s[field.key] === 'true' || s[field.key] === '1')
            } else {
              d[field.key] = String(s[field.key] ?? '')
            }
          }
        }
        setDraft(d)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [])

  async function onSave() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const body: Record<string, string | null> = {}
      for (const section of SECTIONS) {
        for (const field of section.keys) {
          const val = draft[field.key]
          if (field.secret && !val) continue
          if (field.bool) {
            body[field.key] = val === 'true' ? 'true' : 'false'
          } else {
            body[field.key] = val ?? ''
          }
        }
      }
      const next = await saveSettings(body)
      setSettings(next)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const canEdit = !!auth?.authConfigured

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Stored in SQLite under /data. Env vars bootstrap defaults.
          {!canEdit && ' Configure WEB_UI_TOKEN or OIDC (via env) before saving from the UI.'}
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-green-600">Saved.</p>}

      {SECTIONS.map((section) => (
        <Card key={section.title}>
          <CardHeader>
            <CardTitle className="text-base">{section.title}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {section.keys.map((field) => (
              <div key={field.key} className="grid gap-1.5 sm:grid-cols-[220px_1fr] sm:items-center">
                <Label htmlFor={field.key}>{field.label}</Label>
                {field.bool ? (
                  <Switch
                    id={field.key}
                    checked={draft[field.key] === 'true'}
                    disabled={!canEdit}
                    onCheckedChange={(v) => setDraft((d) => ({ ...d, [field.key]: String(v) }))}
                  />
                ) : (
                  <Input
                    id={field.key}
                    type={field.secret ? 'password' : 'text'}
                    placeholder={field.secret && settings[`${field.key}_SET`] ? '•••••••• (unchanged)' : undefined}
                    value={draft[field.key] ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="flex justify-end">
        <Button disabled={!canEdit || busy} onClick={() => void onSave()}>
          Save settings
        </Button>
      </div>
    </div>
  )
}
