// 결제 목록 (CLAUDE §6·§8). 상태 탭(전체/대기/승인/실패/취소) + FilterBar(검색·결제수단·PG·담당,
// URL 동기화) + DataTable(서버 정렬·페이지) + 행 클릭 → 상세 Drawer(승인/PG취소). 수기결제 등록 링크.
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import type { OnChangeFn, SortingState } from '@tanstack/react-table'
import {
  Button,
  DataTable,
  FilterBar,
  PageHeader,
  Tabs,
  type FilterChip,
  type TabItem,
} from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useUrlFilters } from '@/lib/useUrlFilters'
import { useStaff } from '@/lib/staff'
import { GRADE_LABEL, PAYMENT_METHOD_LABEL } from '@/design-system/labels'
import type { Grade, PaymentMethod } from '@/types/db'
import {
  PAYMENT_STATUS_TABS,
  usePaymentCounts,
  usePayments,
  type PaymentsQuery,
  type PaymentStatusTab,
} from './api'
import { paymentColumns } from './columns'
import { PaymentDrawer } from './PaymentDrawer'

const PAGE_SIZE = 50
const METHODS: PaymentMethod[] = ['bank', 'manual', 'pg']
const PRODUCT_GRADES: Grade[] = ['goldp', 'vip', 'royal']
const PG_PROVIDERS = ['웰컴페이먼츠', '페이허브', '플러스페이']
const TAB_LABEL: Record<PaymentStatusTab, string> = {
  all: '전체',
  wait: '대기',
  approved: '승인',
  failed: '실패',
  cancelled: '취소',
}

const selectCls =
  'h-9 rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500'

