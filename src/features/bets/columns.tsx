// 베팅 테이블 컬럼 (CLAUDE §6, BUILD_PROMPTS P6-2):
// 고유넘버·회차·발행·유저(ref)·번호조합(볼, 당첨번호 일치 강조)·등수·당첨금.
import type { ColumnDef } from '@tanstack/react-table'
import { LottoBalls, NumCell } from '@/design-system/components'
import { cn } from '@/lib/cn'
import { krw, num } from '@/lib/format'
import { rankLabel } from '@/lib/lotto'
import type { BetRow } from './api'

const RANK_CLASS: Record<number, string> = {
  1: 'bg-grade-gold-bg text-grade-gold',
  2: 'bg-primary-50 text-primary-700',
  3: 'bg-info-bg text-info',
  4: 'bg-gray-100 text-gray-600',
  5: 'bg-gray-100 text-gray-600',
}

function RankChip({ row }: { row: BetRow }) {
  if (!row.confirmed) {
    return <span className="text-[11.5px] font-semibold text-gray-400">미정</span>
  }
  if (row.rank == null) {
    return <span className="text-[11.5px] text-gray-400">미당첨</span>
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-[9px] py-[3px] text-[11px] font-bold',
        RANK_CLASS[row.rank],
      )}
    >
      {rankLabel(row.rank)}
    </span>
  )
}

export function betColumns(): ColumnDef<BetRow>[] {
  return [
    {
      id: 'id',
      header: '고유넘버',
      accessorKey: 'id',
      enableSorting: false,
      cell: (info) => <span className="font-mono text-[11px] text-gray-400">{info.row.original.id}</span>,
    },
    {
      id: 'round_no',
      header: '회차',
      accessorKey: 'round_no',
      meta: { align: 'right' },
      cell: (info) => <NumCell>{num(info.row.original.round_no)}회</NumCell>,
    },
    {
      id: 'issuer',
      header: '발행',
      enableSorting: false,
      cell: (info) => {
        const v = info.row.original.issuer
        return v ? <span className="text-[12.5px] text-gray-700">{v}</span> : <span className="text-gray-300">-</span>
      },
    },
    {
      id: 'user',
      header: '유저',
      enableSorting: false,
      cell: (info) => {
        const b = info.row.original
        if (b.memberName) {
          return (
            <div className="leading-tight">
              <div className="font-semibold text-ink-800">{b.memberName}</div>
              <div className="font-mono text-[10.5px] text-gray-400">{b.member_ref}</div>
            </div>
          )
        }
        return b.member_ref ? (
          <span className="font-mono text-[11.5px] text-gray-500">{b.member_ref}</span>
        ) : (
          <span className="text-gray-300">-</span>
        )
      },
    },
    {
      id: 'numbers',
      header: '번호조합',
      enableSorting: false,
      cell: (info) => {
        const b = info.row.original
        const highlight =
          b.confirmed && b.win ? b.numbers.filter((n) => b.win!.includes(n)) : undefined
        return <LottoBalls numbers={b.numbers} size="sm" highlight={highlight} />
      },
    },
    {
      id: 'rank',
      header: '등수',
      accessorKey: 'rank',
      cell: (info) => <RankChip row={info.row.original} />,
    },
    {
      id: 'prize',
      header: '당첨금',
      accessorKey: 'prize',
      meta: { align: 'right' },
      cell: (info) => {
        const p = info.row.original.prize
        return p ? <NumCell>{krw(p)}</NumCell> : <NumCell muted>-</NumCell>
      },
    },
  ]
}
