// 운영 대시보드 (CLAUDE §8, BUILD_PROMPTS Phase 9). KPI 카드(오늘 신규유입·미아웃콜·결제대기·
// 오늘매출) + 14일 가입 추이 + 처리대기(미아웃콜·결제대기) — 전부 실시간 집계(하드코딩 금지).
// 카드/전체보기는 해당 필터가 적용된 화면으로 딥링크하되, 역할이 접근 불가한 대상이면(매트릭스
// nav_access) 비활성으로 둔다 — 라우트 가드(RequireNav)로 튕기지 않도록. 수치는 보는 사람 스코프.
import { useNavigate } from 'react-router-dom'
import { BRAND } from '@/lib/brand'
import type { ReactNode } from 'react'
import {
  ChevronRight,
  CreditCard,
  LineChart as LineChartIcon,
  PhoneOutgoing,
  UserPlus,
  Wallet,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Badge, EmptyState, KpiCard, PageHeader, Skeleton } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { useRole } from '@/lib/auth'
import { useNavAccess } from '@/lib/navAccess'
import { canAccessWith, type NavKey } from '@/lib/permissions'
import { krw, num, phone, dateShort, datetime } from '@/lib/format'
import { useDashboard, type DashSignupPoint } from './api'

interface KpiConfig {
  label: string
  value: string
  icon: ReactNode
  iconClassName?: string
  accent?: boolean
  delta?: string
  deltaDir?: 'up' | 'down' | 'neutral'
  navKey: NavKey
  to: string
}

