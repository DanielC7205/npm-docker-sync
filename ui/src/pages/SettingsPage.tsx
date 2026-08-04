import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  KeyRound,
  Lock,
  Network,
  Save,
  Search,
  Server,
  Shield,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  fetchCertificates,
  fetchSettings,
  saveSettings,
  type AppSettings,
  type AuthStatus,
  type CertificateInfo,
} from '@/lib/api'

type FieldDef = {
  key: string
  label: string
  description: string
  secret?: boolean
  bool?: boolean
  placeholder?: string
  chips?: boolean
}

type SectionDef = {
  id: string
  title: string
  description: string
  icon: typeof Server
  keys: FieldDef[]
}

const SECTIONS: SectionDef[] = [
  {
    id: 'npm',
    title: 'NPM connection',
    description: 'How this service talks to Nginx Proxy Manager / NPMplus.',
    icon: Server,
    keys: [
      {
        key: 'NPM_URL',
        label: 'NPM URL',
        description: 'Base URL of the NPM/NPMplus API, including scheme and port if needed.',
        placeholder: 'https://npm.example.com:81',
      },
      {
        key: 'NPM_EMAIL',
        label: 'Email',
        description: 'Admin email used to authenticate with the NPM API.',
      },
      {
        key: 'NPM_PASSWORD',
        label: 'Password',
        description: 'Admin password for the NPM API. Leave blank when saving to keep the current value.',
        secret: true,
      },
      {
        key: 'NPM_CONTAINER_NAME',
        label: 'NPM container name',
        description: 'Docker container name for NPM. Enables automatic forward-host inference via shared networks.',
        placeholder: 'npmplus',
      },
      {
        key: 'DOCKER_HOST_IP',
        label: 'Docker host IP',
        description: 'Override for the host IP used when a container is not on the same network as NPM.',
        placeholder: '172.17.0.1',
      },
      {
        key: 'NPM_TLS_SKIP_VERIFY',
        label: 'Skip TLS verify',
        description: 'Disable certificate validation for NPM API calls (self-signed or HTTPS redirects).',
        bool: true,
      },
      {
        key: 'NPM_ADOPT_EXISTING',
        label: 'Adopt existing hosts',
        description: 'If a proxy already exists for a domain, take ownership instead of failing create.',
        bool: true,
      },
    ],
  },
  {
    id: 'proxy',
    title: 'Proxy & auto-bridge',
    description: 'Defaults for synced proxies and unlabeled containers with exposed ports.',
    icon: Network,
    keys: [
      {
        key: 'PROXY_BASE_DOMAIN',
        label: 'Base domain',
        description: 'Expands short aliases (home → home.example.com) and auto-bridge hostnames.',
        placeholder: 'example.com',
      },
      {
        key: 'AUTO_BRIDGE_EXPOSED',
        label: 'Auto-bridge exposed ports',
        description: 'Create proxies for running containers that expose a port but have no npm/proxy labels. Requires base domain.',
        bool: true,
      },
      {
        key: 'AUTO_BRIDGE_EXCLUDE',
        label: 'Never bridge keywords',
        description: 'Comma-separated substrings matched against container name and image. Matching containers are skipped for auto-bridge and labeled sync.',
        placeholder: 'npmplus,npm-docker-sync,nginx-proxy-manager',
        chips: true,
      },
      {
        key: 'UNAVAILABLE_FALLBACK_ENABLED',
        label: 'Unavailable fallback page',
        description: 'When a service stops or a persist tunnel expires, retarget the NPM host to this app’s /unavailable page instead of a dead upstream.',
        bool: true,
      },
      {
        key: 'FALLBACK_FORWARD_HOST',
        label: 'Fallback forward host',
        description: 'How NPMplus reaches this sync UI for the unavailable page. Defaults to DOCKER_HOST_IP / host.docker.internal.',
        placeholder: 'npm-docker-sync or host.docker.internal',
      },
      {
        key: 'NPM_PROXY_SSL_FORCE',
        label: 'Force SSL',
        description: 'Default HTTPS redirect for new/updated proxies when labels omit ssl.force.',
        bool: true,
      },
      {
        key: 'NPM_PROXY_WEBSOCKETS',
        label: 'WebSockets',
        description: 'Allow WebSocket upgrades by default on synced proxies.',
        bool: true,
      },
      {
        key: 'NPM_PROXY_HTTP2',
        label: 'HTTP/2',
        description: 'Enable HTTP/2 support by default on synced proxies.',
        bool: true,
      },
      {
        key: 'NPM_PROXY_HSTS',
        label: 'HSTS',
        description: 'Send Strict-Transport-Security headers by default when SSL is forced.',
        bool: true,
      },
      {
        key: 'NPM_PROXY_BLOCK_EXPLOITS',
        label: 'Block exploits',
        description: 'Enable NPM’s common exploit blocking rules by default.',
        bool: true,
      },
    ],
  },
  {
    id: 'tls',
    title: 'TLS certificates',
    description: 'Certificates from NPMplus, plus domain defaults used during sync and auto-bridge.',
    icon: ShieldCheck,
    keys: [],
  },
  {
    id: 'auth-request',
    title: 'Route OAuth',
    description: 'NPMplus auth_request defaults applied to proxied apps.',
    icon: Shield,
    keys: [
      {
        key: 'AUTH_REQUEST_DEFAULT',
        label: 'Default provider',
        description: 'none, authentik, authentik-send-basic-auth, oauth2proxy, authelia, tinyauth, or anubis.',
        placeholder: 'none',
      },
      {
        key: 'AUTH_REQUEST_UPSTREAM',
        label: 'Upstream override',
        description: 'Optional upstream URL for auth_request when the provider needs a custom endpoint.',
      },
    ],
  },
  {
    id: 'web-auth',
    title: 'Web UI auth',
    description: 'Protect settings writes and optional OIDC login for the dashboard.',
    icon: Lock,
    keys: [
      {
        key: 'WEB_UI_TOKEN',
        label: 'API bearer token',
        description: 'Bearer token for the Web UI and settings API. Leave blank when saving to keep the current value.',
        secret: true,
      },
      {
        key: 'OIDC_AUTHORITY',
        label: 'OIDC authority',
        description: 'Issuer URL for OpenID Connect. Must also be set at container start for middleware registration.',
        placeholder: 'https://auth.example.com/application/o/npm-docker-sync/',
      },
      {
        key: 'OIDC_CLIENT_ID',
        label: 'OIDC client ID',
        description: 'OAuth/OIDC client ID registered with your identity provider.',
      },
      {
        key: 'OIDC_CLIENT_SECRET',
        label: 'OIDC client secret',
        description: 'Client secret for the OIDC app. Leave blank when saving to keep the current value.',
        secret: true,
      },
      {
        key: 'OIDC_SCOPES',
        label: 'OIDC scopes',
        description: 'Space-separated scopes requested during login.',
        placeholder: 'openid profile email',
      },
    ],
  },
  {
    id: 'komodo',
    title: 'Komodo',
    description: 'Deep links from apps to matching Komodo resources.',
    icon: KeyRound,
    keys: [
      {
        key: 'KOMODO_URL',
        label: 'Komodo URL',
        description: 'Base URL of your Komodo instance.',
        placeholder: 'https://komodo.example.com',
      },
      {
        key: 'KOMODO_SERVER',
        label: 'Server',
        description: 'Komodo server id or name used when resolving container resources.',
      },
      {
        key: 'KOMODO_API_KEY',
        label: 'API key',
        description: 'Komodo API key for resource lookups.',
      },
      {
        key: 'KOMODO_API_SECRET',
        label: 'API secret',
        description: 'Komodo API secret. Leave blank when saving to keep the current value.',
        secret: true,
      },
    ],
  },
  {
    id: 'tunnels',
    title: 'Dev tunnels',
    description: 'Temporary public proxies for local ports (VS Code extension / API).',
    icon: Network,
    keys: [
      {
        key: 'TUNNEL_BASE_DOMAIN',
        label: 'Base domain',
        description: 'Domain under which tunnel hostnames are created (e.g. tunnels.example.com).',
        placeholder: 'tunnels.example.com',
      },
      {
        key: 'TUNNEL_FORWARD_HOST',
        label: 'Forward host',
        description: 'IP/hostname NPMplus dials for tunnels (LAN or Tailscale). Required unless Docker Desktop can use host.docker.internal. Causes “TUNNEL_FORWARD_HOST is required” if unset and no extension override.',
        placeholder: '100.x.y.z',
      },
      {
        key: 'TUNNEL_DEFAULT_TTL_MINUTES',
        label: 'Default TTL (minutes)',
        description: 'How long new tunnels live before automatic cleanup.',
        placeholder: '120',
      },
      {
        key: 'TUNNEL_REQUIRE_AUTH',
        label: 'Require route OAuth',
        description: 'Apply the default auth_request provider to tunnel proxy hosts.',
        bool: true,
      },
      {
        key: 'TUNNEL_API_TOKEN',
        label: 'Tunnel API token',
        description: 'Bearer token for tunnel create/list/delete. Leave blank when saving to keep the current value.',
        secret: true,
      },
    ],
  },
]

