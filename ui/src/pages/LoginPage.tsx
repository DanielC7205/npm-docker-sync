import { Navigate, useSearchParams } from 'react-router-dom'
import { LoginForm } from '@/components/login-form'
import type { AuthStatus } from '@/lib/api'
import { hasStoredWebUiToken } from '@/lib/auth'

export function LoginPage({
  auth,
  onAuthRefresh,
}: {
  auth: AuthStatus | null
  onAuthRefresh: () => void
}) {
  const [searchParams] = useSearchParams()
  const oidcError = searchParams.get('error')

  const sessionOk = auth?.authenticated || (auth?.authConfigured && hasStoredWebUiToken())

  if (sessionOk) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="flex min-h-[60vh] flex-col justify-center py-8">
      {oidcError && (
        <div className="mx-auto mb-4 max-w-md rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Sign-in failed: {oidcError}
        </div>
      )}
      <LoginForm auth={auth} onAuthenticated={() => onAuthRefresh()} />
    </div>
  )
}