export function DashboardPage() {
  usePageMeta('대시보드', `${BRAND.name} 운영 콘솔`)
  const navigate = useNavigate()
  const role = useRole()
  const { data: navMap } = useNavAccess()
  const { data, isLoading } = useDashboard()

  const can = (key: NavKey) => canAccessWith(navMap, role, key)
  const k = data?.kpis

  const cards: KpiConfig[] = [
    {
      label: '오늘 신규유입',
      value: `${num(k?.todayJoin ?? 0)}명`,
      icon: <UserPlus className="h-[18px] w-[18px]" />,
      accent: true,
      delta: `최근 7일 ${num(k?.weekJoin ?? 0)}명`,
      navKey: 'members',
      to: '/members?view=today-join',
    },
    {
      label: '미아웃콜',
      value: `${num(k?.noOutcall ?? 0)}명`,
      icon: <PhoneOutgoing className="h-[18px] w-[18px]" />,
      iconClassName: 'bg-accent-50 text-accent-600',
      delta: '아웃콜 미처리',
      deltaDir: (k?.noOutcall ?? 0) > 0 ? 'down' : 'neutral',
      navKey: 'members',
      to: '/members?view=no-outcall-all',
    },
    {
      label: '결제대기',
      value: `${num(k?.paymentWait ?? 0)}건`,
      icon: <CreditCard className="h-[18px] w-[18px]" />,
      iconClassName: 'bg-warning-bg text-warning',
      delta: `대기 ${krw(k?.paymentWaitAmount ?? 0)}`,
      deltaDir: (k?.paymentWait ?? 0) > 0 ? 'down' : 'neutral',
      navKey: 'payments',
      to: '/payments?st=wait',
    },
    {
      label: '오늘매출',
      value: krw(k?.todayRevenue ?? 0),
      icon: <Wallet className="h-[18px] w-[18px]" />,
      iconClassName: 'bg-success-bg text-success',
      delta: `${num(k?.todayApproved ?? 0)}건 승인`,
      deltaDir: (k?.todayApproved ?? 0) > 0 ? 'up' : 'neutral',
      navKey: 'revenue',
      to: '/revenue',
    },
  ]

  return (
    <div>
      <PageHeader
        title="대시보드"
        description="오늘의 유입 · 아웃콜 · 결제 현황을 실시간 집계(§8). 카드를 누르면 해당 목록으로 이동합니다."
      />

      {/* KPI */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => {
          const clickable = can(c.navKey)
          return (
            <KpiCard
              key={c.label}
              accent={c.accent}
              label={c.label}
              value={isLoading && !data ? '…' : c.value}
              icon={c.icon}
              iconClassName={c.iconClassName}
              delta={c.delta}
              deltaDir={c.deltaDir}
              onClick={clickable ? () => navigate(c.to) : undefined}
            />
          )
        })}
      </div>

      {/* 14일 가입 추이 */}
      <section className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-[15px] font-bold text-ink-900">최근 14일 신규가입 추이</h2>
        {isLoading && !data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : (
          <TrendChart points={data?.trend ?? []} />
        )}
      </section>

      {/* 처리대기 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <PendingSection
          title="미아웃콜 처리대기"
          icon={<PhoneOutgoing className="h-4 w-4" />}
          iconClassName="bg-accent-50 text-accent-600"
          count={k?.noOutcall}
          onMore={can('members') ? () => navigate('/members?view=no-outcall-all') : undefined}
          isLoading={isLoading && !data}
          isEmpty={(data?.pendingOutcall.length ?? 0) === 0}
          emptyText="미아웃콜 회원이 없습니다."
          more={data?.outcallMore ?? 0}
        >
          <ul>
            {data?.pendingOutcall.map((it) => (
              <li
                key={it.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-ink-800">{it.name}</span>
                    <Badge grade={it.grade} />
                  </div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-gray-400 tnum">
                    {phone(it.phone)} · {dateShort(it.registeredAt)} 가입
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </PendingSection>

        <PendingSection
          title="결제대기"
          icon={<CreditCard className="h-4 w-4" />}
          iconClassName="bg-warning-bg text-warning"
          count={k?.paymentWait}
          onMore={can('payments') ? () => navigate('/payments?st=wait') : undefined}
          isLoading={isLoading && !data}
          isEmpty={(data?.pendingPayment.length ?? 0) === 0}
          emptyText="대기 중인 결제가 없습니다."
          more={data?.paymentMore ?? 0}
        >
          <ul>
            {data?.pendingPayment.map((it) => (
              <li
                key={it.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-ink-800">{it.memberName}</div>
                  <div className="mt-0.5 text-[11.5px] text-gray-400">
                    {it.methodLabel} · {datetime(it.createdAt)}
                  </div>
                </div>
                <div className="shrink-0 font-mono text-[13px] font-bold text-ink-900 tnum">
                  {krw(it.amount)}
                </div>
              </li>
            ))}
          </ul>
        </PendingSection>
      </div>
    </div>
  )
}

function TrendChart({ points }: { points: DashSignupPoint[] }) {
  const hasData = points.some((p) => p.value > 0)
  if (!hasData) {
    return (
      <div className="grid h-[240px] place-items-center gap-1 text-[13px] text-gray-400">
        <LineChartIcon className="h-6 w-6" />
        최근 14일 가입 데이터 없음
      </div>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={points} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="dash-fill" x1="0" y1="0" x2="0" y2="1">
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
          minTickGap={16}
        />
        <YAxis
          width={40}
          allowDecimals={false}
          tick={{ fontSize: 11, fill: 'var(--gray-500)' }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          formatter={(value: number) => [`${num(value)}명`, '신규가입']}
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
          fill="url(#dash-fill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function PendingSection({
  title,
  icon,
  iconClassName,
  count,
  onMore,
  isLoading,
  isEmpty,
  emptyText,
  more,
  children,
}: {
  title: string
  icon: ReactNode
  iconClassName: string
  count: number | undefined
  onMore?: () => void
  isLoading: boolean
  isEmpty: boolean
  emptyText: string
  more: number
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <header className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`grid h-7 w-7 place-items-center rounded-md ${iconClassName}`}>{icon}</span>
          <h2 className="text-[14px] font-bold text-ink-900">{title}</h2>
          {count != null && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11.5px] font-bold text-gray-600 tnum">
              {num(count)}
            </span>
          )}
        </div>
        {onMore && (
          <button
            type="button"
            onClick={onMore}
            className="inline-flex items-center gap-0.5 text-[12px] font-semibold text-primary-600 hover:text-primary-700"
          >
            전체보기
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      <div className="p-2">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : isEmpty ? (
          <EmptyState title="처리할 항목 없음" description={emptyText} />
        ) : (
          <>
            {children}
            {more > 0 && (
              <div className="px-2 pb-1 pt-2 text-[11.5px] text-gray-400">+{num(more)}건 더 있음</div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