const TLS_SEARCH_TERMS = [
  'tls',
  'certificate',
  'cert',
  'ssl',
  'domain map',
  'tunnel',
  'CERT_DOMAIN_MAP',
  'NPM_PROXY_DEFAULT_CERTIFICATE_ID',
  'TUNNEL_CERTIFICATE_ID',
]

function certLabel(c: CertificateInfo) {
  const name = c.niceName || `Certificate #${c.id}`
  const domains = c.domainNames?.length
    ? ` (${c.domainNames.slice(0, 2).join(', ')}${c.domainNames.length > 2 ? '…' : ''})`
    : ''
  return `#${c.id} — ${name}${domains}`
}

function parseDomainMap(raw: string): { pattern: string; certId: string }[] {
  if (!raw.trim()) return []
  return raw
    .split(/[\n\r;,]+/)
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      const sep = entry.includes('=') ? entry.indexOf('=') : entry.indexOf(':')
      if (sep <= 0) return { pattern: entry, certId: '' }
      return { pattern: entry.slice(0, sep).trim(), certId: entry.slice(sep + 1).trim() }
    })
}

function serializeDomainMap(rows: { pattern: string; certId: string }[]) {
  return rows
    .filter((r) => r.pattern.trim() && r.certId.trim())
    .map((r) => `${r.pattern.trim()}=${r.certId.trim()}`)
    .join('\n')
}

