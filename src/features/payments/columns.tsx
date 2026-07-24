// 결제 테이블 컬럼 정의 (CLAUDE §6). 컬럼 순서(현장 피드백 7/23 — 담당자 바로 오른쪽에 유저 배치):
// No·상태·담당·유저·결제수단·PG·금액·상품(Badge)·기간·유입코드·입금자명·결제일시.
import type { ColumnDef } from '@tanstack/react-table'
import { Badge, NumCell, StatusChip } from '@/design-system/components'
import { date, datetime, krw } from '@/lib/format'
import { PAYMENT_METHOD_LABEL } from '@/design-system/labels'
import type { PaymentRow } from './api'

export interface PaymentColumnsCtx {
  pageOffset: number
  staffNames: Record<string, string>
  onMemberClick: (memberId: string) => void
}

export function paymentColumns(ctx: PaymentColumnsCtx): ColumnDef<PaymentRow>[] {
  return [
    {
      id: 'no',
      header: 'No',
      enableSorting: false,
      enableHiding: false,
      meta: { align: 'right' },
      cell: (info) => <NumCell muted>{ctx.pageOffset + info.row.index + 1}</NumCell>,
    },
    {
      id: 'status',
      header: '상태',
      accessorKey: 'status',
      cell: (info) => <StatusChip status={info.row.original.status} />,
    },
    {
      id: 'staff',
      header: '담당',
      enableSorting: false,
      cell: (info) => {
        const sid = info.row.original.staff_id
        const name = sid ? ctx.staffNames[sid] : null
        return name ? (
          <span className="text-[12.5px] text-gray-700">{name}</span>
        ) : (
          <span className="text-gray-300">-</span>
        )
      },
    },
    {
      id: 'user',
      header: '유저',
      enableSorting: false,
      cell: (info) => {
        const m = info.row.original.member
        if (!m) return <span className="text-gray-300">-</span>
        return (
          <button
            type="button"
            className="text-left leading-tight hover:underline"
            onClick={(event) => {
              event.stopPropagation()
              ctx.onMemberClick(m.id)
            }}
          >
            <div className="font-semibold text-ink-800">{m.name}</div>
            <div className="font-mono text-[10.5px] text-gray-400">{m.user_id}</div>
          </button>
        )
      },
    },
    {
      id: 'method',
      header: '결제수단',
      accessorKey: 'method',
      cell: (info) => (
        <span className="text-[12.5px] text-gray-700">{PAYMENT_METHOD_LABEL[info.row.original.method]}</span>
      ),
    },
    {
      id: 'pg',
      header: 'PG',
      enableSorting: false,
      cell: (info) => {
        const pg = info.row.original.pg_provider
        return pg ? (
          <span className="text-[12px] text-gray-600">{pg}</span>
        ) : (
          <span className="text-gray-300">-</span>
        )
      },
    },
    {
      id: 'amount',
      header: '금액',
      accessorKey: 'amount',
      meta: { align: 'right' },
      cell: (info) => <NumCell>{krw(info.row.original.amount)}</NumCell>,
    },
    {
      id: 'product',
      header: '상품',
      enableSorting: false,
      cell: (info) => {
        const pr = info.row.original.product
        if (!pr) return <span className="text-gray-300">-</span>
        return <Badge grade={pr.grade_granted}>{pr.name}</Badge>
      },
    },
    {
      id: 'period',
      header: '기간',
      enableSorting: false,
      meta: { align: 'right' },
      cell: (info) => {
        const p = info.row.original
        if (!p.period_start && !p.period_end) return <span className="text-gray-300">-</span>
        return (
          <span className="font-mono text-[11px] tnum text-gray-500">
            {date(p.period_start)} ~ {date(p.period_end)}
          </span>
        )
      },
    },
    {
      id: 'inflow_code',
      header: '유입코드',
      enableSorting: false,
      cell: (info) => {
        const code = info.row.original.member?.inflow_code
        return code ? (
          <span className="font-mono text-[11px] text-gray-500">{code}</span>
        ) : (
          <span className="text-gray-300">-</span>
        )
      },
    },
    {
      id: 'depositor',
      header: '입금자명',
      enableSorting: false,
      cell: (info) => {
        const d = info.row.original.depositor_name
        return d ? (
          <span className="text-[12.5px] text-gray-700">{d}</span>
        ) : (
          <span className="text-gray-300">-</span>
        )
      },
    },
    {
      id: 'paid_at',
      header: '결제일시',
      accessorKey: 'paid_at',
      meta: { align: 'right' },
      cell: (info) => {
        const p = info.row.original
        return <NumCell muted={!p.paid_at}>{datetime(p.paid_at ?? p.created_at)}</NumCell>
      },
    },
  ]
}
