import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Boxes, LayoutGrid, LogIn, Network, Settings as SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchAuthStatus, type AuthStatus } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AppsPage } from '@/pages/AppsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { TunnelsPage } from '@/pages/TunnelsPage'
import { LoginPage } from '@/pages/LoginPage'

function Shell({ children, auth }: { children: ReactNode; auth: AuthStatus | null }) {
  const loc = useLocation()
  const nav = [
    { to: '/', label: 'Apps', icon: LayoutGrid },
    { to: '/tunnels', label: 'Tunnels', icon: Network },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ]

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <Boxes className="size-5" />
            <span>NPM Docker Sync</span>
          </div>
          <nav className="flex items-center gap-1">
            {nav.map((item) => {
              const Icon = item.icon
              const active = loc.pathname === item.to
              return (
                <Link key={item.to} to={item.to}>
                  <Button variant={active ? 'secondary' : 'ghost'} size="sm" className={cn('gap-1.5')}>
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
              <span className="ml-2 text-xs text-muted-foreground">{auth.name}</span>
            )}
          </nav>
        </div>
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  )
}
