import { cn } from '@/lib/cn'

export interface TabItem {
  key: string
  label: string
  count?: number
}

interface TabsProps {
  tabs: TabItem[]
  value: string
  onChange: (key: string) => void
  className?: string
}

/** 언더라인형 탭 바. (자주 쓰는 뷰 / 상태 필터) */
export function Tabs({ tabs, value, onChange, className }: TabsProps) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-gray-200', className)}>
      {tabs.map((t) => {
        const active = t.key === value
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              'relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors',
              active
                ? 'border-primary-600 text-ink-900'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            )}
          >
            {t.label}
            {t.count != null && (
              <span
                className={cn(
                  'rounded-full px-1.5 text-[11px] font-bold tnum',
                  active ? 'bg-primary-50 text-primary-600' : 'bg-gray-100 text-gray-500',
                )}
              >
                {t.count.toLocaleString('ko-KR')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
