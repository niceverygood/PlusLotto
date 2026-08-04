// 이용자 테이블 컬럼 정의 + 역할별 기본 노출 프리셋 (CLAUDE §6).
// 등급/상태는 Badge/StatusChip, 숫자/일시는 mono. 상태·담당은 셀 인라인 편집.
import type { ColumnDef, VisibilityState } from '@tanstack/react-table'
import { Badge, NumCell, InlineSelect, statusColorVars, type InlineSelectOption } from '@/design-system/components'
import { dateShort, datetime, phone } from '@/lib/format'
import type { Member, MemberStatus, Role } from '@/types/db'
import { STATUS_META } from '@/design-system/labels'
import { CONSULT_STATUSES } from './views'
import { readMemos } from './api'

const STATUS_OPTIONS: InlineSelectOption[] = (
  ['active', 'suspended', 'deleted', 'withdrawn'] as MemberStatus[]
).map((s) => ({ value: s, label: STATUS_META[s].label }))

const CONSULT_OPTIONS: InlineSelectOption[] = [
  { value: '', label: '미지정' },
  ...CONSULT_STATUSES.map((s) => ({ value: s, label: s })),
]

export interface MemberColumnsCtx {
  pageOffset: number // 현재 페이지 시작 인덱스(No 표시용)
  staffOptions: InlineSelectOption[] // 담당 인라인 셀렉트 옵션([미지정] 포함)
  canEditStaff: boolean // 담당 변경 권한(rep 은 비활성)
  role: Role | null // 유입 컬럼 하드 차단(admin/manager 외 컬럼 자체 제거, 현장 피드백 7/21)
  onChangeStatus: (id: string, status: MemberStatus) => void
  onChangeStaff: (id: string, staffId: string) => void // '' = 미지정(리셋)
  onChangeConsult: (id: string, consult: string) => void // 상담상태 인라인 변경
}

const TEND_TONE: Record<string, string> = {
  적극: 'text-success',
  보통: 'text-gray-500',
  신중: 'text-warning',
  무응답: 'text-gray-400',
}

