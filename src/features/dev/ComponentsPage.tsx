import { useMemo, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Download, MessageSquare, Plus, Trash2, UserCheck, Users } from 'lucide-react'
import { usePageMeta } from '@/app/uiStore'
import {
  Badge,
  BulkButton,
  Button,
  ConfirmModal,
  DataTable,
  DateRangeFilter,
  Drawer,
  EmptyState,
  FilterBar,
  KpiCard,
  Modal,
  NumCell,
  PageHeader,
  Pagination,
  Skeleton,
  StatusChip,
  Tabs,
  InlineSelect,
  type DateRange,
  type FilterChip,
} from '@/design-system/components'
import type { Grade, MemberStatus } from '@/types/db'
import { dateShort, phone } from '@/lib/format'

interface DemoRow {
  id: string
  no: number
  status: MemberStatus
  grade: Grade
  staffId: string
  userId: string
  name: string
  phone: string
  inflow: string
  joinedAt: string
}

const GRADES: Grade[] = ['simple', 'free', 'gold', 'goldp', 'vip', 'royal', 'ovr', 'toss']
const STATUSES: MemberStatus[] = ['active', 'suspended', 'deleted', 'withdrawn']
const STAFF = [
  { value: 'two001', label: 'two001' },
  { value: 'two011', label: 'two011' },
  { value: 'one005', label: 'one005' },
  { value: '', label: '미지정' },
]
const NAMES = ['강지훈', '박애현', '장가천', '김유성', '최수영', '정의현', '하태식', '이수련', '윤도현', '서민재', '한겨울', '오세훈']

function seed(): DemoRow[] {
  return Array.from({ length: 12 }).map((_, i) => ({
    id: `m-${i + 1}`,
    no: 150674 - i * 11,
    status: STATUSES[i % STATUSES.length],
    grade: GRADES[i % GRADES.length],
    staffId: STAFF[i % 3].value,
    userId: ['two011', 'two029', 'one005'][i % 3],
    name: NAMES[i % NAMES.length],
    phone: `010${String(50000000 + i * 137711).slice(0, 8)}`,
    inflow: ['chance', 'test', '신규', 'toss'][i % 4],
    joinedAt: `2026-0${(i % 6) + 1}-1${i % 9}`,
  }))
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="mb-3 text-[15px] font-bold text-ink-900">{title}</h2>
      {children}
    </section>
  )
}

