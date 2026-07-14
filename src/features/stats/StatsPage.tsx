// 통계 (CLAUDE §9, BUILD_PROMPTS Phase 9 — 가입·결제 미확인 → 직접 구현, 유입 재현).
// 가입/결제/유입 3뷰를 한 페이지의 ?view= 탭으로 제공(매출 모듈 패턴 재사용). 공통 골격:
// DateRangeFilter + 요약 KPI 4 + recharts 일별 추이 + 분해 표. 전부 실데이터 파생(§8).
import { useState } from 'react'
import { subDays, format } from 'date-fns'
import { LineChart as LineChartIcon } from 'lucide-react'
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
import { CONSULT_STATUSES } from '@/lib/consultStatus'
import type { ReportDimension, ReportPeriod } from '@/lib/consultReport'
import { useConsultReport, useStats, type StatBreakdown, type StatPoint, type StatsView } from './api'

const VIEW_TABS: { key: StatsView; label: string }[] = [
  { key: 'signup', label: '가입' },
  { key: 'payment', label: '결제·매출' },
  { key: 'inflow', label: '유입' },
  { key: 'consult', label: '상담 리포트' },
]

const today = () => format(new Date(), 'yyyy-MM-dd')
const fmtWon = (v: number) => (v >= 10000 ? `${Math.round(v / 10000)}만` : String(v))

