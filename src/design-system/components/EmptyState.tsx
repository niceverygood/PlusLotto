import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cn } from '@/lib/cn'

interface EmptyStateProps {
  title?: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({
  title = '데이터가 없습니다',
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-14 text-center',
        className,
      )}
    >
      <div className="grid h-12 w-12 place-items-center rounded-full bg-gray-100 text-gray-400">
        {icon ?? <Inbox className="h-6 w-6" />}
      </div>
      <p className="text-[14px] font-semibold text-gray-700">{title}</p>
      {description && <p className="max-w-sm text-[12.5px] text-gray-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