export function memberColumns(ctx: MemberColumnsCtx): ColumnDef<Member>[] {
  const staffNameById: Record<string, string> = {}
  for (const o of ctx.staffOptions) if (o.value) staffNameById[o.value] = o.label
  const cols: ColumnDef<Member>[] = [
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
      cell: (info) => {
        const m = info.row.original
        // 설정한 상태색을 목록에서도 표시(현장 8/4, 정의현 차장 — "회원정보창 들어가기 전에,
        // 목록에서도 상태가 설정한 색으로") — StatusChip 과 같은 --st-{key} 변수/톤 폴백.
        const sv = statusColorVars(m.status)
        return (
          <InlineSelect
            value={m.status}
            options={STATUS_OPTIONS}
            onChange={(v) => ctx.onChangeStatus(m.id, v as MemberStatus)}
            className="max-w-[88px] font-semibold"
            style={{ color: sv.color, backgroundColor: sv.backgroundColor, borderColor: 'transparent' }}
          />
        )
      },
    },
    {
      id: 'grade',
      header: '등급',
      accessorKey: 'grade',
      cell: (info) => <Badge grade={info.row.original.grade} />,
    },
    {
      id: 'staff',
      header: '담당',
      enableSorting: false,
      cell: (info) => {
        const m = info.row.original
        return (
          <InlineSelect
            value={m.assigned_staff_id ?? ''}
            options={ctx.staffOptions}
            disabled={!ctx.canEditStaff}
            onChange={(v) => ctx.onChangeStaff(m.id, v)}
          />
        )
      },
    },
    {
      id: 'user_id',
      header: 'ID',
      accessorKey: 'user_id',
      cell: (info) => (
        <span className="font-mono text-[12px] text-gray-600">{info.row.original.user_id}</span>
      ),
    },
    {
      id: 'name',
      header: '이름/닉',
      accessorKey: 'name',
      cell: (info) => {
        const m = info.row.original
        return (
          <div className="leading-tight">
            <div className="font-semibold text-ink-800">{m.name}</div>
            {m.nickname && <div className="text-[11px] text-gray-400">{m.nickname}</div>}
          </div>
        )
      },
    },
    {
      id: 'phone',
      header: '핸드폰',
      enableSorting: false,
      cell: (info) => (
        <span className="font-mono text-[12px] text-gray-600">{phone(info.row.original.phone)}</span>
      ),
    },
    {
      id: 'consult_status',
      header: '상담상태',
      enableSorting: false,
      cell: (info) => {
        const m = info.row.original
        return (
          <InlineSelect
            value={m.consult_status ?? ''}
            options={CONSULT_OPTIONS}
            onChange={(v) => ctx.onChangeConsult(m.id, v)}
            className="max-w-[96px]"
          />
        )
      },
    },
    {
      id: 'tendency',
      header: '성향',
      enableSorting: false,
      cell: (info) => {
        const t = info.row.original.tendency
        if (!t) return <span className="text-gray-300">-</span>
        return <span className={`text-[12px] font-semibold ${TEND_TONE[t] ?? 'text-gray-500'}`}>{t}</span>
      },
    },
    {
      id: 'inflow',
      header: '유입',
      enableSorting: false,
      cell: (info) => {
        const m = info.row.original
        if (!m.inflow_type) return <span className="text-gray-300">-</span>
        return (
          <div className="leading-tight">
            <div className="text-[12px] text-gray-700">{m.inflow_type}</div>
            {m.inflow_code && <div className="font-mono text-[10.5px] text-gray-400">{m.inflow_code}</div>}
          </div>
        )
      },
    },
    {
      id: 'memo',
      header: '메모',
      enableSorting: false,
      cell: (info) => {
        const memo = info.row.original.memo
        if (!memo) return <span className="text-gray-300">-</span>
        // 커서를 올리면 메모 이력 전체(작성자·시각순)를 보여준다(현장 피드백 8/3) — 최신 1건이 아니라 이력만.
        const history = readMemos(info.row.original)
          .filter((m) => !m.deleted_at)
          .slice()
          .reverse()
          .map((m) => `${datetime(m.created_at)} ${m.author ? (staffNameById[m.author] ?? m.author) : ''}: ${m.body}`)
          .join('\n')
        return (
          <span className="block max-w-[140px] truncate text-[12px] text-gray-600" title={history || memo}>
            {memo}
          </span>
        )
      },
    },
    {
      id: 'win',
      header: '당첨',
      enableSorting: false,
      cell: (info) => {
        const w = info.row.original.win_history
        if (!w) return <span className="text-gray-300">-</span>
        return <span className="text-[12px] font-semibold text-accent-600">{w}</span>
      },
    },
    {
      id: 'last_active_at',
      header: '활동',
      accessorKey: 'last_active_at',
      meta: { align: 'right' },
      cell: (info) => {
        const v = info.row.original.last_active_at
        return <NumCell muted={!v}>{v ? dateShort(v) : '미접속'}</NumCell>
      },
    },
    {
      id: 'registered_at',
      header: '가입일시',
      accessorKey: 'registered_at',
      meta: { align: 'right' },
      cell: (info) => <NumCell>{datetime(info.row.original.registered_at)}</NumCell>,
    },
  ]
  // 유입(유입코드/유입구분)은 최고관리자·관리자만 열람 — 컬럼 자체를 제거해 컬럼토글로도 켤 수 없게 한다(현장 피드백 7/21).
  const canSeeInflow = ctx.role === 'admin' || ctx.role === 'manager'
  return canSeeInflow ? cols : cols.filter((c) => c.id !== 'inflow')
}

/** 역할별 기본 컬럼 노출(현장 피드백).
 * - 유입(유입코드/유입구분)은 memberColumns() 에서 최고관리자·관리자 외엔 컬럼 자체를 제거(하드 차단).
 * - 팀장(rep)은 본인 담당만 보므로 '담당' 컬럼 숨김. */
export function memberColumnVisibility(role: Role | null): VisibilityState {
  const v: VisibilityState = {}
  if (role === 'rep') v.staff = false
  return v
}