export function StatsPage() {
  usePageMeta('통계', '가입 · 결제 · 유입 · 상담 운영 통계')
  const { get, setMany } = useUrlFilters()

  const view = (get('view') ?? 'signup') as StatsView
  const from = get('from') ?? format(subDays(new Date(), 29), 'yyyy-MM-dd')
  const to = get('to') ?? today()

  const { data, isLoading } = useStats({ view, from, to })

  const tabs: TabItem[] = VIEW_TABS.map((t) => ({ key: t.key, label: t.label }))

  return (
    <div>
      <PageHeader
        title="통계"
        description="가입 · 결제·매출 · 유입 · 상담 — 운영 데이터 실시간 집계(§8). 기간 필터로 추이·구성을 분석."
      />

      <Tabs
        tabs={tabs}
        value={view}
        onChange={(k) => setMany({ view: k === 'signup' ? null : k })}
        className="mb-3"
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <DateRangeFilter value={{ from, to }} onChange={(r) => setMany({ from: r.from, to: r.to })} />
      </div>

      {view === 'consult' ? (
        <ConsultReportView from={from} to={to} />
      ) : (
        <>
          {/* 요약 KPI */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(data?.kpis ?? Array.from({ length: 4 }, (_, i) => ({ label: '', value: '', key: i }))).map(
              (k, i) => (
                <KpiCard
                  key={i}
                  accent={i === 0}
                  label={k.label || '—'}
                  value={isLoading && !data ? '…' : k.value || '-'}
                  delta={'sub' in k ? k.sub : undefined}
                />
              ),
            )}
          </div>

          {/* 일별 추이 */}
          <section className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-[15px] font-bold text-ink-900">{data?.trendTitle ?? '추이'}</h2>
            {isLoading && !data ? (
              <Skeleton className="h-[260px] w-full" />
            ) : (
              <TrendChart points={data?.trend ?? []} unit={data?.trendUnit ?? 'count'} />
            )}
          </section>

          {/* 분해 표 */}
          <div className="grid gap-4 lg:grid-cols-2">
            {(data?.breakdowns ?? []).map((b) => (
              <section key={b.title} className="rounded-xl border border-gray-200 bg-white p-4">
                <h2 className="mb-3 text-[15px] font-bold text-ink-900">{b.title}</h2>
                {isLoading && !data ? (
                  <Skeleton className="h-40 w-full" />
                ) : b.rows.length > 0 ? (
                  <BreakdownTable b={b} />
                ) : (
                  <EmptyState title="데이터 없음" description="해당 기간에 집계할 데이터가 없습니다." />
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── 상담 리포트(유입코드별·상담원별 상담상태, 주차/월별) — 현장 피드백 7/10 ──────
const DIM_TABS: { key: ReportDimension; label: string }[] = [
  { key: 'code', label: '유입코드별' },
  { key: 'staff', label: '상담원별' },
]
const PERIOD_TABS: { key: ReportPeriod; label: string }[] = [
  { key: 'week', label: '주차별' },
  { key: 'month', label: '월별' },
]

function ConsultReportView({ from, to }: { from: string; to: string }) {
  const [dimension, setDimension] = useState<ReportDimension>('code')
  const [period, setPeriod] = useState<ReportPeriod>('week')
  const { data, isLoading } = useConsultReport({ dimension, period, from, to })
  const rows = data ?? []

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Tabs
          tabs={DIM_TABS.map((t) => ({ key: t.key, label: t.label }))}
          value={dimension}
          onChange={(k) => setDimension(k as ReportDimension)}
        />
        <Tabs
          tabs={PERIOD_TABS.map((t) => ({ key: t.key, label: t.label }))}
          value={period}
          onChange={(k) => setPeriod(k as ReportPeriod)}
        />
      </div>

      {isLoading && !data ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="집계할 상담 결과가 없습니다"
          description="선택한 기간에 상담상태 변경 이력이 없습니다."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-2.5 text-[12px] font-bold text-gray-600">
                  {period === 'week' ? '주차' : '월'}
                </th>
                <th className="px-3 py-2.5 text-[12px] font-bold text-gray-600">
                  {dimension === 'code' ? '유입코드' : '상담원'}
                </th>
                {CONSULT_STATUSES.map((s) => (
                  <th key={s} className="px-2.5 py-2.5 text-right text-[12px] font-bold text-gray-600">
                    {s}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-right text-[12px] font-bold text-gray-600">합계</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.periodKey}-${r.dimKey}`}
                  className={i % 2 === 1 ? 'bg-gray-50/40' : ''}
                >
                  <td className="px-4 py-2 text-[12.5px] font-mono text-gray-500 tabular-nums">
                    {r.periodLabel}
                  </td>
                  <td className="px-3 py-2 text-[13px] font-semibold text-gray-800">{r.dimLabel}</td>
                  {CONSULT_STATUSES.map((s) => (
                    <td
                      key={s}
                      className="px-2.5 py-2 text-right font-mono text-[12.5px] tabular-nums text-gray-700"
                    >
                      {r.counts[s] ? num(r.counts[s]) : <span className="text-gray-300">-</span>}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right font-mono text-[13px] font-bold tabular-nums text-ink-900">
                    {num(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11.5px] leading-relaxed text-gray-400">
        * 상담상태가 변경된 시점(회원정보 저장 이력) 기준 집계입니다. 상담원별은 상태를 변경한
        계정을 담당자로 봅니다(다른 담당자가 대신 입력한 경우 다를 수 있어요).
      </p>
    </div>
  )
}

function TrendChart({ points, unit }: { points: StatPoint[]; unit: 'count' | 'won' }) {
  const hasData = points.some((p) => p.value > 0)
  if (!hasData) {
    return (
      <div className="grid h-[260px] place-items-center gap-1 text-[13px] text-gray-400">
        <LineChartIcon className="h-6 w-6" />
        해당 기간 데이터 없음
      </div>
    )
  }
  const seriesLabel = unit === 'won' ? '매출' : '건수'
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={points} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="stat-fill" x1="0" y1="0" x2="0" y2="1">
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
          tickFormatter={(v: number) => (unit === 'won' ? fmtWon(v) : String(v))}
        />
        <Tooltip
          formatter={(value: number) => [unit === 'won' ? krw(value) : `${num(value)}건`, seriesLabel]}
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
          dataKey="value"
          stroke="var(--primary-500)"
          strokeWidth={2}
          fill="url(#stat-fill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function BreakdownTable({ b }: { b: StatBreakdown }) {
  const fmt = (v: number) => (b.unit === 'won' ? krw(v) : num(v))
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-gray-200 text-[11.5px] font-semibold text-gray-500">
          <th className="py-2 text-left">{b.title.replace(/별.*$/, '')}</th>
          <th className="py-2 text-right">{b.valueHeader}</th>
          <th className="w-[34%] py-2 pl-4 text-left">비중</th>
        </tr>
      </thead>
      <tbody>
        {b.rows.map((r) => (
          <tr key={r.key} className="border-b border-gray-100 last:border-0">
            <td className="py-2 font-medium text-ink-800">
              {r.label}
              {r.sub && <span className="ml-2 text-[11px] font-normal text-gray-400">{r.sub}</span>}
            </td>
            <td className="py-2 text-right font-mono font-semibold text-ink-900 tnum">{fmt(r.value)}</td>
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
    </table>
  )
}
