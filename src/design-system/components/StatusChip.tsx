import { STATUS_META, type StatusKey, type StatusTone } from '@/design-system/labels'
import { cn } from '@/lib/cn'

const TONE_CLASS: Record<StatusTone, { wrap: string; dot: string }> = {
  success: { wrap: 'bg-success-bg text-success border-success-bd', dot: 'bg-success' },
  warning: { wrap: 'bg-warning-bg text-warning border-warning-bd', dot: 'bg-warning' },
  danger: { wrap: 'bg-danger-bg text-danger border-danger-bd', dot: 'bg-danger' },
  info: { wrap: 'bg-info-bg text-info border-info-bd', dot: 'bg-info' },
  gray: { wrap: 'bg-gray-100 text-gray-500 border-gray-200', dot: 'bg-gray-400' },
  stop: { wrap: 'bg-danger-bg text-danger border-danger-bd', dot: 'bg-danger' },
}

type StatusChipProps =
  | { status: StatusKey; tone?: never; label?: never; className?: string }
  | { status?: never; tone: StatusTone; label: string; className?: string }

/**
 * 상태 칩. 두 가지 사용법:
 * - `<StatusChip status="active" />` (회원/결제 상태 자동 매핑)
 * - `<StatusChip tone="info" label="답변완료" />` (임의 상태)
 */
export function StatusChip(props: StatusChipProps) {
  const tone = props.status ? STATUS_META[props.status].tone : props.tone
  const label = props.status ? STATUS_META[props.status].label : props.label
  const c = TONE_CLASS[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-md border px-[9px] py-[3px] text-[11px] font-bold leading-none',
        c.wrap,
        props.className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', c.dot)} />
      {label}
    </span>
  )
}
