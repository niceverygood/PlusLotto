// 베팅 (BUILD_PROMPTS Phase 6 — 스샷 있음). 회차 필터(로또기록에서 행 클릭 시 ?round= 로 진입) +
// 검색 + 당첨금 집계 KPI + 베팅 표(번호조합 볼·등수·당첨금). 회차 선택 시 해당 회차로 필터링(검수).
import { useMemo, type ReactNode } from 'react'
import { Coins, Ticket, Trophy } from 'lucide-react'
import {
  DataTable,
  FilterBar,
  KpiCard,
  PageHeader,
  type FilterChip,
} from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useUrlFilters } from '@/lib/useUrlFilters'
import { krw, num } from '@/lib/format'
import { useBetRoundOptions, useBets, type BetsQuery } from './api'
import { betColumns } from './columns'

const PAGE_SIZE = 50

const selectCls =
  'h-9 rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500'

export function BetsPage() {
  usePageMeta('베팅', '회차별 베팅 · 당첨 등수 · 당첨금')
  const { get, set, setMany, remove } = useUrlFilters()

  const roundRaw = get('round')
  const round = roundRaw && /^\d+$/.test(roundRaw) ? Number(roundRaw) : null
  const search = get('q') ?? ''
  const page = Math.max(1, Number(get('page') ?? '1') || 1)

  const { data: roundOptions = [] } = useBetRoundOptions()
  const query: BetsQuery = { round, search, page, pageSize: PAGE_SIZE }
  const { data, isLoading, isFetching } = useBets(query)

  const columns = useMemo(() => betColumns(), [])
  const s = data?.summary

  const chips: FilterChip[] = []
  if (round != null) chips.push({ key: 'round', label: `회차: ${round}회`, onRemove: () => remove('round') })

  return (
    <div>
      <PageHeader
        title="베팅"
        description="회차별 베팅 내역 · 당첨번호 일치 시각화 · 등수/당첨금 (당첨 확정 시 갱신)"
      />

      {/* 당첨금 집계 */}
      <div className="mb-4 grid grid-cols-3 gap-3">
        <KpiCard
          label={round != null ? `${round}회 베팅수` : '전체 베팅수'}
          value={`${num(s?.count ?? 0)}건`}
          icon={<Ticket className="h-[18px] w-[18px]" />}
        />
        <KpiCard
          label="당첨 건수"
          value={`${num(s?.winners ?? 0)}건`}
          icon={<Trophy className="h-[18px] w-[18px]" />}
          iconClassName="bg-warning-bg text-warning"
        />
        <KpiCard
          accent
          label="당첨금 합계"
          value={krw(s?.prizeSum ?? 0)}
          icon={<Coins className="h-[18px] w-[18px]" />}
        />
      </div>

      <FilterBar
        className="mb-3"
        searchValue={search}
        onSearchChange={(v) => set('q', v, { resetPage: true })}
        chips={chips}
        onClearAll={chips.length > 0 ? () => setMany({ round: null, q: null, page: null }) : undefined}
      >
        <Field label="회차">
          <select
            className={selectCls}
            value={round != null ? String(round) : ''}
            onChange={(e) => setMany({ round: e.target.value || null, page: null })}
          >
            <option value="">전체 회차</option>
            {roundOptions.map((r) => (
              <option key={r.round_no} value={r.round_no}>
                {r.round_no}회 {r.confirmed ? '(확정)' : '(미확정)'}
              </option>
            ))}
          </select>
        </Field>
      </FilterBar>

      <DataTable
        columns={columns}
        data={data?.rows ?? []}
        getRowId={(b) => b.id}
        isLoading={isLoading}
        resultLabel={(total) => (
          <>
            베팅 <b className="font-mono text-ink-800 tnum">{num(total)}</b>건
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-semibold text-gray-500">{label}</span>
      {children}
    </label>
  )
}
