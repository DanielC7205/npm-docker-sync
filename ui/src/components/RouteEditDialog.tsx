import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { clearRouteOverride, patchRoute, type RouteInfo } from '@/lib/api'

const AUTH_OPTIONS = ['none', 'authentik', 'authentik-send-basic-auth', 'oauth2proxy', 'authelia', 'tinyauth', 'anubis']

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
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [scheme, setScheme] = useState('http')
  const [sslForced, setSslForced] = useState(false)
  const [http2, setHttp2] = useState(false)
  const [hsts, setHsts] = useState(false)
  const [websockets, setWebsockets] = useState(false)
  const [certId, setCertId] = useState('')
  const [authRequest, setAuthRequest] = useState('none')
  const [authExempt, setAuthExempt] = useState(false)
  const [icon, setIcon] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!route) return
    setHost(route.forwardHost ?? '')
    setPort(route.forwardPort?.toString() ?? '')
    setScheme(route.forwardScheme ?? 'http')
    setSslForced(!!route.sslForced)
    setHttp2(!!route.http2Support)
    setHsts(!!route.hstsEnabled)
    setWebsockets(!!route.allowWebsocketUpgrade)
    setCertId(route.certificateId?.toString() ?? '')
    setAuthRequest(route.authRequest || 'none')
    setAuthExempt(!!route.authExempt)
    setIcon(route.icon ?? '')
    setError(null)
  }, [route])

  if (!route) return null

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await patchRoute(route!.containerId, route!.index, {
        forwardHost: host || null,
        forwardPort: port ? Number(port) : null,
        forwardScheme: scheme,
        sslForced,
        http2Support: http2,
        hstsEnabled: hsts,
        allowWebsocketUpgrade: websockets,
        certificateId: certId ? Number(certId) : null,
        authRequest: authExempt ? 'none' : authRequest,
        authExempt,
        icon: icon || null,
      })
      onOpenChange(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{route.name}</DialogTitle>
          <DialogDescription>
            Edit forward target, TLS, and auth. Overrides persist in SQLite and win over labels.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Field label="Forward host">
            <Input value={host} onChange={(e) => setHost(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port">
              <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Scheme">
              <select className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm" value={scheme} onChange={(e) => setScheme(e.target.value)}>
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </Field>
          </div>
          <Field label="Certificate ID">
            <Input value={certId} onChange={(e) => setCertId(e.target.value)} placeholder="0 = none" />
          </Field>
          <Toggle label="Force SSL" checked={sslForced} onChange={setSslForced} />
          <Toggle label="HTTP/2" checked={http2} onChange={setHttp2} />
          <Toggle label="HSTS" checked={hsts} onChange={setHsts} />
          <Toggle label="WebSockets" checked={websockets} onChange={setWebsockets} />
          <Toggle label="Exempt from route OAuth" checked={authExempt} onChange={setAuthExempt} />
          {!authExempt && (
            <Field label="Auth request">
              <select className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm" value={authRequest} onChange={(e) => setAuthRequest(e.target.value)}>
                {AUTH_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
          )}
          <Field label="Icon URL (override)">
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="https://cdn.jsdelivr.net/gh/selfhst/icons/png/…" />
          </Field>
          {route.komodoUrl && (
            <a className="text-sm underline" href={route.komodoUrl} target="_blank" rel="noreferrer">
              Open in Komodo ({route.komodoResourceName ?? route.komodoResourceType})
            </a>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          {route.hasUiOverride && (
            <Button variant="outline" disabled={busy} onClick={() => void reset()}>Reset to labels</Button>
          )}
          <Button disabled={busy} onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label>{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
