import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
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
import { createManualRoute, fetchContainers, type RouteContainerInfo } from '@/lib/api'
import { normalizeIconInput } from '@/components/RouteEditDialog'

export function AddRouteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [containers, setContainers] = useState<RouteContainerInfo[]>([])
  const [containerId, setContainerId] = useState('')
  const [domainsText, setDomainsText] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [port, setPort] = useState('')
  const [scheme, setScheme] = useState('http')
  const [icon, setIcon] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void fetchContainers()
      .then(setContainers)
      .catch(() => setContainers([]))
  }, [open])

  const selected = useMemo(
    () => containers.find((c) => c.id === containerId) ?? null,
    [containers, containerId],
  )

  const domainList = useMemo(
    () => domainsText.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
    [domainsText],
  )

  async function submit() {
    if (!containerId) {
      setError('Choose a container')
      return
    }
    if (domainList.length === 0) {
      setError('Enter at least one domain')
      return
    }

    setBusy(true)
    setError(null)
    try {
      await createManualRoute(containerId, {
        manual: true,
        domains: domainList,
        displayName: displayName.trim() || selected?.name || null,
        forwardPort: port ? Number(port) : null,
        forwardScheme: scheme,
        icon: icon.trim() ? normalizeIconInput(icon) : null,
      })
      onOpenChange(false)
      setContainerId('')
      setDomainsText('')
      setDisplayName('')
      setPort('')
      setIcon('')
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create route')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add route</DialogTitle>
          <DialogDescription>
            Create a proxy for a running container without Docker labels. Settings are stored as a UI override and synced to NPMplus.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Container</Label>
            <Combobox
              items={containers.map((c) => c.id)}
              value={containerId || null}
              onValueChange={(v) => setContainerId(v ?? '')}
            >
              <ComboboxInput placeholder="Search containers…" className="w-full" />
              <ComboboxContent>
                <ComboboxEmpty>No running containers</ComboboxEmpty>
                <ComboboxList>
                  {(id) => {
                    const c = containers.find((x) => x.id === id)
                    if (!c) return null
                    return (
                      <ComboboxItem key={c.id} value={c.id}>
                        <span className="font-medium">{c.name}</span>
                        {c.hasSyncLabels && (
                          <span className="ml-2 text-xs text-muted-foreground">labeled</span>
                        )}
                      </ComboboxItem>
                    )
                  }}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>

          <div className="space-y-2">
            <Label>Domains</Label>
            <Input
              placeholder="app.example.com"
              value={domainsText}
              onChange={(e) => setDomainsText(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Port</Label>
              <Input
                placeholder="Auto-detect"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-2">
              <Label>Scheme</Label>
              <Input value={scheme} onChange={(e) => setScheme(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Display name (optional)</Label>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label>Icon (optional)</Label>
            <Input placeholder="slug or URL" value={icon} onChange={(e) => setIcon(e.target.value)} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Create route
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
