import { Navigate } from 'react-router-dom'
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
  const sessionOk = auth?.authenticated || (auth?.authConfigured && hasStoredWebUiToken())

  if (sessionOk) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="flex min-h-[60vh] flex-col justify-center py-8">
      <LoginForm auth={auth} onAuthenticated={() => onAuthRefresh()} />
    </div>
  )
}
