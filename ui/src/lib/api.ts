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
  sslForced?: boolean | null
  http2Support?: boolean | null
  hstsEnabled?: boolean | null
  hstsSubdomains?: boolean | null
  allowWebsocketUpgrade?: boolean | null
  cachingEnabled?: boolean | null
  blockExploits?: boolean | null
  certificateId?: number | null
  authRequest?: string | null
  authRequestUpstream?: string | null
  authExempt?: boolean | null
  hasUiOverride?: boolean
  komodoUrl?: string | null
  komodoResourceType?: string | null
  komodoResourceName?: string | null
}

export interface DashboardStats {
  uptimeSeconds: number
  total: number
  synced: number
  missing: number
  disabled: number
  conflict: number
}

export interface AuthStatus {
  authConfigured: boolean
  oidcConfigured: boolean
  authenticated: boolean
  name?: string | null
}

export interface TunnelInfo {
  id: string
  slug: string
  domain: string
  url: string
  forwardHost: string
  forwardPort: number
  forwardScheme: string
  npmHostId?: number | null
  expiresAt: string
  label?: string | null
  createdBy?: string | null
  createdAt: string
}

export type AppSettings = Record<string, string | boolean | null | undefined>

function authHeaders(): HeadersInit {
  const token = (import.meta.env.VITE_WEB_UI_TOKEN as string | undefined)
    || localStorage.getItem('web_ui_token')
    || undefined
  if (token) {
    return { Authorization: `Bearer ${token}` }
  }
  return {}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 401) {
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const fetchAuthStatus = () => api<AuthStatus>('/api/auth/status')
export const fetchStats = () => api<DashboardStats>('/api/stats')
export const fetchRoutes = () => api<RouteInfo[]>('/api/routes')
export const fetchSettings = () => api<AppSettings>('/api/settings')
export const saveSettings = (body: Record<string, string | null>) =>
  api<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) })

export const setRouteEnabled = (containerId: string, index: number, enabled: boolean) =>
  api<{ success: boolean }>(`/api/routes/${encodeURIComponent(containerId)}/${index}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })

export const patchRoute = (containerId: string, index: number, body: Record<string, unknown>) =>
  api<{ success: boolean }>(`/api/routes/${encodeURIComponent(containerId)}/${index}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

export const clearRouteOverride = (containerId: string, index: number) =>
  api<{ success: boolean }>(`/api/routes/${encodeURIComponent(containerId)}/${index}/override`, {
    method: 'DELETE',
  })

export const syncRoute = (containerId: string) =>
  api<{ success: boolean }>(`/api/routes/${encodeURIComponent(containerId)}/sync`, {
    method: 'POST',
  })

export const fetchTunnels = () => api<TunnelInfo[]>('/api/tunnels')
export const createTunnel = (body: { port: number; scheme?: string; host?: string; ttlMinutes?: number; label?: string }) =>
  api<TunnelInfo>('/api/tunnels', { method: 'POST', body: JSON.stringify(body) })
export const deleteTunnel = (id: string) =>
  api<{ success: boolean }>(`/api/tunnels/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const extendTunnel = (id: string, ttlMinutes?: number) =>
  api<{ id: string; url: string; expiresAt: string }>(`/api/tunnels/${encodeURIComponent(id)}/extend`, {
    method: 'POST',
    body: JSON.stringify({ ttlMinutes }),
  })
