import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface PageHeaderProps {
  title: string
  description?: string
  /** 우측 액션 슬롯(버튼 등). */
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('mb-4 flex items-start gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-[22px] font-extrabold leading-tight text-ink-900">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-gray-500">{description}</p>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
