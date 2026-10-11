import type { RouteInfo } from '@/lib/api'

const STORAGE_KEY = 'apps_route_visibility_v1'

export type RouteVisibilityPrefs = {
  /** Never-bridge / proxy.exclude containers (status Excluded). */
  showExcluded: boolean
  /** Domain owned by another NPM host (status Conflict). */
  showConflict: boolean
  /** Stopped or UI-disabled proxies (status Disabled) outside the Disabled tab. */
  showDisabled: boolean
  /** Routes created only via auto-bridge (no npm/proxy labels). */
  showAutoBridgeOnly: boolean
}

export const DEFAULT_ROUTE_VISIBILITY: RouteVisibilityPrefs = {
  showExcluded: false,
  showConflict: false,
  showDisabled: false,
  showAutoBridgeOnly: true,
}

export function loadRouteVisibilityPrefs(): RouteVisibilityPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_ROUTE_VISIBILITY }
    const parsed = JSON.parse(raw) as Partial<RouteVisibilityPrefs>
    return { ...DEFAULT_ROUTE_VISIBILITY, ...parsed }
  } catch {
    return { ...DEFAULT_ROUTE_VISIBILITY }
  }
}

export function saveRouteVisibilityPrefs(prefs: RouteVisibilityPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}

function isAutoBridgeRoute(route: RouteInfo): boolean {
  return route.category === 'Auto' || route.labelSource === 'auto'
}

export function routeMatchesVisibility(
  route: RouteInfo,
  prefs: RouteVisibilityPrefs,
  activeTab: string,
): boolean {
  if (route.status === 'Excluded' && !prefs.showExcluded) return false
  if (route.status === 'Conflict' && !prefs.showConflict) return false
  if (
    route.status === 'Disabled' &&
    !prefs.showDisabled &&
    activeTab !== 'disabled'
  ) {
    return false
  }
  if (!prefs.showAutoBridgeOnly && isAutoBridgeRoute(route)) return false
  return true
}

export function countHiddenByVisibility(routes: RouteInfo[], prefs: RouteVisibilityPrefs): number {
  return routes.filter((r) => !routeMatchesVisibility(r, prefs, 'all')).length
}
