// 나의고객 — 담당현황 (CLAUDE §4·§8). 내가 담당하는 회원만(assigned_staff_id===나)
// 보여주는 이용자 화면의 포커스 뷰. 이용자 모듈의 컬럼·일괄작업·상세 Drawer 를 재사용한다.
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageSquare } from 'lucide-react'
import type { OnChangeFn, SortingState } from '@tanstack/react-table'
import { Button, DataTable, FilterBar, PageHeader, Tabs, type TabItem } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useUrlFilters } from '@/lib/useUrlFilters'
import { useRole } from '@/lib/auth'
import { useMemberDrawerStore } from '@/lib/memberDrawerStore'
import { useStaff } from '@/lib/staff'
import {
  useMyCustomers,
  useMyCustomerCounts,
  useUpdateMember,
  useAssignStaff,
  useResetAssign,
  type MembersQuery,
} from './api'
import { getView, type MemberFilter } from './views'
import { memberColumns } from './columns'
import { MemberBulkActions } from './bulk'

const PAGE_SIZE = 50
// 나의고객에서 자주 보는 케이스로드 하위 뷰(이용자 뷰 프리셋 재사용).
const MY_TAB_KEYS = ['all', 'today-join', 'no-outcall-all', 'paid', 'winner'] as const

export function MyCustomersPage() {
  usePageMeta('나의 고객', '내가 담당하는 회원 · 아웃콜 · 문자')
  const role = useRole()
  const navigate = useNavigate()
  const { get, set, setMany } = useUrlFilters()
  const { data: staff = [] } = useStaff()

  // 회원상세는 전역 Drawer(AppShell, 현장 피드백 7/23) — 화면 이동 없이 뜬다.
  const openMemberDrawer = useMemberDrawerStore((s) => s.open)

  const viewKey = get('view') ?? 'all'
  const search = get('q') ?? ''
  const page = Math.max(1, Number(get('page') ?? '1') || 1)
  const sortRaw = get('sort')
  const [sortId, sortDirRaw] = sortRaw ? sortRaw.split(':') : [undefined, undefined]
  const sortDesc = sortDirRaw === 'desc'

  const extra: MemberFilter = {}
  const query: MembersQuery = {
    view: viewKey,
    search,
    extra,
    page,
    pageSize: PAGE_SIZE,
    sortId,
    sortDesc,
  }

  const { data, isLoading, isFetching } = useMyCustomers(query)
  const { data: counts } = useMyCustomerCounts()

  const updateMember = useUpdateMember()
  const assignStaff = useAssignStaff()
  const resetAssign = useResetAssign()

  const staffOptions = useMemo(
    () => [{ value: '', label: '미지정' }, ...staff.map((s) => ({ value: s.id, label: s.name }))],
    [staff],
  )
  const pageOffset = (page - 1) * PAGE_SIZE
  const columns = useMemo(
    () =>
      memberColumns({
        pageOffset,
        staffOptions,
        role,
        canEditStaff: role !== 'rep',
        onChangeStatus: (id, status) => updateMember.mutate({ id, patch: { status } }),
        onChangeStaff: (id, staffId) =>
          staffId ? assignStaff.mutate({ ids: [id], staffId }) : resetAssign.mutate({ ids: [id] }),
        onChangeConsult: (id, consult) =>
          updateMember.mutate({ id, patch: { consult_status: consult || null } }),
      }),
    [pageOffset, staffOptions, role], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const sorting: SortingState = sortId ? [{ id: sortId, desc: sortDesc }] : []
  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater
    const s = next[0]
    setMany({ sort: s ? `${s.id}:${s.desc ? 'desc' : 'asc'}` : null }, { resetPage: true })
  }

  const tabs: TabItem[] = MY_TAB_KEYS.map((k) => ({
    key: k,
    label: getView(k).label,
    count: counts?.[k],
  }))

  return (
    <div>
      <PageHeader
        title="나의 고객"
        description="내가 담당하는 회원의 케이스로드 · 아웃콜 · 문자 발송"
        actions={
          <Button variant="sec" size="sm" onClick={() => navigate('/my/sms')}>
            <MessageSquare className="h-4 w-4" /> 문자 발송
          </Button>
        }
      />

      <div className="mb-3">
        <Tabs
          tabs={tabs}
          value={viewKey}
          onChange={(k) => setMany({ view: k === 'all' ? null : k, page: null })}
        />
      </div>

      <FilterBar
        className="mb-3"
        searchValue={search}
        onSearchChange={(v) => set('q', v, { resetPage: true })}
        chips={[]}
      />

      <DataTable
        key={role ?? 'none'}
        columns={columns}
        data={data?.rows ?? []}
        getRowId={(m) => m.id}
        isLoading={isLoading}
        onRowClick={(m) => openMemberDrawer(m.id)}
        enableSelection
        bulkActions={(ctx) => <MemberBulkActions {...ctx} />}
        sorting={sorting}
        onSortingChange={onSortingChange}
        initialColumnVisibility={{ staff: false }}
        resultLabel={(total) => (
          <>
            {getView(viewKey).label} <b className="font-mono text-ink-800 tnum">{total.toLocaleString('ko-KR')}</b>건
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
    </div>
  )
}
