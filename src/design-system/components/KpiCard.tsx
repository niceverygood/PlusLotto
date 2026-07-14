import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface KpiCardProps {
  label: string
  value: ReactNode
  icon?: ReactNode
  /** 아이콘 박스 배경/글자 토큰 클래스 (예: 'bg-primary-50 text-primary-600'). */
  iconClassName?: string
  delta?: string
  deltaDir?: 'up' | 'down' | 'neutral'
  /** 강조(딥 네이비 그라데이션) 카드. */
  accent?: boolean
  onClick?: () => void
  className?: string
}

export function KpiCard({
  label,
  value,
  icon,
  iconClassName,
  delta,
  deltaDir = 'neutral',
  accent = false,
  onClick,
  className,
}: KpiCardProps) {
  const clickable = typeof onClick === 'function'
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick?.() : undefined}
      className={cn(
        'relative overflow-hidden rounded-xl border p-4 px-[18px]',
        accent
          ? 'border-ink-700 bg-gradient-to-br from-ink-800 to-ink-700'
          : 'border-gray-200 bg-white',
        clickable && 'cursor-pointer transition hover:shadow-md',
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            'absolute right-3.5 top-3.5 grid h-[34px] w-[34px] place-items-center rounded-[9px]',
            accent ? 'bg-white/10 text-white' : (iconClassName ?? 'bg-primary-50 text-primary-600'),
          )}
        >
          {icon}
        </div>
      )}
      <div className={cn('text-[11.5px] font-semibold', accent ? 'text-white/70' : 'text-gray-500')}>
        {label}
      </div>
      <div
        className={cn(
          'mt-1.5 font-mono text-[26px] font-extrabold tracking-[-1px] tnum',
          accent ? 'text-white' : 'text-ink-900',
        )}
      >
        {value}
      </div>
      {delta && (
        <div
          className={cn(
            'mt-1 text-[11.5px] font-semibold',
            deltaDir === 'up' && 'text-success',
            deltaDir === 'down' && 'text-danger',
            deltaDir === 'neutral' && (accent ? 'text-white/60' : 'text-gray-400'),
          )}
        >
          {delta}
        </div>
      )}
    </div>
  )
}
