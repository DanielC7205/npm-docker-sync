import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, LifeBuoy } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function UnavailablePage() {
  const [params] = useSearchParams()
  const kind = (params.get('kind') || 'service').toLowerCase()
  const name = params.get('name')?.trim() || null
  const reason = (params.get('reason') || 'unavailable').toLowerCase()

  const { title, detail } = useMemo(() => {
    const subject = kind === 'tunnel' ? 'tunnel' : 'service'
    const named = name ? `“${name}”` : `This ${subject}`

    if (reason === 'expired') {
      return {
        title: 'Tunnel expired',
        detail: `${named} is no longer available because its time window ended.`,
      }
    }
    if (reason === 'stopped') {
      return {
        title: 'Service stopped',
        detail: `${named} is not running right now, so the proxy cannot reach it.`,
      }
    }
    if (reason === 'disabled') {
      return {
        title: 'Service disabled',
        detail: `${named} has been turned off in the sync bridge.`,
      }
    }
    return {
      title: 'Unavailable',
      detail: `${named} is no longer available.`,
    }
  }, [kind, name, reason])

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <Card className="w-full max-w-lg border-muted-foreground/20 shadow-sm">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-6" />
          </div>
          <CardTitle className="text-2xl tracking-tight">{title}</CardTitle>
          <CardDescription className="text-base leading-relaxed text-muted-foreground">
            {detail}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-3 text-left text-sm text-muted-foreground">
            <LifeBuoy className="mt-0.5 size-4 shrink-0" />
            <p>
              If you believe this is a mistake, reach out to the web host who manages this domain.
            </p>
          </div>
          {name && (
            <p className="font-mono text-xs text-muted-foreground">{name}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