function matchesQuery(haystack: string, query: string) {
  return haystack.toLowerCase().includes(query.toLowerCase())
}

export function SettingsPage({ auth }: { auth: AuthStatus | null }) {
  const [settings, setSettings] = useState<AppSettings>({})
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [certs, setCerts] = useState<CertificateInfo[]>([])
  const [domainRows, setDomainRows] = useState<{ pattern: string; certId: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id)

  useEffect(() => {
    void Promise.all([fetchSettings(), fetchCertificates().catch(() => [] as CertificateInfo[])])
      .then(([s, c]) => {
        setSettings(s)
        setCerts(c)
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
        d.NPM_PROXY_DEFAULT_CERTIFICATE_ID = String(s.NPM_PROXY_DEFAULT_CERTIFICATE_ID ?? '')
        d.TUNNEL_CERTIFICATE_ID = String(s.TUNNEL_CERTIFICATE_ID ?? '')
        d.CERT_DOMAIN_MAP = String(s.CERT_DOMAIN_MAP ?? '')
        setDraft(d)
        setDomainRows(parseDomainMap(d.CERT_DOMAIN_MAP))
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
  }, [])

  useEffect(() => {
    const ids = SECTIONS.map((s) => s.id)
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (visible?.target.id) {
          const id = visible.target.id.replace(/^settings-/, '')
          if (ids.includes(id)) setActiveSection(id)
        }
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: [0.1, 0.4, 0.7] },
    )
    for (const id of ids) {
      const el = document.getElementById(`settings-${id}`)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [query])

  const filteredSections = useMemo(() => {
    const q = query.trim()
    if (!q) return SECTIONS.map((s) => ({ ...s, keys: s.keys }))

    return SECTIONS.map((section) => {
      const sectionHit =
        matchesQuery(section.title, q) ||
        matchesQuery(section.description, q) ||
        matchesQuery(section.id, q)

      if (section.id === 'tls') {
        const tlsHit = sectionHit || TLS_SEARCH_TERMS.some((t) => matchesQuery(t, q) || matchesQuery(q, t))
        return tlsHit ? section : { ...section, keys: [] as FieldDef[], _hide: true as const }
      }

      const keys = section.keys.filter(
        (f) =>
          sectionHit ||
          matchesQuery(f.label, q) ||
          matchesQuery(f.description, q) ||
          matchesQuery(f.key, q),
      )
      return { ...section, keys, _hide: keys.length === 0 }
    }).filter((s) => !(s as { _hide?: boolean })._hide)
  }, [query])

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
      body.NPM_PROXY_DEFAULT_CERTIFICATE_ID = draft.NPM_PROXY_DEFAULT_CERTIFICATE_ID || ''
      body.TUNNEL_CERTIFICATE_ID = draft.TUNNEL_CERTIFICATE_ID || ''
      body.CERT_DOMAIN_MAP = serializeDomainMap(domainRows)
      const next = await saveSettings(body)
      setSettings(next)
      setDraft((d) => ({
        ...d,
        CERT_DOMAIN_MAP: String(next.CERT_DOMAIN_MAP ?? ''),
        NPM_PROXY_DEFAULT_CERTIFICATE_ID: String(next.NPM_PROXY_DEFAULT_CERTIFICATE_ID ?? ''),
        TUNNEL_CERTIFICATE_ID: String(next.TUNNEL_CERTIFICATE_ID ?? ''),
      }))
      setDomainRows(parseDomainMap(String(next.CERT_DOMAIN_MAP ?? '')))
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const canEdit = !!auth?.authConfigured

  function scrollToSection(id: string) {
    setActiveSection(id)
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="pb-24">
      <div className="mb-6 space-y-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Stored in SQLite under <code className="text-xs">/data</code>. Environment variables bootstrap defaults.
          </p>
        </div>

        {!canEdit && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            Configure <code className="text-xs">WEB_UI_TOKEN</code> or OIDC via env before saving from the UI.
          </div>
        )}

        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings (e.g. SSL, tunnel, OIDC…)"
            className="pl-9"
            aria-label="Search settings"
          />
        </div>

        {/* Mobile section chips */}
        <div className="sticky top-14 z-30 -mx-1 overflow-x-auto px-1 py-1 lg:hidden">
          <div className="flex w-max gap-1.5">
            {filteredSections.map((section) => {
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => scrollToSection(section.id)}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs whitespace-nowrap transition-colors',
                    activeSection === section.id
                      ? 'border-foreground/20 bg-accent text-accent-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent/50',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  {section.title}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <aside className="hidden lg:block">
          {/* If the user scrolls past the top of the page, the nav should be sticky */}
          <nav className="sticky top-20 space-y-0.5">
            <p className="mb-2 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Sections
            </p>
            {SECTIONS.map((section) => {
              const visible = filteredSections.some((s) => s.id === section.id)
              if (!visible) return null
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => scrollToSection(section.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    activeSection === section.id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{section.title}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        <div className="space-y-5">
          {filteredSections.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No settings match “{query}”.
              </CardContent>
            </Card>
          )}

          {filteredSections.map((section) => {
            const Icon = section.icon
            return (
              <Card key={section.id} id={`settings-${section.id}`} className="scroll-mt-4">
                <CardHeader className="pb-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 rounded-md bg-muted p-2">
                      <Icon className="size-4 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle className="text-base font-semibold text-foreground">{section.title}</CardTitle>
                      <CardDescription className="mt-1">{section.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1">
                  {section.id === 'tls' ? (
                    <TlsSection
                      canEdit={canEdit}
                      certs={certs}
                      draft={draft}
                      setDraft={setDraft}
                      domainRows={domainRows}
                      setDomainRows={setDomainRows}
                    />
                  ) : (
                    section.keys.map((field) => (
                      <FieldRow
                        key={field.key}
                        field={field}
                        value={draft[field.key] ?? ''}
                        canEdit={canEdit}
                        secretSet={!!settings[`${field.key}_SET`]}
                        onChange={(v) => setDraft((d) => ({ ...d, [field.key]: v }))}
                      />
                    ))
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {saved ? (
              <span className="inline-flex items-center gap-1.5 text-green-500">
                <Check className="size-4" /> Saved
              </span>
            ) : (
              'Changes apply after save; sync uses the new values on the next event.'
            )}
          </p>
          <Button disabled={!canEdit || busy} onClick={() => void onSave()} className="gap-1.5">
            <Save className="size-4" />
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function FieldRow({
  field,
  value,
  canEdit,
  secretSet,
  onChange,
}: {
  field: FieldDef
  value: string
  canEdit: boolean
  secretSet: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="grid gap-3 border-b border-border/60 py-4 last:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(220px,280px)] sm:items-start">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={field.key} className="text-sm font-medium">
            {field.label}
          </Label>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {field.key}
          </code>
        </div>
        <p className="text-sm leading-snug text-muted-foreground">{field.description}</p>
      </div>
      <div className="sm:justify-self-end sm:w-full">
        {field.bool ? (
          <div className="flex h-9 items-center sm:justify-end">
            <Switch
              id={field.key}
              checked={value === 'true'}
              disabled={!canEdit}
              onCheckedChange={(v) => onChange(String(v))}
            />
          </div>
        ) : field.chips ? (
          <KeywordChipsInput id={field.key} value={value} disabled={!canEdit} onChange={onChange} placeholder={field.placeholder} />
        ) : (
          <Input
            id={field.key}
            type={field.secret ? 'password' : 'text'}
            placeholder={
              field.secret && secretSet
                ? '•••••••• (unchanged)'
                : field.placeholder
            }
            value={value}
            disabled={!canEdit}
            onChange={(e) => onChange(e.target.value)}
            autoComplete={field.secret ? 'new-password' : undefined}
          />
        )}
      </div>
    </div>
  )
}

function KeywordChipsInput({
  id,
  value,
  disabled,
  onChange,
  placeholder,
}: {
  id: string
  value: string
  disabled?: boolean
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')
  const tags = value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  function commit(raw: string) {
    const parts = raw
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...new Set([...tags, ...parts])]
    onChange(next.join(','))
    setDraft('')
  }

  function remove(tag: string) {
    onChange(tags.filter((t) => t !== tag).join(','))
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-9 flex-wrap gap-1.5 rounded-md border bg-transparent p-1.5">
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            disabled={disabled}
            onClick={() => remove(tag)}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs hover:bg-muted/80 disabled:opacity-50"
            title="Remove"
          >
            {tag}
            <span className="text-muted-foreground">×</span>
          </button>
        ))}
        <input
          id={id}
          className="min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none disabled:opacity-50"
          value={draft}
          disabled={disabled}
          placeholder={tags.length === 0 ? placeholder : 'Add keyword…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              commit(draft)
            }
            if (e.key === 'Backspace' && !draft && tags.length) {
              remove(tags[tags.length - 1]!)
            }
          }}
          onBlur={() => {
            if (draft.trim()) commit(draft)
          }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">Press Enter or comma to add. Click a chip to remove.</p>
    </div>
  )
}

function TlsSection({
  canEdit,
  certs,
  draft,
  setDraft,
  domainRows,
  setDomainRows,
}: {
  canEdit: boolean
  certs: CertificateInfo[]
  draft: Record<string, string>
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>
  domainRows: { pattern: string; certId: string }[]
  setDomainRows: React.Dispatch<React.SetStateAction<{ pattern: string; certId: string }[]>>
}) {
  return (
    <div className="space-y-6 pt-1">
      <div className="grid gap-3 border-b border-border/60 pb-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,280px)] sm:items-start">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="NPM_PROXY_DEFAULT_CERTIFICATE_ID" className="text-sm font-medium">
              Default certificate
            </Label>
            <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              NPM_PROXY_DEFAULT_CERTIFICATE_ID
            </code>
          </div>
          <p className="text-sm leading-snug text-muted-foreground">
            Fallback when Force SSL is on and no domain map or NPMplus domain match is found.
          </p>
        </div>
        <CertCombobox
          id="NPM_PROXY_DEFAULT_CERTIFICATE_ID"
          disabled={!canEdit}
          certs={certs}
          value={draft.NPM_PROXY_DEFAULT_CERTIFICATE_ID ?? ''}
          onChange={(v) => setDraft((d) => ({ ...d, NPM_PROXY_DEFAULT_CERTIFICATE_ID: v }))}
          placeholder="None (auto-match only)"
        />
      </div>

      <div className="grid gap-3 border-b border-border/60 pb-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,280px)] sm:items-start">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="TUNNEL_CERTIFICATE_ID" className="text-sm font-medium">
              Tunnel certificate
            </Label>
            <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              TUNNEL_CERTIFICATE_ID
            </code>
          </div>
          <p className="text-sm leading-snug text-muted-foreground">
            Required for HTTPS tunnels. Use a wildcard that covers your tunnel base
            (e.g. <code className="text-xs">*.tunnels.example.com</code> or{' '}
            <code className="text-xs">*.example.com</code>). Without this, browsers show
            SSL_VERSION_OR_CIPHER_MISMATCH.
          </p>
        </div>
        <CertCombobox
          id="TUNNEL_CERTIFICATE_ID"
          disabled={!canEdit}
          certs={certs}
          value={draft.TUNNEL_CERTIFICATE_ID ?? ''}
          onChange={(v) => setDraft((d) => ({ ...d, TUNNEL_CERTIFICATE_ID: v }))}
          placeholder="Auto (domain map / wildcard match)"
        />
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-sm font-medium">Default cert by domain</Label>
            <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              CERT_DOMAIN_MAP
            </code>
          </div>
          <p className="text-sm leading-snug text-muted-foreground">
            Applied during sync and auto-bridge. Exact hostnames first, then wildcards like{' '}
            <code className="text-xs">*.example.com</code>. A match also enables Force SSL for that host.
          </p>
        </div>

        {domainRows.length === 0 && (
          <p className="text-sm text-muted-foreground">No domain mappings yet.</p>
        )}

        <div className="space-y-2">
          {domainRows.map((row, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                placeholder="*.example.com or app.example.com"
                disabled={!canEdit}
                value={row.pattern}
                onChange={(e) => {
                  const next = [...domainRows]
                  next[i] = { ...next[i], pattern: e.target.value }
                  setDomainRows(next)
                }}
              />
              <CertCombobox
                disabled={!canEdit}
                certs={certs}
                value={row.certId}
                onChange={(v) => {
                  const next = [...domainRows]
                  next[i] = { ...next[i], certId: v }
                  setDomainRows(next)
                }}
                placeholder="Select certificate…"
              />
              <Button
                type="button"
                variant="outline"
                disabled={!canEdit}
                onClick={() => setDomainRows(domainRows.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="secondary"
          disabled={!canEdit}
          className="w-fit"
          onClick={() => setDomainRows([...domainRows, { pattern: '', certId: '' }])}
        >
          Add domain mapping
        </Button>

        {certs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No certificates loaded from NPMplus yet. Check NPM connection settings.
          </p>
        )}
      </div>
    </div>
  )
}

function CertCombobox({
  id,
  certs,
  value,
  onChange,
  placeholder,
  disabled = false,
}: {
  id?: string
  certs: CertificateInfo[]
  value: string
  onChange: (v: string) => void
  placeholder: string
  disabled?: boolean
}) {
  const items = useMemo(
    () => certs.map((c) => ({ value: String(c.id), label: certLabel(c) })),
    [certs],
  )
  const selected = items.find((i) => i.value === value) ?? null

  return (
    <Combobox
      items={items}
      value={selected}
      onValueChange={(item) => onChange(item?.value ?? '')}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        placeholder={placeholder}
        className="w-full"
        disabled={disabled}
        showClear={!!value}
      />
      <ComboboxContent>
        <ComboboxEmpty>No certificates found</ComboboxEmpty>
        <ComboboxList>
          {(item) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
