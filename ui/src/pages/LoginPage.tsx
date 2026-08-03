import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AuthStatus } from '@/lib/api'

export function LoginPage({ auth }: { auth: AuthStatus | null }) {
  const [token, setToken] = useState(localStorage.getItem('web_ui_token') ?? '')

  if (auth?.authenticated) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Login</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">API token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="token">WEB_UI_TOKEN</Label>
            <Input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <Button
            onClick={() => {
              localStorage.setItem('web_ui_token', token)
              window.location.href = '/'
            }}
          >
            Save token
          </Button>
        </CardContent>
      </Card>
      {auth?.oidcConfigured && (
        <a href="/api/auth/login">
          <Button className="w-full" variant="secondary">Sign in with OIDC</Button>
        </a>
      )}
    </div>
  )
}
