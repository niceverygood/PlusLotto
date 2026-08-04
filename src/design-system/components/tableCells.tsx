import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** 숫자/금액/일시 셀 — 우측정렬 + mono + tnum. */
export function NumCell({
  children,
  muted,
  className,
}: {
  children: ReactNode
  muted?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'block text-right font-mono tnum',
        muted ? 'text-gray-400' : 'text-ink-800',
        className,
      )}
    >
      {children}
    </span>
  )
}

export interface InlineSelectOption {
  value: string
  label: string
}

/** 인라인 편집 셀 — select 형. 행 클릭과 분리되도록 stopPropagation. */
export function InlineSelect({
  value,
  options,
  onChange,
  disabled,
  className,
  style,
}: {
  value: string
  options: InlineSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
  /** 값에 따라 셀 색을 입힐 때(예: 상태색 커스터마이즈, 현장 8/4) — 인라인 스타일이 클래스보다 우선. */
  style?: CSSProperties
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation()
        onChange(e.target.value)
      }}
      className={cn(
        'h-7 max-w-[120px] rounded-md border border-gray-200 bg-white px-1.5 text-[12px] text-gray-700 outline-none transition-colors hover:border-gray-300 focus:border-primary-500 disabled:opacity-50',
        className,
      )}
      style={style}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
