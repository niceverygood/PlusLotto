import { cn } from '@/lib/cn'

// 동행복권 공식 색대(번호 구간별)를 토큰으로 매핑. 노랑 볼만 가독성 위해 짙은 텍스트.
function ballClass(n: number): string {
  if (n <= 10) return 'bg-ball-y text-ink-900'
  if (n <= 20) return 'bg-ball-b text-white'
  if (n <= 30) return 'bg-ball-r text-white'
  if (n <= 40) return 'bg-ball-k text-white'
  return 'bg-ball-g text-white'
}

const SIZE = {
  sm: 'h-6 w-6 text-[11px]',
  md: 'h-8 w-8 text-[13px]',
  lg: 'h-10 w-10 text-[15px]',
} as const

export interface LottoBallsProps {
  numbers: number[]
  /** 지정 시 마지막에 "+" 구분 후 보너스 볼 표시. */
  bonus?: number | null
  size?: keyof typeof SIZE
  /** 강조할 번호(예: 당첨번호와 일치하는 베팅 번호). 미강조 번호는 흐리게. */
  highlight?: number[]
  className?: string
}

/** 로또 번호 볼 표시 — 로또기록·베팅 등에서 재사용. */
export function LottoBalls({ numbers, bonus, size = 'md', highlight, className }: LottoBallsProps) {
  const hl = highlight ? new Set(highlight) : null
  const dim = (n: number) => hl != null && !hl.has(n)
  const ball = (n: number, key: string) => (
    <span
      key={key}
      className={cn(
        'inline-grid place-items-center rounded-full font-bold tabular-nums',
        SIZE[size],
        ballClass(n),
        dim(n) && 'opacity-25',
      )}
    >
      {n}
    </span>
  )
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {numbers.map((n, i) => ball(n, `n${i}`))}
      {bonus != null && (
        <>
          <span className="px-0.5 text-gray-400" aria-label="보너스">
            +
          </span>
          {ball(bonus, 'bonus')}
        </>
      )}
    </span>
  )
}
