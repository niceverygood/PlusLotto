// 로또 회차 테이블 컬럼 (CLAUDE §6, BUILD_PROMPTS P6-1):
// 회차·추첨일·당첨번호(볼)·합·홀짝·출현율·1·2·3등 당첨금·총판매금액·베팅·상태(당첨확정).
import type { ColumnDef } from '@tanstack/react-table'
import { Button, LottoBalls, NumCell } from '@/design-system/components'
import { cn } from '@/lib/cn'
import { date, krw, num } from '@/lib/format'
import type { RoundRow } from './api'

export interface LottoColumnsCtx {
  onConfirm: (roundNo: number) => void
}

export function lottoColumns(ctx: LottoColumnsCtx): ColumnDef<RoundRow>[] {
  return [
    {
      id: 'round_no',
      header: '회차',
      accessorKey: 'round_no',
      meta: { align: 'right' },
      cell: (info) => <NumCell>{num(info.row.original.round_no)}회</NumCell>,
    },
    {
      id: 'draw_date',
      header: '추첨일',
      accessorKey: 'draw_date',
      cell: (info) => (
        <span className="font-mono text-[12px] tnum text-gray-600">
          {date(info.row.original.draw_date)}
        </span>
      ),
    },
    {
      id: 'numbers',
      header: '당첨번호',
      enableSorting: false,
      cell: (info) => (
        <LottoBalls numbers={info.row.original.numbers} bonus={info.row.original.bonus} size="sm" />
      ),
    },
    {
      id: 'sum_oe',
      header: '합 · 홀짝',
      enableSorting: false,
      meta: { align: 'right' },
      cell: (info) => {
        const r = info.row.original
        return (
          <span className="font-mono text-[12px] tnum text-gray-600">
            {num(r.sum)} · {r.odd_even}
          </span>
        )
      },
    },
    {
      id: 'appear_rate',
      header: '출현율',
      accessorKey: 'appear_rate',
      meta: { align: 'right' },
      cell: (info) => {
        const v = info.row.original.appear_rate
        return v == null ? (
          <span className="text-gray-300">-</span>
        ) : (
          <NumCell muted>{v}%</NumCell>
        )
      },
    },
    {
      id: 'prize_1',
      header: '1등',
      accessorKey: 'prize_1',
      meta: { align: 'right' },
      cell: (info) => <NumCell>{krw(info.row.original.prize_1 ?? 0)}</NumCell>,
    },
    {
      id: 'prize_2',
      header: '2등',
      accessorKey: 'prize_2',
      meta: { align: 'right' },
      cell: (info) => <NumCell muted>{krw(info.row.original.prize_2 ?? 0)}</NumCell>,
    },
    {
      id: 'prize_3',
      header: '3등',
      accessorKey: 'prize_3',
      meta: { align: 'right' },
      cell: (info) => <NumCell muted>{krw(info.row.original.prize_3 ?? 0)}</NumCell>,
    },
    {
      id: 'total_sales',
      header: '총판매금액',
      accessorKey: 'total_sales',
      meta: { align: 'right' },
      cell: (info) => <NumCell>{krw(info.row.original.total_sales ?? 0)}</NumCell>,
    },
    {
      id: 'betCount',
      header: '베팅',
      accessorKey: 'betCount',
      meta: { align: 'right' },
      cell: (info) => {
        const r = info.row.original
        return (
          <span className="font-mono text-[12px] tnum text-gray-600">
            {num(r.betCount)}
            {r.confirmed_at && r.winnerCount > 0 && (
              <span className="ml-1 text-success">·{num(r.winnerCount)}당첨</span>
            )}
          </span>
        )
      },
    },
    {
      id: 'rankCounts',
      header: '등수별 당첨(1~5등)',
      enableSorting: false,
      meta: { align: 'right' },
      cell: (info) => {
        const r = info.row.original
        if (!r.confirmed_at) return <span className="text-gray-300">-</span>
        return (
          <span className="font-mono text-[12px] tnum text-gray-600">
            {r.rankCounts.map((c, i) => (
              <span key={i} className={cn('ml-1.5 first:ml-0', c > 0 && 'font-bold text-success')}>
                {i + 1}등 {num(c)}
              </span>
            ))}
          </span>
        )
      },
    },
    {
      id: 'status',
      header: '상태',
      enableSorting: false,
      cell: (info) => {
        const r = info.row.original
        if (r.confirmed_at) {
          // 확정된 회차도 '재집계'로 다시 돌릴 수 있어야 한다(현장 8/10 — "이미 상태가 확정인데
          // 어떤 부분을 누르라는 말씀이실까요?"). confirmRound 는 원래 멱등 재산정을 지원하는데
          // 확정 뒤에는 버튼이 사라져 화면에서 실행할 방법이 없었다. 당첨이력(win_records) 백필처럼
          // 이미 확정된 회차를 다시 집계해야 하는 상황이 실제로 있어 상시 노출한다.
          return (
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-flex items-center gap-[5px] rounded-full px-[9px] py-[3px] text-[11px] font-bold',
                  'bg-success-bg text-success',
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                확정
              </span>
              <Button
                variant="sec"
                size="sm"
                title="당첨자를 다시 집계합니다(회원 당첨이력 재생성). 여러 번 눌러도 안전합니다."
                onClick={(e) => {
                  e.stopPropagation()
                  ctx.onConfirm(r.round_no)
                }}
              >
                재집계
              </Button>
            </div>
          )
        }
        return (
          <Button
            variant="pri"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              ctx.onConfirm(r.round_no)
            }}
          >
            당첨 확정
          </Button>
        )
      },
    },
  ]
}
