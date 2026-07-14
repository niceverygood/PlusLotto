// 이용자 — 수직 슬라이스의 본체 (CLAUDE §6·§7·§8). 탭(자주쓰는 6뷰)+더보기,
// FilterBar(검색·등급·상태·담당·유입, URL 동기화), DataTable(서버 정렬·페이지·선택),
// 일괄작업 바, 행 클릭 → 상세 Drawer. 모든 데이터는 api 훅 경유.
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Plus, Upload } from 'lucide-react'
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
import { useRole } from '@/lib/auth'
import { useStaff } from '@/lib/staff'
import { GRADE_LABEL, STATUS_META } from '@/design-system/labels'
import type { Grade, MemberStatus } from '@/types/db'
import {
  useMembers,
  useMemberViewCounts,
  useInflowCodes,
  useUpdateMember,
  useAssignStaff,
  useResetAssign,
  type MembersQuery,
} from './api'
import {
  getView,
  CONSULT_STATUSES,
  INFLOW_TYPES,
  MORE_VIEWS,
  PAGE_SIZE_OPTIONS,
  DEFAULT_PAGE_SIZE,
  TAB_VIEWS,
  type MemberFilter,
  type ViewGroup,
} from './views'
import { memberColumns, memberColumnVisibility } from './columns'
import { MemberBulkActions } from './bulk'
import { MemberDrawer } from './MemberDrawer'
import { MemberCreateDrawer } from './MemberCreateDrawer'
import { ImportMembersModal } from './ImportMembersModal'

const GRADES: Grade[] = ['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']
const STATUSES: MemberStatus[] = ['active', 'suspended', 'deleted', 'withdrawn']
const GROUP_ORDER: ViewGroup[] = ['상태', '등급', '담당', '유입', '운영']

const selectCls =
  'h-9 rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500'