export function ComponentsPage() {
  usePageMeta('컴포넌트 데모', 'Phase 1 — 코어 컴포넌트 검수 (/dev/components)')

  const [rows, setRows] = useState<DemoRow[]>(seed)
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<MemberStatus | ''>('')
  const [range, setRange] = useState<DateRange>({ from: null, to: null })
  const [page, setPage] = useState(1)
  const [isLoading, setLoading] = useState(false)
  const [showEmpty, setShowEmpty] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const pageSize = 6

  const filtered = useMemo(() => {
    let r = rows
    if (search) r = r.filter((x) => `${x.name}${x.userId}${x.phone}`.includes(search))
    if (statusFilter) r = r.filter((x) => x.status === statusFilter)
    return r
  }, [rows, search, statusFilter])

  const paged = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page],
  )

  const chips: FilterChip[] = []
  if (search) chips.push({ key: 'q', label: `검색: ${search}`, onRemove: () => setSearch('') })
  if (statusFilter)
    chips.push({ key: 'st', label: `상태: ${statusFilter}`, onRemove: () => setStatusFilter('') })

  const columns: ColumnDef<DemoRow, unknown>[] = [
    {
      accessorKey: 'no',
      header: 'No',
      meta: { align: 'right' },
      cell: ({ getValue }) => <NumCell>{(getValue() as number).toLocaleString('ko-KR')}</NumCell>,
    },
    {
      accessorKey: 'status',
      header: '상태',
      cell: ({ getValue }) => <StatusChip status={getValue() as MemberStatus} />,
    },
    {
      accessorKey: 'grade',
      header: '등급',
      cell: ({ getValue }) => <Badge grade={getValue() as Grade} />,
    },
    {
      accessorKey: 'staffId',
      header: '담당',
      enableSorting: false,
      cell: ({ row, getValue }) => (
        <InlineSelect
          value={getValue() as string}
          options={STAFF}
          onChange={(v) =>
            setRows((prev) => prev.map((x) => (x.id === row.original.id ? { ...x, staffId: v } : x)))
          }
        />
      ),
    },
    { accessorKey: 'userId', header: 'ID' },
    { accessorKey: 'name', header: '이름' },
    {
      accessorKey: 'phone',
      header: '핸드폰',
      meta: { align: 'right' },
      cell: ({ getValue }) => <NumCell>{phone(getValue() as string)}</NumCell>,
    },
    {
      accessorKey: 'inflow',
      header: '유입',
      cell: ({ getValue }) => <span className="text-gray-400">{getValue() as string}</span>,
    },
    {
      accessorKey: 'joinedAt',
      header: '가입일',
      meta: { align: 'right' },
      cell: ({ getValue }) => <NumCell muted>{dateShort(getValue() as string)}</NumCell>,
    },
  ]

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
      <PageHeader
        title="컴포넌트 데모"
        description="모든 코어 컴포넌트의 주요 상태 검수 페이지"
        actions={
          <Button variant="pri" icon={<Plus className="h-4 w-4" />}>
            기본 액션
          </Button>
        }
      />

      <Section title="Button">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="pri">Primary</Button>
          <Button variant="acc" icon={<MessageSquare className="h-4 w-4" />}>
            Accent
          </Button>
          <Button variant="suc">Success</Button>
          <Button variant="dng">Danger</Button>
          <Button variant="sec">Secondary</Button>
          <Button variant="gho">Ghost</Button>
          <Button variant="pri" disabled>
            Disabled
          </Button>
          <span className="mx-2 h-5 w-px bg-gray-200" />
          <Button variant="pri" size="sm">
            Small
          </Button>
          <Button variant="sec" size="sm">
            Small
          </Button>
        </div>
      </Section>

      <Section title="Badge (등급) · StatusChip (상태)">
        <div className="mb-3 flex flex-wrap gap-2">
          {GRADES.map((g) => (
            <Badge key={g} grade={g} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusChip status="active" />
          <StatusChip status="wait" />
          <StatusChip status="approved" />
          <StatusChip status="failed" />
          <StatusChip status="cancelled" />
          <StatusChip status="suspended" />
          <StatusChip tone="info" label="답변완료" />
        </div>
      </Section>

      <Section title="KpiCard">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard
            label="오늘 신규 유입"
            value="342"
            icon={<Users className="h-4 w-4" />}
            delta="▲ 12% 어제比"
            deltaDir="up"
          />
          <KpiCard
            label="미아웃콜"
            value="87"
            icon={<UserCheck className="h-4 w-4" />}
            iconClassName="bg-accent-50 text-accent-600"
            delta="처리 필요"
            deltaDir="down"
            onClick={() => alert('미아웃콜 화면으로 이동 (딥링크 데모)')}
          />
          <KpiCard label="결제 대기" value="5" delta="승인 대기 중" />
          <KpiCard label="오늘 매출" value="2.8M" accent delta="▲ 8%" deltaDir="up" />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          tabs={[
            { key: 'all', label: '전체', count: 150674 },
            { key: 'normal', label: '정상', count: 142390 },
            { key: 'paid', label: '유료', count: 8210 },
            { key: 'free', label: '무료', count: 142464 },
          ]}
          value={tab}
          onChange={setTab}
        />
        <p className="mt-2 text-[12.5px] text-gray-500">선택된 탭: {tab}</p>
      </Section>

      <Section title="FilterBar (URL 동기화는 모듈에서 / 여기선 로컬 상태)">
        <FilterBar
          searchValue={search}
          onSearchChange={(v) => {
            setSearch(v)
            setPage(1)
          }}
          chips={chips}
          onClearAll={() => {
            setSearch('')
            setStatusFilter('')
          }}
        >
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="font-semibold text-gray-600">상태</span>
            {(['', ...STATUSES] as const).map((s) => (
              <button
                key={s || 'any'}
                type="button"
                onClick={() => {
                  setStatusFilter(s)
                  setPage(1)
                }}
                className={
                  statusFilter === s
                    ? 'rounded-md bg-primary-600 px-2.5 py-1.5 font-semibold text-white'
                    : 'rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-gray-600 hover:bg-gray-50'
                }
              >
                {s || '전체'}
              </button>
            ))}
          </div>
        </FilterBar>
      </Section>

      <Section title="DateRangeFilter">
        <DateRangeFilter value={range} onChange={setRange} />
        <p className="mt-2 text-[12.5px] text-gray-500">
          {range.from ?? '—'} ~ {range.to ?? '—'}
        </p>
      </Section>

      <Section title="DataTable (정렬·선택·밀도·컬럼토글·인라인편집·일괄작업·페이지네이션)">
        <div className="mb-3 flex flex-wrap gap-2">
          <Button variant="sec" size="sm" onClick={() => setLoading((v) => !v)}>
            로딩 {isLoading ? 'OFF' : 'ON'}
          </Button>
          <Button variant="sec" size="sm" onClick={() => setShowEmpty((v) => !v)}>
            빈 상태 {showEmpty ? 'OFF' : 'ON'}
          </Button>
        </div>
        <DataTable
          columns={columns}
          data={showEmpty ? [] : paged}
          getRowId={(r) => r.id}
          isLoading={isLoading}
          enableSelection
          onRowClick={() => setDrawerOpen(true)}
          resultLabel={(t) => (
            <>
              결과 <b className="font-mono text-ink-800 tnum">{filtered.length.toLocaleString('ko-KR')}</b>명
              {t !== filtered.length ? '' : ''}
            </>
          )}
          pagination={{
            page,
            pageSize,
            total: filtered.length,
            onPageChange: setPage,
          }}
          toolbar={
            <Button variant="sec" size="sm" icon={<Download className="h-4 w-4" />}>
              엑셀
            </Button>
          }
          bulkActions={({ selectedIds, clear }) => (
            <>
              <BulkButton>상태 변경 ▾</BulkButton>
              <BulkButton>담당자 배정 ▾</BulkButton>
              <BulkButton onClick={() => alert(`문자 발송: ${selectedIds.length}명`)}>
                문자 발송
              </BulkButton>
              <BulkButton
                className="border-danger/40 bg-danger/20 hover:bg-danger/30"
                onClick={() => setConfirmOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                삭제
              </BulkButton>
              <ConfirmModal
                open={confirmOpen}
                onClose={() => setConfirmOpen(false)}
                onConfirm={() => {
                  setConfirmOpen(false)
                  clear()
                  alert(`${selectedIds.length}명 삭제 (데모)`)
                }}
                tone="danger"
                title="선택 회원 삭제"
                description={`${selectedIds.length}명을 삭제 목록으로 이동합니다. 계속할까요?`}
                confirmText="삭제"
              />
            </>
          )}
        />
      </Section>

      <Section title="Pagination (단독)">
        <Pagination page={page} pageSize={pageSize} total={filtered.length} onPageChange={setPage} />
      </Section>

      <Section title="EmptyState · Skeleton">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-gray-200">
            <EmptyState
              title="조건에 맞는 회원이 없습니다"
              description="필터를 변경하거나 초기화해 보세요."
              action={<Button variant="sec" size="sm">필터 초기화</Button>}
            />
          </div>
          <div className="flex flex-col gap-2 rounded-lg border border-gray-200 p-4">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </Section>

      <Section title="Modal · Drawer">
        <div className="flex flex-wrap gap-2">
          <Button variant="pri" onClick={() => setModalOpen(true)}>
            Modal 열기
          </Button>
          <Button variant="dng" onClick={() => setConfirmOpen(true)}>
            ConfirmModal 열기
          </Button>
          <Button variant="sec" onClick={() => setDrawerOpen(true)}>
            Drawer 열기
          </Button>
        </div>
        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="기본 모달"
          footer={
            <>
              <Button variant="sec" size="sm" onClick={() => setModalOpen(false)}>
                닫기
              </Button>
              <Button variant="pri" size="sm" onClick={() => setModalOpen(false)}>
                저장
              </Button>
            </>
          }
        >
          모달 본문입니다. Escape 또는 오버레이 클릭으로 닫힙니다.
        </Modal>
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title={<span>회원 상세 (Drawer 데모)</span>}
          footer={
            <Button variant="pri" size="sm" onClick={() => setDrawerOpen(false)}>
              완료
            </Button>
          }
        >
          <div className="space-y-3 text-[13px] text-gray-600">
            <p>우측 슬라이드 패널입니다. Phase 3 의 회원 상세 허브가 이 컴포넌트를 사용합니다.</p>
            <div className="flex gap-2">
              <Badge grade="royal" />
              <StatusChip status="active" />
            </div>
          </div>
        </Drawer>
      </Section>
    </div>
  )
}
