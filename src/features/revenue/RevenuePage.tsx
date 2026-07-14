// 매출 (CLAUDE §7·§8·§9, BUILD_PROMPTS Phase 5 — 미확인 화면 직접 구현).
// 실매출/전환매출/팀장매출 3뷰를 한 페이지의 탭으로 제공(사이드바 IA 단일 '매출' 진입과 정합).
// 공통: DateRangeFilter + 요약 KPI(총매출·건수·평균·전환율) + recharts 일별 추이 + 그룹 분해 표.
// 매출 수치는 전부 payments(status='approved') 파생 — 결제 데이터와 즉시 일치(§8).
import { subDays, format } from 'date-fns'
import { TrendingUp, Receipt, Coins, Repeat } from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  DateRangeFilter,
  EmptyState,
  KpiCard,
  PageHeader,
  Skeleton,
  Tabs,
  type TabItem,
} from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useUrlFilters } from '@/lib/useUrlFilters'
import { krw, num } from '@/lib/format'
import {
  GROUP_LABEL,
  useRevenue,
  type GroupDim,
  type RevenueView,
  type TrendPoint,
} from './api'

const VIEW_TABS: { key: RevenueView; label: string }[] = [
  { key: 'real', label: '실매출' },
  { key: 'conversion', label: '전환매출' },
  { key: 'team', label: '팀장매출' },
]
const REAL_GROUPS: GroupDim[] = ['staff', 'team', 'product', 'pg']

const selectCls =
  'h-9 rounded-md border border-gray-300 bg-white px-2.5 text-[12.5px] text-gray-700 outline-none focus:border-primary-500'

const today = () => format(new Date(), 'yyyy-MM-dd')