export function PaymentsPage() {
  usePageMeta('결제', '다중 PG · 승인/취소 · 매출 귀속')
  const navigate = useNavigate()
  const { get, set, setMany, remove, clear } = useUrlFilters()
  const { data: staff = [] } = useStaff()

  const [selectedId, setSelectedId] = useState<string | null>(null)

  const statusTab = (get('st') ?? 'all') as PaymentStatusTab
  const search = get('q') ?? ''
  const page = Math.max(1, Number(get('page') ?? '1') || 1)
  const sortRaw = get('sort')
  const [sortId, sortDirRaw] = sortRaw ? sortRaw.split(':') : [undefined, undefined]
  const sortDesc = sortDirRaw === 'desc'

  const methodF = get('m') as PaymentMethod | undefined
  const gradeRaw = get('g') as Grade | undefined
  const gradeF = gradeRaw && PRODUCT_GRADES.includes(gradeRaw) ? gradeRaw : undefined
  const pgF = get('pg')
  const staffF = get('staff')
  const dateFromF = get('rf') // 결제일 범위(현장 피드백)
  const dateToF = get('rt')

  const query: PaymentsQuery = {
    status: statusTab,
    search,
    grade: gradeF ?? '',
    method: methodF ?? '',
    pg: pgF,
    staffId: staffF,
    dateFrom: dateFromF,
    dateTo: dateToF,
    page,
    pageSize: PAGE_SIZE,
    sortId,
    sortDesc,
  }

  const { data, isLoading, isFetching } = usePayments(query)
  const { data: counts } = usePaymentCounts()

  const staffNames = useMemo(() => {
    const m: Record<string, string> = {}
    for (const s of staff) m[s.id] = s.name
    return m
  }, [staff])

  const pageOffset = (page - 1) * PAGE_SIZE
  const openMember = useCallback(
    (memberId: string) => navigate(`/admin/members?member=${encodeURIComponent(memberId)}`),
    [navigate],
  )
  const columns = useMemo(
    () => paymentColumns({ pageOffset, staffNames, onMemberClick: openMember }),
    [openMember, pageOffset, staffNames],
  )

  const sorting: SortingState = sortId ? [{ id: sortId, desc: sortDesc }] : []
  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater
    const s = next[0]
    setMany({ sort: s ? `${s.id}:${s.desc ? 'desc' : 'asc'}` : null }, { resetPage: true })
  }

  const tabs: TabItem[] = PAYMENT_STATUS_TABS.map((k) => ({
    key: k,
    label: TAB_LABEL[k],
    count: counts?.[k],
  }))

  const chips: FilterChip[] = []
  if (gradeF)
    chips.push({ key: 'g', label: `등급: ${GRADE_LABEL[gradeF]}`, onRemove: () => remove('g') })
  if (methodF)
    chips.push({ key: 'm', label: `수단: ${PAYMENT_METHOD_LABEL[methodF]}`, onRemove: () => remove('m') })
  if (pgF) chips.push({ key: 'pg', label: `PG: ${pgF}`, onRemove: () => remove('pg') })
  if (staffF) {
    const name = staff.find((s) => s.id === staffF)?.name ?? staffF
    chips.push({ key: 'staff', label: `담당: ${name}`, onRemove: () => remove('staff') })
  }
  if (dateFromF || dateToF)
    chips.push({
      key: 'date',
      label: `결제일: ${dateFromF ?? '…'} ~ ${dateToF ?? '…'}`,
      onRemove: () => setMany({ rf: null, rt: null }, { resetPage: true }),
    })

  return (
    <div>
      <PageHeader
        title="결제"
        description="결제 승인 · PG취소 · 매출 귀속 (§8 회원 등급/상태 연동)"
        actions={
          <Button variant="pri" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/payments/manual')}>
            수기결제 등록
          </Button>
        }
      />

      <Tabs
        tabs={tabs}
        value={statusTab}
        onChange={(k) => setMany({ st: k === 'all' ? null : k, page: null })}
        className="mb-3"
      />

      <FilterBar
        className="mb-3"
        searchValue={search}
        onSearchChange={(v) => set('q', v, { resetPage: true })}
        chips={chips}
        onClearAll={chips.length > 0 ? () => clear(['st']) : undefined}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="회원등급">
            <select
              className={selectCls}
              value={gradeF ?? ''}
              onChange={(e) => set('g', e.target.value || null, { resetPage: true })}
            >
              <option value="">전체</option>
              {PRODUCT_GRADES.map((grade) => (
                <option key={grade} value={grade}>
                  {GRADE_LABEL[grade]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="결제수단">
            <select
              className={selectCls}
              value={methodF ?? ''}
              onChange={(e) => set('m', e.target.value || null, { resetPage: true })}
            >
              <option value="">전체</option>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="PG사">
            <select
              className={selectCls}
              value={pgF ?? ''}
              onChange={(e) => set('pg', e.target.value || null, { resetPage: true })}
            >
              <option value="">전체</option>
              {PG_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="담당">
            <select
              className={selectCls}
              value={staffF ?? ''}
              onChange={(e) => set('staff', e.target.value || null, { resetPage: true })}
            >
              <option value="">전체</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          {/* 결제일 범위(현장 피드백) — 승인일(paid_at) 기준, 미승인 건은 등록일 */}
          <Field label="결제일(부터)">
            <input
              type="date"
              className={selectCls}
              value={dateFromF ?? ''}
              onChange={(e) => set('rf', e.target.value || null, { resetPage: true })}
            />
          </Field>
          <Field label="결제일(까지)">
            <input
              type="date"
              className={selectCls}
              value={dateToF ?? ''}
              onChange={(e) => set('rt', e.target.value || null, { resetPage: true })}
            />
          </Field>
        </div>
      </FilterBar>

      <DataTable
        columns={columns}
        data={data?.rows ?? []}
        getRowId={(p) => p.id}
        isLoading={isLoading}
        onRowClick={(p) => setSelectedId(p.id)}
        sorting={sorting}
        onSortingChange={onSortingChange}
        resultLabel={(total) => (
          <>
            {TAB_LABEL[statusTab]} <b className="font-mono text-ink-800 tnum">{total.toLocaleString('ko-KR')}</b>건
            {isFetching && <span className="ml-2 text-gray-400">갱신중…</span>}
          </>
        )}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onPageChange: (p) => set('page', p === 1 ? null : p),
        }}
      />

      <PaymentDrawer paymentId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">{label}</span>
      {children}
    </label>
  )
}
