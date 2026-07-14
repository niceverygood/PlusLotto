// 통계 모듈 데이터 훅 (CLAUDE §9, BUILD_PROMPTS Phase 9 — 가입·결제 미확인 → 직접 구현).
// 가입/결제/유입 3뷰를 기간 필터로 집계한다. 전부 readDb() 파생(컴포넌트 직접 fetch 금지),
// 매출은 payments(status='approved') 파생이라 매출 모듈과 수치 정합(§8). 감사/집계 화면이므로
// 항상 최신 조회(staleTime 0 + refetchOnMount) — §8 액션이 바꾼 데이터를 진입 시 즉시 반영.
import { useQuery } from '@tanstack/react-query'
import { eachDayOfInterval, format, parseISO } from 'date-fns'
import type { Grade, LogEntry, Member, Payment, PaymentStatus, Staff } from '@/types/db'
import { readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchTables } from '@/lib/db/remote'
import { useCurrentUser, type CurrentUser } from '@/lib/auth'
import { GRADE_LABEL, PAYMENT_METHOD_LABEL } from '@/design-system/labels'
import {
  computeConsultReport,
  type ConsultReportRow,
  type ReportDimension,
  type ReportPeriod,
} from '@/lib/consultReport'

export type StatsView = 'signup' | 'payment' | 'inflow' | 'consult'

const PAID_GRADES: readonly Grade[] = ['gold', 'goldp', 'vip', 'royal']
const isPaid = (g: Grade): boolean => PAID_GRADES.includes(g)
const MAX_TREND_DAYS = 370

const STATUS_LABEL: Record<PaymentStatus, string> = {
  wait: '대기',
  approved: '승인',
  failed: '실패',
  cancelled: '취소',
}

export interface StatKpi {
  label: string
  value: string
  sub?: string
}
export interface StatPoint {
  date: string
  label: string // MM-dd (축)
  value: number
}
export interface StatRow {
  key: string
  label: string
  value: number // 정렬·비중 기준 값 (count 또는 won)
  count: number
  share: number // 0..1
  sub?: string // 보조 지표 텍스트(예: 전환 23%)
}
export interface StatBreakdown {
  title: string
  unit: 'count' | 'won'
  valueHeader: string
  rows: StatRow[]
}
export interface StatsResult {
  kpis: StatKpi[]
  trendTitle: string
  trendUnit: 'count' | 'won'
  trend: StatPoint[]
  breakdowns: StatBreakdown[]
}

export interface StatsQuery {
  view: StatsView
  from: string // yyyy-MM-dd
  to: string
}

// ── RLS 에뮬레이션 (매출 모듈과 동일 기준): admin/manager=전체, leader=본인 팀, rep=본인 담당. ──
function scopeMembers(all: readonly Member[], user: CurrentUser | null): Member[] {
  if (!user) return []
  if (user.role === 'admin' || user.role === 'manager') return [...all]
  if (user.role === 'leader') return all.filter((m) => m.team_id === user.teamId)
  return all.filter((m) => m.assigned_staff_id === user.id)
}
function scopePayments(
  payments: readonly Payment[],
  members: Record<string, Member>,
  user: CurrentUser | null,
): Payment[] {
  if (!user) return []
  if (user.role === 'admin' || user.role === 'manager') return [...payments]
  if (user.role === 'leader')
    return payments.filter((p) => members[p.member_id]?.team_id === user.teamId)
  return payments.filter((p) => members[p.member_id]?.assigned_staff_id === user.id)
}

const dayOf = (iso: string): string => format(parseISO(iso), 'yyyy-MM-dd')
const inRange = (day: string, from: string, to: string): boolean => day >= from && day <= to

function trendFromMap(from: string, to: string, byDay: Map<string, number>): StatPoint[] {
  let days = eachDayOfInterval({ start: parseISO(from), end: parseISO(to <= from ? from : to) })
  if (days.length > MAX_TREND_DAYS) days = days.slice(-MAX_TREND_DAYS)
  return days.map((d) => {
    const k = format(d, 'yyyy-MM-dd')
    return { date: k, label: format(d, 'MM-dd'), value: byDay.get(k) ?? 0 }
  })
}

function toBreakdownRows(
  acc: Map<string, { label: string; value: number; count: number; sub?: string }>,
): StatRow[] {
  const total = [...acc.values()].reduce((s, v) => s + v.value, 0)
  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      label: v.label,
      value: v.value,
      count: v.count,
      share: total ? v.value / total : 0,
      sub: v.sub,
    }))
    .sort((a, b) => b.value - a.value)
}

const pct = (n: number, d: number): number => (d ? Math.round((n / d) * 1000) / 10 : 0)

