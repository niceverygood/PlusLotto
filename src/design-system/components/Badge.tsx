import type { ReactNode } from 'react'
import type { Grade } from '@/types/db'
import { GRADE_LABEL } from '@/design-system/labels'
import { cn } from '@/lib/cn'

/** 등급별 텍스트색 + 배경 + 도트색 (토큰 자동 매핑). */
const GRADE_CLASS: Record<Grade, { wrap: string; dot: string }> = {
  free: { wrap: 'bg-grade-free-bg text-grade-free', dot: 'bg-grade-free' },
  simple: { wrap: 'bg-grade-simple-bg text-grade-simple', dot: 'bg-grade-simple' },
  gold: { wrap: 'bg-grade-gold-bg text-grade-gold', dot: 'bg-grade-gold' },
  goldp: { wrap: 'bg-grade-goldp-bg text-grade-goldp', dot: 'bg-grade-goldp' },
  vip: { wrap: 'bg-grade-vip-bg text-grade-vip', dot: 'bg-grade-vip' },
  royal: { wrap: 'bg-grade-royal-bg text-grade-royal', dot: 'bg-grade-royal' },
  ovr: { wrap: 'bg-grade-ovr-bg text-grade-ovr', dot: 'bg-grade-ovr' },
  toss: { wrap: 'bg-grade-toss-bg text-grade-toss', dot: 'bg-grade-toss' },
}

interface BadgeProps {
  grade: Grade
  /** 라벨 오버라이드(상품명 등). 미지정 시 등급 한글 라벨. */
  children?: ReactNode
  className?: string
}

export function Badge({ grade, children, className }: BadgeProps) {
  const c = GRADE_CLASS[grade]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-full border border-transparent px-[9px] py-[3px] text-[11px] font-bold leading-[1.4]',
        c.wrap,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', c.dot)} />
      {children ?? GRADE_LABEL[grade]}
    </span>
  )
}