export function MembersPage() {
  usePageMeta('이용자', '26 세그먼트 · 필터 · 일괄작업 · 상세')
  const role = useRole()
  const { get, set, setMany, remove, clear } = useUrlFilters()
  const { data: staff = [] } = useStaff()

  const [moreOpen, setMoreOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  // ── URL → 쿼리 상태 ──────────────────────────────
  const viewKey = get('view') ?? 'all'
  const search = get('q') ?? ''
  const page = Math.max(1, Number(get('page') ?? '1') || 1)
  const sizeRaw = Number(get('size') ?? '') || DEFAULT_PAGE_SIZE
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(sizeRaw) ? sizeRaw : DEFAULT_PAGE_SIZE
  const sortRaw = get('sort')
  const [sortId, sortDirRaw] = sortRaw ? sortRaw.split(':') : [undefined, undefined]
  const sortDesc = sortDirRaw === 'desc'

  const gradeF = get('g') as Grade | undefined
  const statusF = get('st') as MemberStatus | undefined
  const staffF = get('staff')
  const inflowF = get('inflow')
  const inflowTypeF = get('it')
  const consultF = get('cs')
  const dupF = get('dup') === '1' // 중복 디비만(현장 피드백)
  const regFromF = get('rf') // 가입일 from (YYYY-MM-DD)
  const regToF = get('rt') // 가입일 to

  const extra: MemberFilter = {
    grade: gradeF,
    status: statusF,
    assignedStaffId: staffF,
    inflowCode: inflowF,
    inflowType: inflowTypeF,
    consultStatus: consultF,
    dupPhone: dupF || undefined,
    registeredFrom: regFromF,
    registeredTo: regToF,
  }

  const query: MembersQuery = {
    view: viewKey,
    search,
    extra,
    page,
    pageSize,
    sortId,
    sortDesc,
  }

  const { data, isLoading, isFetching } = useMembers(query)
  const { data: counts } = useMemberViewCounts()
  const { data: inflowCodes = [] } = useInflowCodes()

  const updateMember = useUpdateMember()
  const assignStaff = useAssignStaff()
  const resetAssign = useResetAssign()

  // ── 컬럼 ─────────────────────────────────────────
  const staffOptions = useMemo(
    () => [{ value: '', label: '미지정' }, ...staff.map((s) => ({ value: s.id, label: s.name }))],
    [staff],
  )
  const pageOffset = (page - 1) * pageSize
  const columns = useMemo(
    () =>
      memberColumns({
        pageOffset,
        staffOptions,
        canEditStaff: role === 'admin', // 담당자 변경은 최고관리자만(현장 피드백)
        onChangeStatus: (id, status) => updateMember.mutate({ id, patch: { status } }),
        onChangeStaff: (id, staffId) =>
          staffId
            ? assignStaff.mutate({ ids: [id], staffId })
            : resetAssign.mutate({ ids: [id] }),
        onChangeConsult: (id, consult) =>
          updateMember.mutate({ id, patch: { consult_status: consult || null } }),
      }),
    // mutate 함수는 안정적 — pageOffset/옵션/역할 변경 시에만 재생성
    [pageOffset, staffOptions, role], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ── 정렬 (서버 manual) ────────────────────────────
  const sorting: SortingState = sortId ? [{ id: sortId, desc: sortDesc }] : []
  const onSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater
    const s = next[0]
    setMany({ sort: s ? `${s.id}:${s.desc ? 'desc' : 'asc'}` : null }, { resetPage: true })
  }

  // ── 탭 ───────────────────────────────────────────
  const tabs: TabItem[] = TAB_VIEWS.map((v) => ({
    key: v.key,
    label: v.label,
    count: counts?.[v.key],
  }))
  const activeMore = MORE_VIEWS.find((v) => v.key === viewKey)

  const onSelectView = (key: string) => {
    setMany({ view: key === 'all' ? null : key, page: null })
    setMoreOpen(false)
  }

  // ── 활성 필터 칩 ──────────────────────────────────
  const chips: FilterChip[] = []
  if (gradeF) chips.push({ key: 'g', label: `등급: ${GRADE_LABEL[gradeF]}`, onRemove: () => remove('g') })
  if (statusF)
    chips.push({ key: 'st', label: `상태: ${STATUS_META[statusF].label}`, onRemove: () => remove('st') })
  if (staffF) {
    const name = staff.find((s) => s.id === staffF)?.name ?? staffF
    chips.push({ key: 'staff', label: `담당: ${name}`, onRemove: () => remove('staff') })
  }
  if (inflowF) chips.push({ key: 'inflow', label: `유입코드: ${inflowF}`, onRemove: () => remove('inflow') })
  if (inflowTypeF)
    chips.push({ key: 'it', label: `유입구분: ${inflowTypeF}`, onRemove: () => remove('it') })
  if (consultF)
    chips.push({ key: 'cs', label: `상담상태: ${consultF}`, onRemove: () => remove('cs') })
  if (dupF) chips.push({ key: 'dup', label: '중복 디비만', onRemove: () => remove('dup') })
  if (regFromF || regToF)
    chips.push({
      key: 'reg',
      label: `가입일: ${regFromF ?? '…'} ~ ${regToF ?? '…'}`,
      onRemove: () => setMany({ rf: null, rt: null }, { resetPage: true }),
    })

  const clearAll = () => clear(['view'])

  return (
    <div>
      <PageHeader
        title="이용자"
        description="회원 세그먼트 관리 · 담당 배정 · 문자 발송"
        actions={
          // 디비 입력(신규 등록·일괄 임포트)은 최고관리자만(현장 피드백)
          role === 'admin' ? (
            <>
              <Button variant="sec" size="sm" onClick={() => setImporting(true)}>
                <Upload className="h-4 w-4" /> 일괄 임포트
              </Button>
              <Button variant="pri" size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> 신규 등록
              </Button>
            </>
          ) : undefined
        }
      />

      {/* 탭 + 더보기 */}
      <div className="mb-3 flex items-end gap-2">
        <Tabs tabs={tabs} value={viewKey} onChange={onSelectView} className="flex-1" />
        <div className="relative pb-1">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            className={
              'inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[12.5px] font-semibold transition-colors ' +
              (activeMore
                ? 'border-primary-500 bg-primary-50 text-primary-700'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50')
            }
          >
            {activeMore ? activeMore.label : '더보기'}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {moreOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
              <div className="absolute right-0 top-9 z-20 max-h-[420px] w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 shadow-md">
                {GROUP_ORDER.map((g) => {
                  const items = MORE_VIEWS.filter((v) => v.group === g)
                  if (items.length === 0) return null
                  return (
                    <div key={g} className="mb-1.5 last:mb-0">
                      <div className="px-1.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.4px] text-gray-400">
                        {g}
                      </div>
                      {items.map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          title={v.hint}
                          onClick={() => onSelectView(v.key)}
                          className={
                            'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-gray-50 ' +
                            (v.key === viewKey ? 'font-bold text-primary-700' : 'text-gray-700')
                          }
                        >
                          <span>{v.label}</span>
                          <span className="font-mono text-[11px] tnum text-gray-400">
                            {counts?.[v.key] ?? '·'}
                          </span>
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 필터 바 */}
      <FilterBar
        className="mb-3"
        searchValue={search}
        onSearchChange={(v) => set('q', v, { resetPage: true })}
        chips={chips}
        onClearAll={chips.length > 0 ? clearAll : undefined}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="등급">
            <select
              className={selectCls}
              value={gradeF ?? ''}
              onChange={(e) => set('g', e.target.value || null, { resetPage: true })}
            >
              <option value="">전체</option>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {GRADE_LABEL[g]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="상태">
            <select
              className={selectCls}
              value={statusF ?? ''}
              onChange={(e) => set('st', e.target.value || null, { resetPage: true })}
            >
              <option value="">전체</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
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
          {/* 유입코드/유입구분은 최고관리자만(현장 피드백) */}
          {role === 'admin' && (
            <>
              <Field label="유입코드">
                <select
                  className={selectCls}
                  value={inflowF ?? ''}
                  onChange={(e) => set('inflow', e.target.value || null, { resetPage: true })}
                >
                  <option value="">전체</option>
                  {/* 실제 데이터에 존재하는 유입코드만 노출(현장 피드백) */}
                  {inflowCodes.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  {/* 현재 선택값이 목록에 없으면(스코프 밖 등) 칩 정합 위해 노출 */}
                  {inflowF && !inflowCodes.includes(inflowF) && <option value={inflowF}>{inflowF}</option>}
                </select>
              </Field>
              <Field label="유입구분">
                <select
                  className={selectCls}
                  value={inflowTypeF ?? ''}
                  onChange={(e) => set('it', e.target.value || null, { resetPage: true })}
                >
                  <option value="">전체</option>
                  {INFLOW_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <Field label="상담상태">
            <select
              className={selectCls}
              value={consultF ?? ''}
              onChange={(e) => set('cs', e.target.value || null, { resetPage: true })}
            >
              <option value="">전체</option>
              {CONSULT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          {/* 가입일 범위 + 중복 디비(현장 피드백) */}
          <Field label="가입일(부터)">
            <input
              type="date"
              className={selectCls}
              value={regFromF ?? ''}
              onChange={(e) => set('rf', e.target.value || null, { resetPage: true })}
            />
          </Field>
          <Field label="가입일(까지)">
            <input
              type="date"
              className={selectCls}
              value={regToF ?? ''}
              onChange={(e) => set('rt', e.target.value || null, { resetPage: true })}
            />
          </Field>
          <Field label="중복 디비">
            <label className="flex h-9 cursor-pointer items-center gap-2 text-[12.5px] text-gray-700">
              <input
                type="checkbox"
                checked={dupF}
                onChange={(e) => set('dup', e.target.checked ? '1' : null, { resetPage: true })}
              />
              중복 입력된 디비만
            </label>
          </Field>
        </div>
      </FilterBar>

      {/* 테이블 */}
      <DataTable
        key={role ?? 'none'}
        columns={columns}
        data={data?.rows ?? []}
        getRowId={(m) => m.id}
        isLoading={isLoading}
        onRowClick={(m) => setSelectedId(m.id)}
        enableSelection
        bulkActions={(ctx) => <MemberBulkActions {...ctx} />}
        sorting={sorting}
        onSortingChange={onSortingChange}
        initialColumnVisibility={memberColumnVisibility(role)}
        resultLabel={(total) => (
          <>
            {getView(viewKey).label} <b className="font-mono text-ink-800 tnum">{total.toLocaleString('ko-KR')}</b>건
            {isFetching && <span className="ml-2 text-gray-400">갱신중…</span>}
          </>
        )}
        pagination={{
          page,
          pageSize,
          total: data?.total ?? 0,
          onPageChange: (p) => set('page', p === 1 ? null : p),
          pageSizeOptions: [...PAGE_SIZE_OPTIONS],
          onPageSizeChange: (size) =>
            setMany({ size: size === DEFAULT_PAGE_SIZE ? null : String(size), page: null }),
        }}
      />

      <MemberDrawer memberId={selectedId} onClose={() => setSelectedId(null)} />
      {creating && <MemberCreateDrawer onClose={() => setCreating(false)} />}
      {importing && <ImportMembersModal onClose={() => setImporting(false)} />}
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
