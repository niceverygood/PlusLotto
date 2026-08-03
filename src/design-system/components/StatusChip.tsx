import { STATUS_META, type StatusKey, type StatusTone } from '@/design-system/labels'
import { cn } from '@/lib/cn'

// 톤별 기본색 CSS 변수(tokens.css 에 이미 존재, §3) — 상태값별 커스터마이즈(--st-{key}) 전 폴백이자
// tone 만으로 쓰는 임의 라벨(StatusChip tone=... label=...) 용 색상.
const TONE_VAR: Record<StatusTone, { fg: string; bg: string }> = {
  success: { fg: 'var(--success)', bg: 'var(--success-bg)' },
  warning: { fg: 'var(--warning)', bg: 'var(--warning-bg)' },
  danger: { fg: 'var(--danger)', bg: 'var(--danger-bg)' },
  info: { fg: 'var(--info)', bg: 'var(--info-bg)' },
  gray: { fg: 'var(--gray-500)', bg: 'var(--gray-100)' },
  stop: { fg: 'var(--danger)', bg: 'var(--danger-bg)' },
}

type StatusChipProps =
  | { status: StatusKey; tone?: never; label?: never; className?: string }
  | { status?: never; tone: StatusTone; label: string; className?: string }

/**
 * 상태 칩. 두 가지 사용법:
 * - `<StatusChip status="active" />` (회원/결제 상태 자동 매핑 — 색은 설정(§상태색)에서 커스터마이즈 가능)
 * - `<StatusChip tone="info" label="답변완료" />` (임의 상태, 톤 기본색 고정)
 */
export function StatusChip(props: StatusChipProps) {
  const tone = props.status ? STATUS_META[props.status].tone : props.tone
  const label = props.status ? STATUS_META[props.status].label : props.label
  const t = TONE_VAR[tone]
  // status 가 있으면 설정에서 커스터마이즈한 --st-{key}/--st-{key}-bg 를 우선 쓰고, 없으면(마이그레이션
  // 전·미설정) 톤 기본색으로 폴백한다(lib/gradeTheme.ts applyStatusColors 가 로그인 시 이 변수를 세팅).
  const color = props.status ? `var(--st-${props.status}, ${t.fg})` : t.fg
  const backgroundColor = props.status ? `var(--st-${props.status}-bg, ${t.bg})` : t.bg
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-md border border-transparent px-[9px] py-[3px] text-[11px] font-bold leading-none',
        props.className,
      )}
      style={{ color, backgroundColor }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}
