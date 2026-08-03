export type RouteStatus = 'Synced' | 'Missing' | 'Disabled' | 'Excluded' | 'Conflict'

export interface RouteInfo {
  containerId: string
  containerName: string
  index: number
  name: string
  description?: string | null
  icon?: string | null
  category?: string | null
  domains: string[]
  forwardHost?: string | null
  forwardPort?: number | null
  forwardScheme?: string | null
  status: RouteStatus
  npmHostId?: number | null
  enabled?: boolean | null
  labelSource: string
}

export interface DashboardStats {
  uptimeSeconds: number
  total: number
  synced: number
  missing: number
  disabled: number
  conflict: number
}

function authHeaders(): HeadersInit {
  const token = import.meta.env.VITE_WEB_UI_TOKEN as string | undefined
  if (token) {
    return { Authorization: `Bearer ${token}` }
  }
  return {}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Request failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const fetchStats = () => api<DashboardStats>('/api/stats')
export const fetchRoutes = () => api<RouteInfo[]>('/api/routes')

export const setRouteEnabled = (containerId: string, index: number, enabled: boolean) =>
  api<{ success: boolean }>(`/api/routes/${encodeURIComponent(containerId)}/${index}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })

export const syncRoute = (containerId: string) =>
  api<{ success: boolean }>(`/api/routes/${encodeURIComponent(containerId)}/sync`, {
    method: 'POST',
  })