export function RevenuePage() {
  usePageMeta('매출', '승인 결제 기준 매출 집계 · 담당/팀/상품/PG 귀속')
  const { get, set, setMany } = useUrlFilters()

  const view = (get('view') ?? 'real') as RevenueView
  const from = get('from') ?? format(subDays(new Date(), 29), 'yyyy-MM-dd')
  const to = get('to') ?? today()
  const groupBy = (get('group') ?? 'staff') as GroupDim

  const { data, isLoading } = useRevenue({ view, from, to, groupBy })

  const conv = view === 'conversion'
  const labels = conv
    ? { total: '전환매출', count: '전환건수', avg: '평균전환액' }
    : { total: '총매출', count: '결제건수', avg: '평균결제액' }

  const tabs: TabItem[] = VIEW_TABS.map((t) => ({ key: t.key, label: t.label }))
  const s = data?.summary

  return (
    <div>
      <PageHeader
        title="매출"
        description="실매출 · 전환매출 · 팀장매출 — 승인 결제 파생 집계 (§8). 기간/귀속 규칙 일관 반영."
      />

      <Tabs
        tabs={tabs}
        value={view}
        onChange={(k) => setMany({ view: k === 'real' ? null : k })}
        className="mb-3"
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <DateRangeFilter
          value={{ from, to }}
          onChange={(r) => setMany({ from: r.from, to: r.to })}
        />
        {view === 'real' && (
          <label className="flex items-center gap-2 text-[12px] font-semibold text-gray-500">
            그룹
            <select
              className={selectCls}
              value={groupBy}
              onChange={(e) => set('group', e.target.value === 'staff' ? null : e.target.value)}
            >
              {REAL_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABEL[g]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* 요약 KPI */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          accent
          label={labels.total}
          value={krw(s?.total ?? 0)}
          icon={<TrendingUp className="h-[18px] w-[18px]" />}
          delta={s ? `${num(s.count)}건` : undefined}
        />
        <KpiCard
          label={labels.count}
          value={`${num(s?.count ?? 0)}건`}
          icon={<Receipt className="h-[18px] w-[18px]" />}
          iconClassName="bg-info-bg text-info"
        />
        <KpiCard
          label={labels.avg}
          value={krw(s?.avg ?? 0)}
          icon={<Coins className="h-[18px] w-[18px]" />}
          iconClassName="bg-warning-bg text-warning"
        />
        <KpiCard
          label="신규전환율"
          value={s ? `${(s.conversionRate * 100).toFixed(1)}%` : '-'}
          icon={<Repeat className="h-[18px] w-[18px]" />}
          iconClassName="bg-success-bg text-success"
          delta={s ? `신규전환 ${num(s.conversions)}건 · ${krw(s.conversionRevenue)}` : undefined}
        />
      </div>

      {/* 일별 추이 */}
      <section className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-[15px] font-bold text-ink-900">일별 매출 추이</h2>
        {isLoading && !data ? (
          <Skeleton className="h-[260px] w-full" />
        ) : (
          <TrendChart points={data?.trend ?? []} />
        )}
      </section>

      {/* 그룹 분해 표 */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-[15px] font-bold text-ink-900">
          {data ? GROUP_LABEL[data.groupDim] : ''}별 매출
        </h2>
        {isLoading && !data ? (
          <Skeleton className="h-40 w-full" />
        ) : data && data.breakdown.length > 0 ? (
          <BreakdownTable
            groupLabel={GROUP_LABEL[data.groupDim]}
            rows={data.breakdown}
            total={data.summary.total}
            totalCount={data.summary.count}
          />
        ) : (
          <EmptyState title="해당 기간 매출 없음" description="기간을 넓히거나 다른 뷰를 선택하세요." />
        )}
      </section>
    </div>
  )
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  const hasData = points.some((p) => p.amount > 0)
  if (!hasData) {
    return (
      <div className="grid h-[260px] place-items-center text-[13px] text-gray-400">
        해당 기간 매출 없음
      </div>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={points} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary-500)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--primary-500)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-200)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: 'var(--gray-500)' }}
          tickLine={false}
          axisLine={{ stroke: 'var(--gray-200)' }}
          minTickGap={24}
        />
        <YAxis
          width={48}
          tick={{ fontSize: 11, fill: 'var(--gray-500)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => (v >= 10000 ? `${Math.round(v / 10000)}만` : String(v))}
        />
        <Tooltip
          formatter={(value: number) => [krw(value), '매출']}
          labelFormatter={(l) => `${l}`}
          contentStyle={{
            borderRadius: 8,
            border: '1px solid var(--gray-200)',
            fontSize: 12,
            boxShadow: 'var(--shadow-md)',
          }}
        />
        <Area
          type="monotone"
          dataKey="amount"
          stroke="var(--primary-500)"
          strokeWidth={2}
          fill="url(#rev-fill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function BreakdownTable({
  groupLabel,
  rows,
  total,
  totalCount,
}: {
  groupLabel: string
  rows: { key: string; label: string; amount: number; count: number; share: number }[]
  total: number
  totalCount: number
}) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-gray-200 text-[11.5px] font-semibold text-gray-500">
          <th className="py-2 text-left">{groupLabel}</th>
          <th className="py-2 text-right">건수</th>
          <th className="py-2 text-right">매출</th>
          <th className="w-[34%] py-2 pl-4 text-left">비중</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-gray-100 last:border-0">
            <td className="py-2 font-medium text-ink-800">{r.label}</td>
            <td className="py-2 text-right font-mono text-gray-600 tnum">{num(r.count)}</td>
            <td className="py-2 text-right font-mono font-semibold text-ink-900 tnum">
              {krw(r.amount)}
            </td>
            <td className="py-2 pl-4">
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-primary-500"
                    style={{ width: `${Math.round(r.share * 100)}%` }}
                  />
                </div>
                <span className="w-10 text-right font-mono text-[11.5px] text-gray-500 tnum">
                  {(r.share * 100).toFixed(0)}%
                </span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-gray-200 font-bold text-ink-900">
          <td className="py-2">합계</td>
          <td className="py-2 text-right font-mono tnum">{num(totalCount)}</td>
          <td className="py-2 text-right font-mono tnum">{krw(total)}</td>
          <td className="py-2 pl-4" />
        </tr>
      </tfoot>
    </table>
  )
}
