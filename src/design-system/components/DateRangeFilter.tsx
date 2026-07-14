import { format, startOfMonth, subDays } from 'date-fns'
import { cn } from '@/lib/cn'

export interface DateRange {
  from: string | null // yyyy-MM-dd
  to: string | null
}

interface DateRangeFilterProps {
  value: DateRange
  onChange: (range: DateRange) => void
  className?: string
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd')

const PRESETS: { key: string; label: string; calc: () => DateRange }[] = [
  { key: 'today', label: '오늘', calc: () => ({ from: iso(new Date()), to: iso(new Date()) }) },
  { key: '7d', label: '7일', calc: () => ({ from: iso(subDays(new Date(), 6)), to: iso(new Date()) }) },
  { key: '30d', label: '30일', calc: () => ({ from: iso(subDays(new Date(), 29)), to: iso(new Date()) }) },
  { key: 'month', label: '이번달', calc: () => ({ from: iso(startOfMonth(new Date())), to: iso(new Date()) }) },
]

export function DateRangeFilter({ value, onChange, className }: DateRangeFilterProps) {
  const input =
    'h-9 rounded-md border border-gray-300 bg-white px-2.5 font-mono text-[12.5px] text-gray-700 outline-none focus:border-primary-500 tnum'
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <input
        type="date"
        value={value.from ?? ''}
        max={value.to ?? undefined}
        onChange={(e) => onChange({ ...value, from: e.target.value || null })}
        className={input}
      />
      <span className="text-gray-400">~</span>
      <input
        type="date"
        value={value.to ?? ''}
        min={value.from ?? undefined}
        onChange={(e) => onChange({ ...value, to: e.target.value || null })}
        className={input}
      />
      <div className="flex items-center gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange(p.calc())}
            className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[11.5px] font-semibold text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}
