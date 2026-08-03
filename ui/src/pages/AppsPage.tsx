import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Clock,
  ExternalLink,
  Folder,
  Grid2X2,
  RefreshCw,
  Search,
  Server,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  fetchRoutes,
  fetchStats,
  setRouteEnabled,
  syncRoute,
  type DashboardStats,
  type RouteInfo,
  type RouteStatus,
} from '@/lib/api'
import { cn, formatUptime } from '@/lib/utils'
import { RouteEditDialog } from '@/components/RouteEditDialog'

type FilterKey = 'all' | 'synced' | 'missing' | 'disabled' | 'docker'

function statusBadge(status: RouteStatus) {
  switch (status) {
    case 'Synced':
      return <Badge variant="success">Synced</Badge>
    case 'Missing':
      return <Badge variant="destructive">Missing</Badge>
    case 'Disabled':
      return <Badge variant="secondary">Disabled</Badge>
    case 'Conflict':
      return <Badge variant="destructive">Conflict</Badge>
    case 'Excluded':
      return <Badge variant="outline">Excluded</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

function initials(name: string) {
  const parts = name.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export function AppsPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [routes, setRoutes] = useState<RouteInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [search, setSearch] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [editRoute, setEditRoute] = useState<RouteInfo | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const [s, r] = await Promise.all([fetchStats(), fetchRoutes()])
      setStats(s)
      setRoutes(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 15000)
    return () => window.clearInterval(id)
  }, [load])

  const filtered = useMemo(() => {
    return routes.filter((r) => {
      if (filter === 'synced' && r.status !== 'Synced') return false
      if (filter === 'missing' && r.status !== 'Missing') return false
      if (filter === 'disabled' && r.status !== 'Disabled') return false
      if (filter === 'docker' && r.labelSource !== 'godoxy' && r.labelSource !== 'merged') return false
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return (
        r.name.toLowerCase().includes(q) ||
        r.containerName.toLowerCase().includes(q) ||
        (r.category ?? '').toLowerCase().includes(q) ||
        r.domains.some((d) => d.toLowerCase().includes(q))
      )
    })
  }, [routes, filter, search])

  async function onToggle(route: RouteInfo, enabled: boolean) {
    const key = `${route.containerId}:${route.index}`
    setBusyKey(key)
    try {
      await setRouteEnabled(route.containerId, route.index, enabled)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed')
    } finally {
      setBusyKey(null)
    }
  }

  async function onSync(route: RouteInfo) {
    const key = `sync:${route.containerId}`
    setBusyKey(key)
    try {
      await syncRoute(route.containerId)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setBusyKey(null)
    }
  }

  const filters: { key: FilterKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'synced', label: 'Synced' },
    { key: 'missing', label: 'Missing' },
    { key: 'disabled', label: 'Disabled' },
    { key: 'docker', label: 'Docker' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
          <p className="text-sm text-muted-foreground">Proxied containers synced to NPMplus</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Uptime" value={stats ? formatUptime(stats.uptimeSeconds) : '—'} icon={<Clock className="size-4" />} />
        <StatCard title="Synced" value={stats?.synced ?? '—'} icon={<Grid2X2 className="size-4" />} />
        <StatCard title="Missing" value={stats?.missing ?? '—'} icon={<Server className="size-4" />} />
        <StatCard title="Disabled" value={stats?.disabled ?? '—'} icon={<Folder className="size-4" />} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {filters.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? 'secondary' : 'outline'}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((route) => {
            const key = `${route.containerId}:${route.index}`
            const canToggle = route.status === 'Synced' || route.status === 'Disabled'
            return (
              <Card
                key={key}
                className={cn('cursor-pointer transition hover:border-foreground/20')}
                onClick={() => setEditRoute(route)}
              >
                <CardHeader className="flex flex-row items-start gap-3 space-y-0 pb-2">
                  <Avatar className="size-10">
                    {route.icon ? <AvatarImage src={route.icon} alt="" /> : null}
                    <AvatarFallback>{initials(route.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate text-base">{route.name}</CardTitle>
                    <p className="truncate text-xs text-muted-foreground">{route.containerName}</p>
                  </div>
                  {statusBadge(route.status)}
                </CardHeader>
                <CardContent className="space-y-3 text-sm" onClick={(e) => e.stopPropagation()}>
                  <div className="truncate text-muted-foreground">
                    {route.domains.join(', ') || 'No domains'}
                  </div>
                  {formatForward(route) && (
                    <div className="truncate font-mono text-xs">{formatForward(route)}</div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {canToggle && (
                        <>
                          <Switch
                            checked={route.enabled !== false}
                            disabled={busyKey === key}
                            onCheckedChange={(v) => void onToggle(route, v)}
                          />
                          <span className="text-xs text-muted-foreground">Enabled</span>
                        </>
                      )}
                      {route.status === 'Missing' && (
                        <Button size="sm" variant="outline" disabled={busyKey === `sync:${route.containerId}`} onClick={() => void onSync(route)}>
                          Sync
                        </Button>
                      )}
                    </div>
                    {route.komodoUrl && (
                      <a href={route.komodoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        Komodo <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  {route.hasUiOverride && <Badge variant="outline">UI override</Badge>}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <RouteEditDialog
        route={editRoute}
        open={!!editRoute}
        onOpenChange={(open) => { if (!open) setEditRoute(null) }}
        onSaved={() => void load()}
      />
    </div>
  )
}

function formatForward(route: RouteInfo): string | null {
  if (route.status === 'Excluded') return null
  const host = route.forwardHost?.trim()
  const port = route.forwardPort
  if (!host && !port) return null
  const scheme = route.forwardScheme?.trim() || 'http'
  if (host && port) return `${scheme}://${host}:${port}`
  if (host) return `${scheme}://${host}`
  return `${scheme}://?:${port}`
}

function StatCard({ title, value, icon }: { title: string; value: string | number; icon: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}
