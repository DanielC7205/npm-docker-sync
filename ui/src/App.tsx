import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Boxes,
  Clock,
  Folder,
  Grid2X2,
  LayoutGrid,
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

export default function App() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [routes, setRoutes] = useState<RouteInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [search, setSearch] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)

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
    let list = [...routes]
    if (filter === 'synced') list = list.filter((r) => r.status === 'Synced')
    if (filter === 'missing') list = list.filter((r) => r.status === 'Missing')
    if (filter === 'disabled') list = list.filter((r) => r.status === 'Disabled')
    if (filter === 'docker') {
      list = list.filter(
        (r) =>
          r.category?.toLowerCase() === 'docker' ||
          r.labelSource === 'godoxy' ||
          r.labelSource === 'merged'
      )
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.containerName.toLowerCase().includes(q) ||
          r.domains.some((d) => d.toLowerCase().includes(q)) ||
          (r.category ?? '').toLowerCase().includes(q)
      )
    }
    return list.sort((a, b) => a.name.localeCompare(b.name))
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

  const filters: { key: FilterKey; label: string; icon: ReactNode }[] = [
    { key: 'all', label: 'All', icon: <Grid2X2 className="h-3.5 w-3.5" /> },
    { key: 'synced', label: 'Synced', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
    { key: 'missing', label: 'Missing', icon: <Folder className="h-3.5 w-3.5" /> },
    { key: 'disabled', label: 'Disabled', icon: <Server className="h-3.5 w-3.5" /> },
    { key: 'docker', label: 'Docker', icon: <Boxes className="h-3.5 w-3.5" /> },
  ]

  return (
    <div className="min-h-screen bg-[var(--color-background)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-card)]/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-primary)] text-white">
              <Boxes className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-wide">NPM Docker Sync</div>
              <div className="text-xs text-[var(--color-muted-foreground)]">Route overview</div>
            </div>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <Button variant="ghost" className="text-[var(--color-primary)]">
              <LayoutGrid className="h-4 w-4" />
              Apps
            </Button>
            <Button variant="ghost" asChild>
              <a
                href="https://github.com/danielcuevas/npm-docker-sync"
                target="_blank"
                rel="noreferrer"
              >
                Docs
              </a>
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Uptime</CardTitle>
              <Clock className="h-4 w-4 text-[var(--color-muted-foreground)]" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">
                {stats ? formatUptime(stats.uptimeSeconds) : '—'}
              </div>
              <div className="text-xs text-[var(--color-muted-foreground)]">since last restart</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Synced</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold text-[var(--color-success)]">
                {stats?.synced ?? '—'}
              </div>
              <div className="text-xs text-[var(--color-muted-foreground)]">
                of {stats?.total ?? 0} routes
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Missing</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold text-[var(--color-destructive)]">
                {stats?.missing ?? '—'}
              </div>
              <div className="text-xs text-[var(--color-muted-foreground)]">not in NPM yet</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Disabled</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{stats?.disabled ?? '—'}</div>
              <div className="text-xs text-[var(--color-muted-foreground)]">NPM host off</div>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {filters.map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={filter === f.key ? 'default' : 'outline'}
                onClick={() => setFilter(f.key)}
              >
                {f.icon}
                {f.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button size="icon" variant="outline" onClick={() => void load()} title="Refresh">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-[var(--color-muted-foreground)]" />
              <Input
                className="pl-8"
                placeholder="Search apps or domains..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-[var(--color-destructive)]/40 bg-[var(--color-destructive)]/10 px-3 py-2 text-sm text-[var(--color-destructive)]">
            {error}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((route) => {
            const key = `${route.containerId}:${route.index}`
            const canToggle = route.status === 'Synced' || route.status === 'Disabled'
            const toggleBusy = busyKey === key
            const syncBusy = busyKey === `sync:${route.containerId}`

            return (
              <Card key={key} className="transition-colors hover:border-[var(--color-primary)]/40">
                <CardContent className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar>
                        {route.icon ? <AvatarImage src={route.icon} alt={route.name} /> : null}
                        <AvatarFallback>{initials(route.name)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{route.name}</div>
                        <div className="truncate text-xs text-[var(--color-muted-foreground)]">
                          {route.category ?? 'App'}
                          {route.domains[0] ? ` · ${route.domains[0]}` : ''}
                        </div>
                      </div>
                    </div>
                    {statusBadge(route.status)}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    {route.status === 'Missing' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={syncBusy}
                        onClick={() => void onSync(route)}
                      >
                        <RefreshCw className={cn('h-3.5 w-3.5', syncBusy && 'animate-spin')} />
                        Sync to NPM
                      </Button>
                    ) : (
                      <div className="text-xs text-[var(--color-muted-foreground)]">
                        {route.forwardScheme}://{route.forwardHost}
                        {route.forwardPort ? `:${route.forwardPort}` : ''}
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--color-muted-foreground)]">NPM</span>
                      <Switch
                        checked={route.enabled === true}
                        disabled={!canToggle || toggleBusy}
                        onCheckedChange={(checked) => void onToggle(route, checked)}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {!loading && filtered.length === 0 && (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] px-6 py-16 text-center text-sm text-[var(--color-muted-foreground)]">
            No routes match your filters. Add <code className="text-[var(--color-foreground)]">npm.proxy.*</code> or{' '}
            <code className="text-[var(--color-foreground)]">proxy.aliases</code> labels to containers.
          </div>
        )}
      </main>
    </div>
  )
}
