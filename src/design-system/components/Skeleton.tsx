import { cn } from '@/lib/cn'

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-gray-200/70', className)} />
}

/** 테이블 로딩용 행 스켈레톤. */
export function SkeletonRows({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-gray-100">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-3 py-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn('h-4 flex-1', c === 0 && 'max-w-[40px]')} />
          ))}
        </div>
      ))}
    </div>
  )
}
