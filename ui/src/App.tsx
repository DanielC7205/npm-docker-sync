import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Boxes, LayoutGrid, LogIn, LogOut, Menu, Network, Settings as SettingsIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchAuthStatus, type AuthStatus } from '@/lib/api'
import { hasStoredWebUiToken, setStoredWebUiToken } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { AppsPage } from '@/pages/AppsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { TunnelsPage } from '@/pages/TunnelsPage'
import { LoginPage } from '@/pages/LoginPage'
import { UnavailablePage } from '@/pages/UnavailablePage'

function isSessionAllowed(auth: AuthStatus | null): boolean {
  if (!auth?.authConfigured) return true
  if (auth.authenticated) return true
  return hasStoredWebUiToken()
}

function Shell({
  children,
  auth,
  onAuthRefresh,
}: {
  children: ReactNode
  auth: AuthStatus | null
  onAuthRefresh: () => void
}) {
  const loc = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const nav = [
    { to: '/', label: 'Apps', icon: LayoutGrid },
    { to: '/tunnels', label: 'Tunnels', icon: Network },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ]

  useEffect(() => {
    setMenuOpen(false)
  }, [loc.pathname])

  if (loc.pathname === '/unavailable') {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main className="mx-auto max-w-6xl px-4">{children}</main>
      </div>
    )
  }

  if (loc.pathname === '/login') {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </div>
    )
  }

  const showSignIn = auth?.authConfigured && !isSessionAllowed(auth)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 font-semibold">
            <Boxes className="size-5 shrink-0" />
            <span className="truncate">
              <span className="md:hidden">Sync</span>
              <span className="hidden md:inline">NPM Docker Sync</span>
            </span>
          </div>

          <nav className="hidden items-center gap-1 md:flex">
            {nav.map((item) => {
              const Icon = item.icon
              const active = loc.pathname === item.to
              return (
                <Link key={item.to} to={item.to}>
                  <Button variant={active ? 'secondary' : 'ghost'} size="sm" className="gap-1.5">
                    <Icon className="size-4" />
                    {item.label}
                  </Button>
                </Link>
              )
            })}
            <a href="https://github.com/DanielC7205/npm-docker-sync" target="_blank" rel="noreferrer">
              <Button variant="ghost" size="sm">Docs</Button>
            </a>
            {showSignIn ? (
              <Link to="/login">
                <Button size="sm" className="gap-1.5">
                  <LogIn className="size-4" />
                  Sign in
                </Button>
              </Link>
            ) : auth?.authenticated ? (
              <>
                <span className="ml-2 max-w-[10rem] truncate text-xs text-muted-foreground">{auth.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    setStoredWebUiToken('')
                    window.location.href = '/api/auth/logout'
                  }}
                >
                  <LogOut className="size-4" />
                  Log out
                </Button>
              </>
            ) : auth?.authConfigured && hasStoredWebUiToken() ? (
              <Link to="/login">
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
                  Token session
                </Button>
              </Link>
            ) : null}
          </nav>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 w-11 shrink-0 px-0 md:hidden"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </Button>
        </div>

        {menuOpen && (
          <div className="border-t md:hidden">
            <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
              {nav.map((item) => {
                const Icon = item.icon
                const active = loc.pathname === item.to
                return (
                  <Link key={item.to} to={item.to}>
                    <Button
                      variant={active ? 'secondary' : 'ghost'}
                      className={cn('h-11 w-full justify-start gap-2')}
                    >
                      <Icon className="size-4" />
                      {item.label}
                    </Button>
                  </Link>
                )
              })}
              <a href="https://github.com/DanielC7205/npm-docker-sync" target="_blank" rel="noreferrer">
                <Button variant="ghost" className="h-11 w-full justify-start">Docs</Button>
              </a>
              {showSignIn ? (
                <Link to="/login">
                  <Button className="h-11 w-full justify-start gap-2">
                    <LogIn className="size-4" />
                    Sign in
                  </Button>
                </Link>
              ) : auth?.authenticated ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">{auth.name}</p>
              ) : null}
            </nav>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}

function RequireAuth({
  auth,
  children,
}: {
  auth: AuthStatus | null
  children: ReactNode
}) {
  const loc = useLocation()
  if (loc.pathname === '/login' || loc.pathname === '/unavailable') {
    return children
  }
  if (auth === null) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">Checking session…</div>
    )
  }

  if (auth.authConfigured && !isSessionAllowed(auth)) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  }
  return children
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const loc = useLocation()

  const refreshAuth = useCallback(() => {
    void fetchAuthStatus()
      .then(setAuth)
      .catch(() =>
        setAuth({
          authConfigured: false,
          oidcConfigured: false,
          authenticated: false,
        }),
      )
  }, [])

  useEffect(() => {
    refreshAuth()
  }, [refreshAuth, loc.pathname])

  return (
    <Shell auth={auth} onAuthRefresh={refreshAuth}>
      <RequireAuth auth={auth}>
        <Routes>
          <Route path="/" element={<AppsPage />} />
          <Route path="/tunnels" element={<TunnelsPage />} />
          <Route path="/settings" element={<SettingsPage auth={auth} />} />
          <Route path="/login" element={<LoginPage auth={auth} onAuthRefresh={refreshAuth} />} />
          <Route path="/unavailable" element={<UnavailablePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </RequireAuth>
    </Shell>
  )
}
