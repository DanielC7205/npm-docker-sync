import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]',
        success: 'bg-[var(--color-success)] text-white',
        destructive: 'bg-[var(--color-destructive)] text-white',
        secondary: 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]',
        outline: 'border border-[var(--color-border)] text-[var(--color-muted-foreground)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}
