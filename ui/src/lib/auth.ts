const TOKEN_KEY = 'web_ui_token'

export function getStoredWebUiToken(): string {
  return (
    (import.meta.env.VITE_WEB_UI_TOKEN as string | undefined)
    || localStorage.getItem(TOKEN_KEY)
    || ''
  )
}

export function setStoredWebUiToken(token: string) {
  const trimmed = token.trim()
  if (trimmed) localStorage.setItem(TOKEN_KEY, trimmed)
  else localStorage.removeItem(TOKEN_KEY)
}

export function hasStoredWebUiToken(): boolean {
  return getStoredWebUiToken().length > 0
}
