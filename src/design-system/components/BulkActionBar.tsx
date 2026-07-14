import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

interface BulkActionBarProps {
  count: number
  onClear: () => void
  children?: ReactNode
}

/** 행 선택 시 테이블 하단에 등장하는 일괄작업 바 (네이비). */
export function BulkActionBar({ count, onClear, children }: BulkActionBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-gray-200 bg-ink-800 px-3 py-2.5 text-[12px] text-white">
      <span className="font-bold tnum">{count.toLocaleString('ko-KR')}건 선택됨</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
        선택 해제
      </button>
    </div>
  )
}

/** 일괄작업 바 전용 버튼 (어두운 배경용). */
export function BulkButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-white/20 bg-white/10 px-2.5 py-1.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-white/20',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