// ── 가입 통계 ─────────────────────────────────────────────────────────
function signupStats(members: Member[], from: string, to: string): StatsResult {
  const period = members.filter((m) => inRange(dayOf(m.registered_at), from, to))
  const periodPaid = period.filter((m) => isPaid(m.grade)).length
  const totalPaid = members.filter((m) => isPaid(m.grade)).length
  const spanDays = Math.max(1, trendFromMap(from, to, new Map()).length)

  const byDay = new Map<string, number>()
  for (const m of period) {
    const k = dayOf(m.registered_at)
    byDay.set(k, (byDay.get(k) ?? 0) + 1)
  }

  const gradeAcc = new Map<string, { label: string; value: number; count: number }>()
  for (const m of members) {
    const cur = gradeAcc.get(m.grade) ?? { label: GRADE_LABEL[m.grade], value: 0, count: 0 }
    cur.value += 1
    cur.count += 1
    gradeAcc.set(m.grade, cur)
  }

  return {
    kpis: [
      { label: '기간 신규가입', value: `${period.length.toLocaleString('ko-KR')}명`, sub: `일평균 ${Math.round(period.length / spanDays).toLocaleString('ko-KR')}명` },
      { label: '누적 회원', value: `${members.length.toLocaleString('ko-KR')}명` },
      { label: '유료 회원', value: `${totalPaid.toLocaleString('ko-KR')}명`, sub: `전체의 ${pct(totalPaid, members.length)}%` },
      { label: '기간 유료전환율', value: `${pct(periodPaid, period.length)}%`, sub: `유료 ${periodPaid}명 / 가입 ${period.length}명` },
    ],
    trendTitle: '일별 신규가입 추이',
    trendUnit: 'count',
    trend: trendFromMap(from, to, byDay),
    breakdowns: [
      { title: '등급별 회원 분포', unit: 'count', valueHeader: '회원수', rows: toBreakdownRows(gradeAcc) },
    ],
  }
}

// ── 결제 통계 ─────────────────────────────────────────────────────────
function paymentStats(
  payments: Payment[],
  productNames: Record<string, string>,
  from: string,
  to: string,
): StatsResult {
  const approvedPeriod = payments.filter(
    (p) => p.status === 'approved' && p.paid_at != null && inRange(dayOf(p.paid_at), from, to),
  )
  const createdPeriod = payments.filter((p) => inRange(dayOf(p.created_at), from, to))
  const total = approvedPeriod.reduce((s, p) => s + p.amount, 0)
  const count = approvedPeriod.length

  const byDay = new Map<string, number>()
  for (const p of approvedPeriod) {
    const k = dayOf(p.paid_at as string)
    byDay.set(k, (byDay.get(k) ?? 0) + p.amount)
  }

  const productAcc = new Map<string, { label: string; value: number; count: number }>()
  const methodAcc = new Map<string, { label: string; value: number; count: number }>()
  for (const p of approvedPeriod) {
    const pk = p.product_id ?? 'none'
    const pcur = productAcc.get(pk) ?? {
      label: p.product_id ? (productNames[p.product_id] ?? p.product_id) : '기타',
      value: 0,
      count: 0,
    }
    pcur.value += p.amount
    pcur.count += 1
    productAcc.set(pk, pcur)

    const mk = p.method === 'pg' ? `pg:${p.pg_provider ?? 'PG'}` : `m:${p.method}`
    const mlabel = p.method === 'pg' ? (p.pg_provider ?? 'PG(미지정)') : PAYMENT_METHOD_LABEL[p.method]
    const mcur = methodAcc.get(mk) ?? { label: mlabel, value: 0, count: 0 }
    mcur.value += p.amount
    mcur.count += 1
    methodAcc.set(mk, mcur)
  }

  const statusAcc = new Map<string, { label: string; value: number; count: number }>()
  for (const p of createdPeriod) {
    const cur = statusAcc.get(p.status) ?? { label: STATUS_LABEL[p.status], value: 0, count: 0 }
    cur.value += 1
    cur.count += 1
    statusAcc.set(p.status, cur)
  }

  return {
    kpis: [
      { label: '기간 매출', value: `₩ ${total.toLocaleString('ko-KR')}`, sub: `${count.toLocaleString('ko-KR')}건 승인` },
      { label: '결제 건수', value: `${count.toLocaleString('ko-KR')}건` },
      { label: '평균 결제액', value: `₩ ${(count ? Math.round(total / count) : 0).toLocaleString('ko-KR')}` },
      { label: '승인율', value: `${pct(approvedPeriod.length, createdPeriod.length)}%`, sub: `기간 접수 ${createdPeriod.length}건 기준` },
    ],
    trendTitle: '일별 매출 추이',
    trendUnit: 'won',
    trend: trendFromMap(from, to, byDay),
    breakdowns: [
      { title: '상품별 매출', unit: 'won', valueHeader: '매출', rows: toBreakdownRows(productAcc) },
      { title: '결제수단·PG별 매출', unit: 'won', valueHeader: '매출', rows: toBreakdownRows(methodAcc) },
      { title: '상태별 결제(기간 접수)', unit: 'count', valueHeader: '건수', rows: toBreakdownRows(statusAcc) },
    ],
  }
}

