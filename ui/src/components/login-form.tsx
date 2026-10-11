import { useState } from 'react'
import { KeyRound, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { AuthStatus } from '@/lib/api'
import { setStoredWebUiToken } from '@/lib/auth'
import { cn } from '@/lib/utils'

export function LoginForm({
  auth,
  className,
  onAuthenticated,
}: {
  auth: AuthStatus | null
  className?: string
  onAuthenticated: () => void
}) {
  const [token, setToken] = useState(() => localStorage.getItem('web_ui_token') ?? '')
  const [error, setError] = useState<string | null>(null)

  const showOidc = auth?.oidcConfigured
  const showToken = auth?.tokenAuthConfigured ?? auth?.authConfigured

  function saveToken() {
    setError(null)
    const trimmed = token.trim()
    if (!trimmed) {
      setError('Enter your WEB_UI_TOKEN')
      return
    }
    setStoredWebUiToken(trimmed)
    onAuthenticated()
  }

  return (
    <div className={cn('mx-auto flex w-full max-w-md flex-col gap-6', className)}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>
            Access the NPM Docker Sync dashboard. Use your identity provider or an API bearer token.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {showOidc && (
              <Field>
                <Button variant="default" className="w-full gap-2" asChild>
                  <a href="/api/auth/login">
                    <LogIn className="size-4" />
                    Sign in with OIDC
                  </a>
                </Button>
                <FieldDescription className="text-center text-xs">
                  Requires <code className="text-[11px]">OIDC_AUTHORITY</code> and{' '}
                  <code className="text-[11px]">OIDC_CLIENT_ID</code> (env or Settings).
                </FieldDescription>
              </Field>
            )}

            {showOidc && showToken && (
              <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                Or use API token
              </FieldSeparator>
            )}

            {showToken && (
              <>
                <Field>
                  <FieldLabel htmlFor="web-ui-token">
                    <span className="inline-flex items-center gap-1.5">
                      <KeyRound className="size-3.5" />
                      WEB_UI_TOKEN
                    </span>
                  </FieldLabel>
                  <Input
                    id="web-ui-token"
                    type="password"
                    autoComplete="off"
                    placeholder="Bearer token from your deployment"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveToken()
                    }}
                  />
                  <FieldDescription>
                    Stored in this browser only and sent as{' '}
                    <code className="text-[11px]">Authorization: Bearer …</code> on API calls.
                  </FieldDescription>
                </Field>
                <Field>
                  <Button type="button" className="w-full" variant={showOidc ? 'outline' : 'default'} onClick={saveToken}>
                    Continue with token
                  </Button>
                </Field>
              </>
            )}

            {!showOidc && !showToken && (
              <p className="text-center text-sm text-muted-foreground">
                No authentication is configured. Set <code className="text-xs">WEB_UI_TOKEN</code> or OIDC in the
                container environment, or open Settings after deploying with auth.
              </p>
            )}

            {error && <p className="text-center text-sm text-destructive">{error}</p>}
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  )
}
