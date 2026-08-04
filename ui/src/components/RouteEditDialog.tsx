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
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
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

type LabeledOption = { value: string; label: string }

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
      const via = result.via ? ` · via ${result.via}` : ''
      setTestMsg(
        result.ok
          ? `OK · ${result.message} (${result.latencyMs}ms)${via}`
          : `Failed · ${result.message}${via}`,
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
                <SimpleCombobox
                  value={scheme}
                  onChange={setScheme}
                  items={['http', 'https']}
                  placeholder="http"
                />
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
              Probe runs inside the NPMplus container when <code className="text-[10px]">NPM_CONTAINER_NAME</code> is
              set — same network path nginx uses (including host networking / bridge IPs).
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
              <LabeledCombobox
                value={certId}
                onChange={(v) => {
                  setCertId(v)
                  if (v) setSslForced(true)
                }}
                items={certs.map((c) => ({ value: String(c.id), label: certLabel(c) }))}
                placeholder="None (HTTP only / auto-match)"
                emptyText="No certificates found"
                allowClear
              />
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
                <SimpleCombobox
                  value={authRequest}
                  onChange={setAuthRequest}
                  items={AUTH_OPTIONS}
                  placeholder="none"
                />
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

function SimpleCombobox({
  value,
  onChange,
  items,
  placeholder,
  emptyText = 'No matches',
  inputMode,
  allowClear = false,
  creatable = false,
}: {
  value: string
  onChange: (v: string) => void
  items: string[]
  placeholder?: string
  emptyText?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  allowClear?: boolean
  /** Allow typing values that aren’t in the list (ports/hosts). */
  creatable?: boolean
}) {
  const options = useMemo(() => {
    if (creatable && value && !items.includes(value)) return [value, ...items]
    return items
  }, [creatable, items, value])

  return (
    <Combobox
      items={options}
      value={value || null}
      onValueChange={(v) => onChange(v ?? '')}
      {...(creatable
        ? {
            inputValue: value,
            onInputValueChange: (next: string) => onChange(next),
          }
        : {})}
    >
      <ComboboxInput
        placeholder={placeholder}
        className="w-full"
        inputMode={inputMode}
        showClear={allowClear && !!value}
      />
      <ComboboxContent>
        <ComboboxEmpty>{creatable ? 'Type a custom value' : emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(item) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function LabeledCombobox({
  value,
  onChange,
  items,
  placeholder,
  emptyText = 'No matches',
  allowClear = false,
}: {
  value: string
  onChange: (v: string) => void
  items: LabeledOption[]
  placeholder?: string
  emptyText?: string
  allowClear?: boolean
}) {
  const selected = items.find((i) => i.value === value) ?? null

  return (
    <Combobox
      items={items}
      value={selected}
      onValueChange={(item) => onChange(item?.value ?? '')}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
    >
      <ComboboxInput
        placeholder={placeholder}
        className="w-full"
        showClear={allowClear && !!value}
      />
      <ComboboxContent>
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
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

function PortCombobox({
  value,
  onChange,
  candidates,
}: {
  value: string
  onChange: (v: string) => void
  candidates: number[]
}) {
  const items = useMemo(
    () => [...new Set(candidates)].sort((a, b) => a - b).map(String),
    [candidates],
  )

  return (
    <SimpleCombobox
      value={value}
      onChange={onChange}
      items={items}
      placeholder={items[0] ?? '8080'}
      inputMode="numeric"
      creatable
      allowClear={!!value}
    />
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
  const items = useMemo(() => {
    const seen = new Set<string>()
    const opts: LabeledOption[] = []
    for (const c of candidates) {
      if (seen.has(c.host)) continue
      seen.add(c.host)
      opts.push({ value: c.host, label: `${c.host} — ${c.label}` })
    }
    if (value && !seen.has(value)) {
      opts.unshift({ value, label: value })
    }
    return opts
  }, [candidates, value])

  return (
    <Combobox
      items={items}
      value={items.find((i) => i.value === value) ?? null}
      onValueChange={(item) => onChange(item?.value ?? '')}
      inputValue={value}
      onInputValueChange={onChange}
      itemToStringLabel={(item) => item.value}
      isItemEqualToValue={(a, b) => a.value === b.value}
    >
      <ComboboxInput
        placeholder="container-name or IP"
        className="w-full"
        showClear={!!value}
      />
      <ComboboxContent>
        <ComboboxEmpty>{candidates.length ? 'Type a custom host' : 'Type a host'}</ComboboxEmpty>
        <ComboboxList>
          {(item) => (
            <ComboboxItem key={item.value} value={item}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{item.value}</span>
                {item.label !== item.value && (
                  <span className="truncate text-xs text-muted-foreground">
                    {item.label.includes(' — ') ? item.label.split(' — ').slice(1).join(' — ') : item.label}
                  </span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
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