// ── 유입 통계 ─────────────────────────────────────────────────────────
function inflowStats(members: Member[], from: string, to: string): StatsResult {
  const period = members.filter((m) => inRange(dayOf(m.registered_at), from, to))
  const periodPaid = period.filter((m) => isPaid(m.grade)).length

  const byDay = new Map<string, number>()
  for (const m of period) {
    const k = dayOf(m.registered_at)
    byDay.set(k, (byDay.get(k) ?? 0) + 1)
  }

  // 유입경로별: 건수 + 유료전환율(보조)
  const typeAcc = new Map<string, { label: string; value: number; count: number; paid: number }>()
  for (const m of period) {
    const key = m.inflow_type ?? 'unknown'
    const cur = typeAcc.get(key) ?? { label: m.inflow_type ?? '미상', value: 0, count: 0, paid: 0 }
    cur.value += 1
    cur.count += 1
    if (isPaid(m.grade)) cur.paid += 1
    typeAcc.set(key, cur)
  }
  const typeRows = toBreakdownRows(
    new Map(
      [...typeAcc.entries()].map(([k, v]) => [
        k,
        { label: v.label, value: v.value, count: v.count, sub: `전환 ${pct(v.paid, v.count)}%` },
      ]),
    ),
  )

  // 유입코드 상위
  const codeAcc = new Map<string, { label: string; value: number; count: number }>()
  for (const m of period) {
    const key = m.inflow_code ?? 'none'
    const cur = codeAcc.get(key) ?? { label: m.inflow_code ?? '미상', value: 0, count: 0 }
    cur.value += 1
    cur.count += 1
    codeAcc.set(key, cur)
  }

  const distinctTypes = new Set(members.map((m) => m.inflow_type ?? '미상')).size
  const topType = typeRows[0]?.label ?? '-'

  return {
    kpis: [
      { label: '기간 신규유입', value: `${period.length.toLocaleString('ko-KR')}명` },
      { label: '유입경로 수', value: `${distinctTypes}개` },
      { label: '최다 유입경로', value: topType, sub: typeRows[0] ? `${typeRows[0].count}명` : undefined },
      { label: '평균 유료전환율', value: `${pct(periodPaid, period.length)}%`, sub: `유료 ${periodPaid}명` },
    ],
    trendTitle: '일별 신규유입 추이',
    trendUnit: 'count',
    trend: trendFromMap(from, to, byDay),
    breakdowns: [
      { title: '유입경로별 유입(전환율)', unit: 'count', valueHeader: '유입수', rows: typeRows },
      { title: '유입코드 상위', unit: 'count', valueHeader: '유입수', rows: codeAcc.size ? toBreakdownRows(codeAcc) : [] },
    ],
  }
}

export function useStats(q: StatsQuery) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: ['stats', q.view, q.from, q.to, user?.id ?? 'anon', user?.role ?? 'none'],
    queryFn: async (): Promise<StatsResult> => {
      const db =
        dataSource === 'supabase' ? await fetchTables(['members', 'payments', 'products']) : readDb()
      const members = scopeMembers(db.members, user)
      if (q.view === 'signup') return signupStats(members, q.from, q.to)
      if (q.view === 'inflow') return inflowStats(members, q.from, q.to)
      const memberMap: Record<string, Member> = {}
      for (const m of db.members) memberMap[m.id] = m
      const productNames: Record<string, string> = {}
      for (const pr of db.products) productNames[pr.id] = pr.name
      const payments = scopePayments(db.payments, memberMap, user)
      return paymentStats(payments, productNames, q.from, q.to)
    },
    staleTime: 0,
    refetchOnMount: 'always',
    placeholderData: (prev) => prev,
  })
}

// ── 상담 리포트(유입코드별·상담원별, 주차/월별) — 현장 피드백 7/10 ──────────────
export interface ConsultReportQuery {
  dimension: ReportDimension
  period: ReportPeriod
  from: string | null
  to: string | null
}

export function useConsultReport(q: ConsultReportQuery) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: ['stats', 'consult', q.dimension, q.period, q.from, q.to, user?.id ?? 'anon', user?.role ?? 'none'],
    queryFn: async (): Promise<ConsultReportRow[]> => {
      const db =
        dataSource === 'supabase' ? await fetchTables(['members', 'staff', 'logs']) : readDb()
      const members = scopeMembers(db.members, user)
      // computeConsultReport 가 members 스코프 밖 이벤트를 자동 제외한다(팀장/담당 경계 보장).
      return computeConsultReport(db.logs as LogEntry[], members, db.staff as Staff[], {
        dimension: q.dimension,
        period: q.period,
        from: q.from,
        to: q.to,
      })
    },
    staleTime: 0,
    refetchOnMount: 'always',
    placeholderData: (prev) => prev,
  })
}
