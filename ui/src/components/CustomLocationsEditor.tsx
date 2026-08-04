import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CustomLocation, RouteInfo } from '@/lib/api'

export function emptyLocation(mode: 'manual' | 'linked' = 'manual'): CustomLocation {
  return {
    mode,
    path: '/',
    forwardScheme: 'http',
    forwardHost: '',
    forwardPort: null,
    forwardPath: '',
    linkedContainerId: null,
    linkedProxyIndex: 0,
  }
}

export function CustomLocationsEditor({
  value,
  onChange,
  routes,
  excludeKey,
  allowLinked = true,
}: {
  value: CustomLocation[]
  onChange: (next: CustomLocation[]) => void
  routes?: RouteInfo[]
  /** `containerId:index` to exclude from linked picker */
  excludeKey?: string
  allowLinked?: boolean
}) {
  const linkable = (routes ?? []).filter((r) => {
    if (r.status === 'Excluded') return false
    const key = `${r.containerId}:${r.index}`
    return key !== excludeKey
  })

  function update(i: number, patch: Partial<CustomLocation>) {
    onChange(value.map((loc, idx) => (idx === i ? { ...loc, ...patch } : loc)))
  }

  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i))
  }

  return (
    <div className="space-y-3">
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No custom locations. Add a path (e.g. /api) that forwards to another service or a manual upstream.
        </p>
      )}

      {value.map((loc, i) => {
        const linked =
          loc.mode === 'linked'
            ? linkable.find(
                (r) =>
                  r.containerId === loc.linkedContainerId &&
                  r.index === (loc.linkedProxyIndex ?? 0),
              )
            : undefined

        return (
          <div key={i} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs font-medium">Location {i + 1}</Label>
              <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => remove(i)}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label className="text-xs text-muted-foreground">Path</Label>
                <Input
                  value={loc.path}
                  onChange={(e) => update(i, { path: e.target.value })}
                  placeholder="/api"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Mode</Label>
                <select
                  className="mt-1 flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  value={loc.mode === 'linked' ? 'linked' : 'manual'}
                  onChange={(e) =>
                    update(i, {
                      mode: e.target.value,
                      ...(e.target.value === 'manual'
                        ? { linkedContainerId: null }
                        : {}),
                    })
                  }
                  disabled={!allowLinked}
                >
                  <option value="manual">Manual</option>
                  {allowLinked && <option value="linked">Linked service</option>}
                </select>
              </div>
            </div>

            {loc.mode === 'linked' && allowLinked ? (
              <div className="space-y-2">
                <div>
                  <Label className="text-xs text-muted-foreground">Linked service</Label>
                  <select
                    className="mt-1 flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={
                      loc.linkedContainerId
                        ? `${loc.linkedContainerId}:${loc.linkedProxyIndex ?? 0}`
                        : ''
                    }
                    onChange={(e) => {
                      const [cid, idx] = e.target.value.split(':')
                      update(i, {
                        linkedContainerId: cid || null,
                        linkedProxyIndex: Number(idx) || 0,
                      })
                    }}
                  >
                    <option value="">Select a service…</option>
                    {linkable.map((r) => (
                      <option key={`${r.containerId}:${r.index}`} value={`${r.containerId}:${r.index}`}>
                        {r.name} ({r.forwardHost || '?'}:{r.forwardPort ?? '?'})
                      </option>
                    ))}
                  </select>
                </div>
                <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                  Upstream locked
                  {linked
                    ? `: ${linked.forwardScheme || 'http'}://${linked.forwardHost || '?'}:${linked.forwardPort ?? '?'}`
                    : ' — pick a service'}
                  . Resolved live on sync.
                </p>
                <div>
                  <Label className="text-xs text-muted-foreground">Forward path (optional)</Label>
                  <Input
                    value={loc.forwardPath ?? ''}
                    onChange={(e) => update(i, { forwardPath: e.target.value })}
                    placeholder="/v1"
                    className="mt-1"
                  />
                </div>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Scheme</Label>
                  <select
                    className="mt-1 flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={loc.forwardScheme || 'http'}
                    onChange={(e) => update(i, { forwardScheme: e.target.value })}
                  >
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Host</Label>
                  <Input
                    value={loc.forwardHost ?? ''}
                    onChange={(e) => update(i, { forwardHost: e.target.value })}
                    placeholder="other-service"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Port</Label>
                  <Input
                    type="number"
                    value={loc.forwardPort ?? ''}
                    onChange={(e) =>
                      update(i, { forwardPort: e.target.value ? Number(e.target.value) : null })
                    }
                    placeholder="8080"
                    className="mt-1"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Forward path (optional)</Label>
                  <Input
                    value={loc.forwardPath ?? ''}
                    onChange={(e) => update(i, { forwardPath: e.target.value })}
                    placeholder="/internal"
                    className="mt-1"
                  />
                </div>
              </div>
            )}
          </div>
        )
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => onChange([...value, emptyLocation(allowLinked ? 'manual' : 'manual')])}
      >
        <Plus className="size-3.5" />
        Add location
      </Button>
    </div>
  )
}
