import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Boxes, LayoutGrid, LogIn, Menu, Network, Settings as SettingsIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchAuthStatus, type AuthStatus } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AppsPage } from '@/pages/AppsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { TunnelsPage } from '@/pages/TunnelsPage'
import { LoginPage } from '@/pages/LoginPage'
import { UnavailablePage } from '@/pages/UnavailablePage'

function Shell({ children, auth }: { children: ReactNode; auth: AuthStatus | null }) {
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

  // Public unavailable page: minimal chrome
  if (loc.pathname === '/unavailable') {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main className="mx-auto max-w-6xl px-4">{children}</main>
      </div>
    )
  }

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

          {/* Desktop nav */}
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
            {auth?.oidcConfigured && !auth.authenticated && (
              <a href="/api/auth/login">
                <Button size="sm" className="gap-1.5">
                  <LogIn className="size-4" />
                  Login
                </Button>
              </a>
            )}
            {auth?.authenticated && (
              <span className="ml-2 max-w-[10rem] truncate text-xs text-muted-foreground">{auth.name}</span>
            )}
          </nav>

          {/* Mobile menu button */}
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

        {/* Mobile drawer */}
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
              {auth?.oidcConfigured && !auth.authenticated && (
                <a href="/api/auth/login">
                  <Button className="h-11 w-full justify-start gap-2">
                    <LogIn className="size-4" />
                    Login
                  </Button>
                </a>
              )}
              {auth?.authenticated && (
                <p className="px-3 py-2 text-xs text-muted-foreground">{auth.name}</p>
              )}
            </nav>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)

  useEffect(() => {
    void fetchAuthStatus().then(setAuth).catch(() => setAuth({
      authConfigured: false,
      oidcConfigured: false,
      authenticated: false,
    }))
  }, [])

  return (
    <Shell auth={auth}>
      <Routes>
        <Route path="/" element={<AppsPage />} />
        <Route path="/tunnels" element={<TunnelsPage />} />
        <Route path="/settings" element={<SettingsPage auth={auth} />} />
        <Route path="/login" element={<LoginPage auth={auth} />} />
        <Route path="/unavailable" element={<UnavailablePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  )
}
