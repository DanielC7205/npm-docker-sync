import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { createTunnel, deleteTunnel, extendTunnel, fetchTunnels, type TunnelInfo } from '@/lib/api'

export function TunnelsPage() {
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([])
  const [port, setPort] = useState('3000')
  const [label, setLabel] = useState('')
  const [scheme, setScheme] = useState('http')
  const [ttlMinutes, setTtlMinutes] = useState('120')
  const [forwardHost, setForwardHost] = useState('')
  const [disableOnExpire, setDisableOnExpire] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      setTunnels(await fetchTunnels())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tunnels')
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 15000)
    return () => window.clearInterval(id)
  }, [load])

  async function onCreate() {
    setBusy(true)
    try {
      const created = await createTunnel({
        port: Number(port),
        scheme,
        label: label || undefined,
        ttlMinutes: ttlMinutes ? Number(ttlMinutes) : undefined,
        host: forwardHost || undefined,
        disableOnExpire,
      })
      await navigator.clipboard.writeText(created.url).catch(() => undefined)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tunnels</h1>
        <p className="text-sm text-muted-foreground">
          Temporary NPMplus share URLs for reachable workspace hosts (LAN / Tailscale). Requires TUNNEL_BASE_DOMAIN.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Share a port</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="port">Port</Label>
            <Input id="port" className="w-28" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="label">Label</Label>
            <Input id="label" className="w-48" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="scheme">Upstream scheme</Label>
            <select
              id="scheme"
              className="flex h-9 w-28 rounded-md border bg-transparent px-3 text-sm"
              value={scheme}
              onChange={(e) => setScheme(e.target.value)}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ttlMinutes">TTL (minutes)</Label>
            <Input
              id="ttlMinutes"
              className="w-28"
              value={ttlMinutes}
              onChange={(e) => setTtlMinutes(e.target.value)}
              inputMode="numeric"
            />
          </div>

          <div className="flex items-center gap-3 rounded-md border px-3 py-2">
            <div className="grid gap-0.5">
              <Label htmlFor="disableOnExpire" className="text-sm">Persist</Label>
              <p className="text-xs text-muted-foreground">Disable on expiry (keep record)</p>
            </div>
            <Switch id="disableOnExpire" checked={disableOnExpire} onCheckedChange={setDisableOnExpire} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="forwardHost">Forward host (optional)</Label>
            <Input
              id="forwardHost"
              className="w-56"
              value={forwardHost}
              onChange={(e) => setForwardHost(e.target.value)}
              placeholder="Uses TUNNEL_FORWARD_HOST if empty"
            />
          </div>

          <Button disabled={busy} onClick={() => void onCreate()}>
            Create & copy URL
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-3">
        {tunnels.map((t) => (
          <Card key={t.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="min-w-0">
                <a className="font-medium underline" href={t.url} target="_blank" rel="noreferrer">{t.url}</a>
                <p className="text-xs text-muted-foreground">
                  {t.forwardScheme}://{t.forwardHost}:{t.forwardPort}
                  {t.label ? ` · ${t.label}` : ''} · expires {new Date(t.expiresAt).toLocaleString()}
                  {t.disableOnExpire ? ' · persist/disable' : ''}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(t.url)}>Copy</Button>
                <Button size="sm" variant="outline" onClick={() => void extendTunnel(t.id).then(load)}>Extend</Button>
                <Button size="sm" variant="outline" onClick={() => void deleteTunnel(t.id).then(load)}>Stop</Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {tunnels.length === 0 && (
          <p className="text-sm text-muted-foreground">No active tunnels.</p>
        )}
      </div>
    </div>
  )
}
