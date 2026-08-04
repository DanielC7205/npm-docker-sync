import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import type { CustomLocation, RouteInfo } from '@/lib/api'

type ServiceOption = { value: string; label: string }

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
                <div className="mt-1">
                  <StringCombobox
                    value={loc.mode === 'linked' ? 'linked' : 'manual'}
                    onChange={(mode) =>
                      update(i, {
                        mode,
                        ...(mode === 'manual' ? { linkedContainerId: null } : {}),
                      })
                    }
                    items={allowLinked ? ['manual', 'linked'] : ['manual']}
                    placeholder="manual"
                    disabled={!allowLinked}
                  />
                </div>
              </div>
            </div>

            {loc.mode === 'linked' && allowLinked ? (
              <div className="space-y-2">
                <div>
                  <Label className="text-xs text-muted-foreground">Linked service</Label>
                  <div className="mt-1">
                    <ServiceCombobox
                      routes={linkable}
                      value={
                        loc.linkedContainerId
                          ? `${loc.linkedContainerId}:${loc.linkedProxyIndex ?? 0}`
                          : ''
                      }
                      onChange={(key) => {
                        if (!key) {
                          update(i, { linkedContainerId: null, linkedProxyIndex: 0 })
                          return
                        }
                        const [cid, idx] = key.split(':')
                        update(i, {
                          linkedContainerId: cid || null,
                          linkedProxyIndex: Number(idx) || 0,
                        })
                      }}
                    />
                  </div>
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
                  <div className="mt-1">
                    <StringCombobox
                      value={loc.forwardScheme || 'http'}
                      onChange={(scheme) => update(i, { forwardScheme: scheme })}
                      items={['http', 'https']}
                      placeholder="http"
                    />
                  </div>
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

function StringCombobox({
  value,
  onChange,
  items,
  placeholder,
  disabled = false,
}: {
  value: string
  onChange: (v: string) => void
  items: string[]
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <Combobox
      items={items}
      value={value || null}
      onValueChange={(v) => onChange(v ?? '')}
      disabled={disabled}
    >
      <ComboboxInput placeholder={placeholder} className="w-full" disabled={disabled} />
      <ComboboxContent>
        <ComboboxEmpty>No options</ComboboxEmpty>
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

function ServiceCombobox({
  routes,
  value,
  onChange,
}: {
  routes: RouteInfo[]
  value: string
  onChange: (v: string) => void
}) {
  const items = useMemo<ServiceOption[]>(
    () =>
      routes.map((r) => ({
        value: `${r.containerId}:${r.index}`,
        label: `${r.name} (${r.forwardHost || '?'}:${r.forwardPort ?? '?'})`,
      })),
    [routes],
  )
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
        placeholder="Select a service…"
        className="w-full"
        showClear={!!value}
      />
      <ComboboxContent>
        <ComboboxEmpty>No services available</ComboboxEmpty>
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
