import { useEffect, useMemo, useState } from 'react'
import {
  ExternalLink,
  EyeOff,
  Globe,
  ImageIcon,
  Link2,
  Loader2,
  MapPin,
  Pencil,
  RotateCcw,
  Save,
  Server,
  Shield,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  clearRouteOverride,
  fetchCertificates,
  fetchRoutes,
  patchRoute,
  testUpstream,
  type CertificateInfo,
  type CustomLocation,
  type HostCandidate,
  type RouteInfo,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { CustomLocationsEditor } from '@/components/CustomLocationsEditor'

const AUTH_OPTIONS = ['none', 'authentik', 'authentik-send-basic-auth', 'oauth2proxy', 'authelia', 'tinyauth', 'anubis']
const SELFHST_CDN = 'https://cdn.jsdelivr.net/gh/selfhst/icons/png'

function certLabel(c: CertificateInfo) {
  const name = c.niceName || `Certificate #${c.id}`
  const domains = c.domainNames?.length
    ? ` (${c.domainNames.slice(0, 3).join(', ')}${c.domainNames.length > 3 ? '…' : ''})`
    : ''
  return `#${c.id} — ${name}${domains}`
}

/** Bare icon names → selfh.st CDN; full URLs unchanged. */
export function normalizeIconInput(value: string): string {
  const v = value.trim()
  if (!v) return ''
  if (/^(https?:|data:|\/)/i.test(v)) return v
  const slug = v
    .replace(/\.(png|svg|webp)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `${SELFHST_CDN}/${slug}.png` : ''
}

function iconDisplayValue(stored: string | null | undefined): string {
  if (!stored) return ''
  const prefix = `${SELFHST_CDN}/`
  if (stored.startsWith(prefix) && stored.endsWith('.png')) {
    return stored.slice(prefix.length, -4)
  }
  return stored
}

function publicUrl(domain: string): string {
  return `https://${domain}`
}

export function RouteEditDialog({
  route,
  open,
  onOpenChange,
  onSaved,
}: {
  route: RouteInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [domainsText, setDomainsText] = useState('')
  const [hidden, setHidden] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [scheme, setScheme] = useState('http')
  const [sslForced, setSslForced] = useState(false)
  const [http2, setHttp2] = useState(false)
  const [hsts, setHsts] = useState(false)
  const [websockets, setWebsockets] = useState(false)
  const [certId, setCertId] = useState('')
  const [certs, setCerts] = useState<CertificateInfo[]>([])
  const [authRequest, setAuthRequest] = useState('none')
  const [authExempt, setAuthExempt] = useState(false)
  const [icon, setIcon] = useState('')
  const [locations, setLocations] = useState<CustomLocation[]>([])
  const [allRoutes, setAllRoutes] = useState<RouteInfo[]>([])
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void fetchCertificates()
      .then(setCerts)
      .catch(() => setCerts([]))
    void fetchRoutes()
      .then(setAllRoutes)
      .catch(() => setAllRoutes([]))
  }, [open])

  useEffect(() => {
    if (!route) return
    setDisplayName(route.name ?? '')
    setDomainsText((route.domains ?? []).join(', '))
    setHidden(!!route.hidden)
    setHost(route.forwardHost ?? '')
    setPort(route.forwardPort?.toString() ?? '')
    setScheme(route.forwardScheme ?? 'http')
    setSslForced(!!route.sslForced)
    setHttp2(!!route.http2Support)
    setHsts(!!route.hstsEnabled)
    setWebsockets(!!route.allowWebsocketUpgrade)
    setCertId(route.certificateId && route.certificateId > 0 ? String(route.certificateId) : '')
    setAuthRequest(route.authRequest || 'none')
    setAuthExempt(!!route.authExempt)
    setIcon(iconDisplayValue(route.icon))
    setLocations(route.locations ?? [])
    setTestMsg(null)
    setError(null)
  }, [route])

  const domainList = useMemo(
    () => domainsText.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
    [domainsText],
  )

  const iconPreview = normalizeIconInput(icon)

  if (!route) return null

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const selectedCert = certId ? Number(certId) : null
      await patchRoute(route!.containerId, route!.index, {
        displayName: displayName.trim() || null,
        domains: domainList,
        hidden,
        forwardHost: host || null,
        forwardPort: port ? Number(port) : null,
        forwardScheme: scheme,
        sslForced: sslForced || (!!selectedCert && selectedCert > 0),
        http2Support: http2,
        hstsEnabled: hsts,
        allowWebsocketUpgrade: websockets,
        certificateId: selectedCert && selectedCert > 0 ? selectedCert : 0,
        authRequest: authExempt ? 'none' : authRequest,
        authExempt,
        icon: icon.trim() ? normalizeIconInput(icon) : '',
        locations,
      })
      onOpenChange(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function runTest() {
    setTesting(true)
    setTestMsg(null)
    try {
      const result = await testUpstream(route!.containerId, route!.index, {
        host: host || undefined,
        port: port ? Number(port) : undefined,
        scheme,
      })
      setTestMsg(
        result.ok
          ? `OK · ${result.message} (${result.latencyMs}ms)`
          : `Failed · ${result.message}`,
      )
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  async function reset() {
    setBusy(true)
    try {
      await clearRouteOverride(route!.containerId, route!.index)
      onOpenChange(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-muted p-2">
              <Pencil className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">{route.name}</DialogTitle>
              <DialogDescription>
                Edit how this service appears and is proxied. Overrides are stored in SQLite and win over Docker labels.
              </DialogDescription>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{route.containerName}</p>
            </div>
          </div>
        </DialogHeader>

        {domainList.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {domainList.map((d) => (
              <a
                key={d}
                href={publicUrl(d)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs hover:bg-muted"
              >
                <ExternalLink className="size-3" />
                {d}
              </a>
            ))}
            {route.komodoUrl && (
              <a
                href={route.komodoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Komodo <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}

        <div className="space-y-5">
          <Section icon={Globe} title="Identity & domains" hint="How the service is labeled and which hostnames NPM serves.">
            <Field
              label="Display name"
              description="Shown on the Apps page. Leave as the container name or set a friendlier title."
            >
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={route.containerName} />
            </Field>
            <Field
              label="Served under (domains)"
              description="Comma-separated hostnames. Short names expand with PROXY_BASE_DOMAIN when configured (e.g. home → home.example.com)."
            >
              <Input
                value={domainsText}
                onChange={(e) => setDomainsText(e.target.value)}
                placeholder="app.example.com, www.example.com"
              />
            </Field>
            <Toggle
              label="Hide from Apps list"
              description="Keeps the proxy synced but removes it from the default list. Find it again under the Hidden filter."
              checked={hidden}
              onChange={setHidden}
              icon={<EyeOff className="size-3.5" />}
            />
          </Section>

          <Section icon={Server} title="Upstream" hint="Where NPM forwards traffic for this service.">
            <Field
              label="Forward host"
              description="Pick a host NPMplus can reach, or type your own. Candidates include container DNS, aliases, and Docker host."
            >
              <HostCombobox value={host} onChange={setHost} candidates={route.candidateHosts ?? []} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Port"
                description={
                  (route.candidatePorts?.length ?? 0) > 0
                    ? `Detected from EXPOSE / env (no host publish needed): ${route.candidatePorts!.join(', ')}. Or type your own.`
                    : 'Container listen port. Prefer EXPOSE or PORT env so detection works without -p publish.'
                }
              >
                <PortCombobox
                  value={port}
                  onChange={setPort}
                  candidates={route.candidatePorts ?? []}
                />
              </Field>
              <Field label="Scheme" description="http or https to the upstream.">
                <select
                  className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  value={scheme}
                  onChange={(e) => setScheme(e.target.value)}
                >
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" disabled={testing || !host || !port} onClick={() => void runTest()}>
                {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
                Test connection
              </Button>
              {testMsg && (
                <span className={cn('text-xs', testMsg.startsWith('OK') ? 'text-emerald-600' : 'text-destructive')}>
                  {testMsg}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Probe runs from npm-docker-sync (best signal when it shares networks with NPMplus).
            </p>
          </Section>

          <Section icon={MapPin} title="Custom locations" hint="Path-based upstreams on this proxy host (NPM Custom Locations).">
            <CustomLocationsEditor
              value={locations}
              onChange={setLocations}
              routes={allRoutes}
              excludeKey={`${route.containerId}:${route.index}`}
            />
          </Section>

          <Section icon={Shield} title="TLS & access" hint="Certificate, redirects, and optional auth_request.">
            <Field label="TLS certificate" description="Loaded from NPMplus. Selecting a cert enables Force SSL.">
              <select
                className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                value={certId}
                onChange={(e) => {
                  setCertId(e.target.value)
                  if (e.target.value) setSslForced(true)
                }}
              >
                <option value="">None (HTTP only / auto-match)</option>
                {certs.map((c) => (
                  <option key={c.id} value={String(c.id)}>{certLabel(c)}</option>
                ))}
              </select>
            </Field>
            <div className="grid gap-2 sm:grid-cols-2">
              <Toggle label="Force SSL" checked={sslForced} onChange={setSslForced} />
              <Toggle label="HTTP/2" checked={http2} onChange={setHttp2} />
              <Toggle label="HSTS" checked={hsts} onChange={setHsts} />
              <Toggle label="WebSockets" checked={websockets} onChange={setWebsockets} />
            </div>
            <Toggle
              label="Exempt from route OAuth"
              description="Skip the default auth_request provider for this service."
              checked={authExempt}
              onChange={setAuthExempt}
            />
            {!authExempt && (
              <Field label="Auth request" description="NPMplus auth_request provider for this host.">
                <select
                  className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  value={authRequest}
                  onChange={(e) => setAuthRequest(e.target.value)}
                >
                  {AUTH_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
            )}
          </Section>

          <Section icon={ImageIcon} title="Icon" hint="Apps grid avatar. Bare names use the selfh.st CDN.">
            <Field
              label="Icon"
              description={`Type a name like plex or jellyfin — saved as ${SELFHST_CDN}/{name}.png. Full https:// URLs are kept as-is.`}
            >
              <div className="flex items-center gap-2">
                {iconPreview ? (
                  <img src={iconPreview} alt="" className="size-9 rounded-md border bg-muted object-contain p-1" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                ) : (
                  <div className="flex size-9 items-center justify-center rounded-md border bg-muted">
                    <ImageIcon className="size-4 text-muted-foreground" />
                  </div>
                )}
                <Input
                  className="flex-1"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="plex  or  https://…"
                />
              </div>
            </Field>
            {icon.trim() && !/^(https?:|data:|\/)/i.test(icon.trim()) && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Link2 className="mt-0.5 size-3 shrink-0" />
                <span className="break-all">Will save as {iconPreview}</span>
              </p>
            )}
          </Section>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="mt-6 flex-wrap">
          {route.hasUiOverride && (
            <Button variant="outline" disabled={busy} onClick={() => void reset()} className="gap-1.5">
              <RotateCcw className="size-4" />
              Reset to labels
            </Button>
          )}
          <Button disabled={busy} onClick={() => void save()} className="gap-1.5">
            <Save className="size-4" />
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Section({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof Globe
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border bg-card/40 p-3 sm:p-4">
      <div className="mb-3 flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Field({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm">{label}</Label>
      {description && <p className="text-xs leading-snug text-muted-foreground">{description}</p>}
      {children}
    </div>
  )
}

function PortCombobox({
  value,
  onChange,
  candidates,
}: {
  value: string
  onChange: (v: string) => void
  candidates: number[]
}) {
  const listId = 'upstream-port-options'
  const options = [...new Set(candidates)].sort((a, b) => a - b)
  return (
    <div className="space-y-1.5">
      {options.length > 0 && (
        <select
          className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          value={options.some((p) => String(p) === value) ? value : ''}
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value)
          }}
        >
          <option value="">Pick detected port…</option>
          {options.map((p) => (
            <option key={p} value={String(p)}>{p}</option>
          ))}
        </select>
      )}
      <Input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        placeholder={options[0] ? String(options[0]) : '8080'}
      />
      <datalist id={listId}>
        {options.map((p) => (
          <option key={p} value={String(p)} />
        ))}
      </datalist>
    </div>
  )
}

function HostCombobox({
  value,
  onChange,
  candidates,
}: {
  value: string
  onChange: (v: string) => void
  candidates: HostCandidate[]
}) {
  const listId = 'upstream-host-options'
  return (
    <div className="space-y-1.5">
      {candidates.length > 0 && (
        <select
          className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          value={candidates.some((c) => c.host === value) ? value : ''}
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value)
          }}
        >
          <option value="">Pick detected host…</option>
          {candidates.map((c) => (
            <option key={`${c.source}:${c.host}`} value={c.host}>
              {c.host} — {c.label}
            </option>
          ))}
        </select>
      )}
      <Input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="container-name or IP"
      />
      <datalist id={listId}>
        {candidates.map((c) => (
          <option key={`${c.source}:${c.host}`} value={c.host}>
            {c.label}
          </option>
        ))}
      </datalist>
    </div>
  )
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  icon,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
  icon?: React.ReactNode
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 rounded-md border px-3 py-2', description && 'items-start')}>
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5">
          {icon}
          <Label className="text-sm font-normal">{label}</Label>
        </div>
        {description && <p className="text-xs leading-snug text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
