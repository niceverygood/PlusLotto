// 매출 모듈 데이터 훅 (CLAUDE §8·§9, BUILD_PROMPTS Phase 5). 원본 스샷 없음 → 직접 구현.
// 매출은 별도 테이블 없이 payments(status='approved') 파생 집계다(DECISIONS D14). 귀속/인식
// 규칙은 lib/revenueRules 의 REVENUE_RULES 한 곳에서 교체 가능. 컴포넌트 직접 fetch 금지 — 훅 경유.
import { useQuery } from '@tanstack/react-query'
import { eachDayOfInterval, format, parseISO } from 'date-fns'
import type { Member, Payment, Staff } from '@/types/db'
import { readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { sb } from '@/lib/db/remote'
import { useCurrentUser, type CurrentUser } from '@/lib/auth'
import { revenueKeys } from '@/lib/queryKeys'
import { recognitionIso } from '@/lib/revenueRules'
import { PAYMENT_METHOD_LABEL } from '@/design-system/labels'

export type RevenueView = 'real' | 'conversion' | 'team'
export type GroupDim = 'staff' | 'team' | 'product' | 'pg'

export const GROUP_LABEL: Record<GroupDim, string> = {
  staff: '담당자',
  team: '팀',
  product: '상품',
  pg: '결제수단',
}

export interface RevenueQuery {
  view: RevenueView
  from: string | null // yyyy-MM-dd
  to: string | null
  /** 'real' 뷰에서만 사용. team→'team', conversion→'staff' 로 고정. */
  groupBy: GroupDim
}

export interface RevenueSummary {
  total: number
  count: number
  avg: number
  conversions: number // 기간 내 신규(첫 승인 유료) 전환 건수
  conversionRevenue: number
  conversionRate: number // conversions / (기간 내 전체 승인 건수)
}
export interface TrendPoint {
  date: string // yyyy-MM-dd
  label: string // MM-dd (축 표시)
  amount: number
  count: number
}
export interface BreakdownRow {
  key: string
  label: string
  amount: number
  count: number
  share: number // 0..1 (해당 집계 합계 대비)
}
export interface RevenueResult {
  summary: RevenueSummary
  trend: TrendPoint[]
  breakdown: BreakdownRow[]
  groupDim: GroupDim
}

const MAX_TREND_DAYS = 370

function indexMembers(members: readonly Member[]): Record<string, Member> {
  const out: Record<string, Member> = {}
  for (const m of members) out[m.id] = m
  return out
}

// RLS 에뮬레이션: 최고관리자·관리자·실장=전체, 팀장(rep)=매출 메뉴 제외.
// D51에서 실장(leader)의 회원 조회 범위를 전체로 확정했으므로 집계도 동일해야 한다.
function scopeApproved(
  payments: readonly Payment[],
  user: CurrentUser | null,
): Payment[] {
  const approved = payments.filter((p) => p.status === 'approved')
  if (!user) return []
  if (user.role === 'admin' || user.role === 'manager' || user.role === 'leader') return approved
  return []
}

const dayOf = (iso: string): string => format(parseISO(iso), 'yyyy-MM-dd')
function inRange(day: string, from: string | null, to: string | null): boolean {
  if (from && day < from) return false
  if (to && day > to) return false
  return true
}

/**
 * 담당자 역할 조회(현장 피드백 7/29) — "팀장매출"/"실장매출" 뷰는 1차결제(신규전환) 여부가 아니라
 * 담당자 역할로 갈라야 한다: 팀장매출=담당자 역할이 팀장(rep), 실장매출=실장 이상(leader/manager/admin).
 * 예전엔 이 두 뷰가 "신규전환 결제인지"로 갈려 있어(D93 7/23) 관리자가 처리한 신규전환도 팀장매출에,
 * 팀장이 처리한 갱신결제도 실장매출(팀 전체)에 섞여 나왔다.
 */
function staffRoleById(staffList: readonly Staff[]): Record<string, Staff['role']> {
  const out: Record<string, Staff['role']> = {}
  for (const s of staffList) out[s.id] = s.role
  return out
}

/** 이 결제가 view(팀장매출=conversion/실장매출=team)에 속하는지 — 담당자 역할 기준. */
function inRoleView(
  p: Payment,
  view: 'conversion' | 'team',
  roleById: Record<string, Staff['role']>,
): boolean {
  const role = p.staff_id ? roleById[p.staff_id] : undefined
  if (!role) return false // 담당 미배정은 두 뷰 다 제외(전체매출에만 포함)
  return view === 'conversion' ? role === 'rep' : role !== 'rep'
}

/** 회원별 첫 승인 유료결제 id 집합(= 무료→유료 전환 시점). REVENUE_RULES.conversion. */
function conversionIds(approved: readonly Payment[]): Set<string> {
  const firstByMember = new Map<string, Payment>()
  for (const p of approved) {
    if (p.product_id == null) continue
    const cur = firstByMember.get(p.member_id)
    if (!cur || Date.parse(recognitionIso(p)) < Date.parse(recognitionIso(cur))) {
      firstByMember.set(p.member_id, p)
    }
  }
  const ids = new Set<string>()
  for (const p of firstByMember.values()) ids.add(p.id)
  return ids
}

function groupOf(
  p: Payment,
  dim: GroupDim,
  members: Record<string, Member>,
  staffNames: Record<string, string>,
  teamNames: Record<string, string>,
  productNames: Record<string, string>,
): { key: string; label: string } {
  switch (dim) {
    case 'staff': {
      const id = p.staff_id
      return { key: id ?? 'none', label: id ? (staffNames[id] ?? id) : '미배정' }
    }
    case 'team': {
      const t = members[p.member_id]?.team_id ?? null
      return { key: t ?? 'none', label: t ? (teamNames[t] ?? t) : '미배정' }
    }
    case 'product': {
      const id = p.product_id
      return { key: id ?? 'none', label: id ? (productNames[id] ?? id) : '기타' }
    }
    case 'pg': {
      if (p.method === 'pg') {
        const prov = p.pg_provider ?? 'PG(미지정)'
        return { key: `pg:${prov}`, label: prov }
      }
      return { key: `m:${p.method}`, label: PAYMENT_METHOD_LABEL[p.method] }
    }
  }
}

export function useRevenue(q: RevenueQuery, opts: { enabled?: boolean } = {}) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: revenueKeys.summary({ ...q, uid: user?.id ?? 'anon', role: user?.role ?? 'none' }),
    enabled: opts.enabled ?? true,
    queryFn: async (): Promise<RevenueResult> => {
      if (dataSource === 'supabase') {
        const { data, error } = await sb().rpc('admin_revenue', {
          p_view: q.view,
          p_from: q.from,
          p_to: q.to,
          p_group: q.groupBy,
        })
        if (error) throw error
        return data as RevenueResult
      }
      const db =
        readDb()
      const members = indexMembers(db.members)
      const staffNames: Record<string, string> = {}
      for (const s of db.staff) staffNames[s.id] = s.name
      const teamNames: Record<string, string> = {}
      for (const t of db.teams) teamNames[t.id] = t.name
      const productNames: Record<string, string> = {}
      for (const pr of db.products) productNames[pr.id] = pr.name

      const scoped = scopeApproved(db.payments, user)
      const convIds = conversionIds(scoped)
      const roleById = staffRoleById(db.staff)

      // 기간 필터(승인일 기준). periodAll = 전체 승인, periodConv = 그중 전환(1차결제) — "신규전환율"
      // KPI 전용(뷰 선택과 무관, 아래 activeSet 필터와는 별개 지표).
      const periodAll = scoped.filter((p) => inRange(dayOf(recognitionIso(p)), q.from, q.to))
      const periodConv = periodAll.filter((p) => convIds.has(p.id))
      // 팀장매출(conversion)=담당자 역할이 팀장. 실장매출(team)=실장 이상(현장 피드백 7/29).
      const activeSet =
        q.view === 'conversion' || q.view === 'team'
          ? periodAll.filter((p) => inRoleView(p, q.view as 'conversion' | 'team', roleById))
          : periodAll

      // 요약
      const total = activeSet.reduce((s, p) => s + p.amount, 0)
      const count = activeSet.length
      const conversionRevenue = periodConv.reduce((s, p) => s + p.amount, 0)
      const summary: RevenueSummary = {
        total,
        count,
        avg: count ? Math.round(total / count) : 0,
        conversions: periodConv.length,
        conversionRevenue,
        conversionRate: periodAll.length ? periodConv.length / periodAll.length : 0,
      }

      // 일별 추이(연속 축). from/to 없으면 데이터 범위로 보정.
      const sortedDays = activeSet.map((p) => dayOf(recognitionIso(p))).sort()
      const today = format(new Date(), 'yyyy-MM-dd')
      let start = q.from ?? sortedDays[0] ?? today
      let end = q.to ?? sortedDays[sortedDays.length - 1] ?? today
      if (start > end) end = start
      let days = eachDayOfInterval({ start: parseISO(start), end: parseISO(end) })
      if (days.length > MAX_TREND_DAYS) days = days.slice(-MAX_TREND_DAYS)
      const byDay = new Map<string, { amount: number; count: number }>()
      for (const p of activeSet) {
        const k = dayOf(recognitionIso(p))
        const cur = byDay.get(k) ?? { amount: 0, count: 0 }
        cur.amount += p.amount
        cur.count += 1
        byDay.set(k, cur)
      }
      const trend: TrendPoint[] = days.map((d) => {
        const k = format(d, 'yyyy-MM-dd')
        const v = byDay.get(k)
        return { date: k, label: format(d, 'MM-dd'), amount: v?.amount ?? 0, count: v?.count ?? 0 }
      })

      // 그룹 분해(뷰별 차원 고정 / real 은 선택). 팀장매출·실장매출 둘 다 담당자(개인) 기준으로
      // 이름·금액을 보여준다(현장 피드백 8/3 — 실장매출이 팀 단위로 뭉쳐 나오던 것을 담당자별로 분리).
      const dim: GroupDim = q.view === 'team' || q.view === 'conversion' ? 'staff' : q.groupBy
      const acc = new Map<string, { label: string; amount: number; count: number }>()
      for (const p of activeSet) {
        const g = groupOf(p, dim, members, staffNames, teamNames, productNames)
        const cur = acc.get(g.key) ?? { label: g.label, amount: 0, count: 0 }
        cur.amount += p.amount
        cur.count += 1
        acc.set(g.key, cur)
      }
      const breakdown: BreakdownRow[] = [...acc.entries()]
        .map(([key, v]) => ({
          key,
          label: v.label,
          amount: v.amount,
          count: v.count,
          share: total ? v.amount / total : 0,
        }))
        .sort((a, b) => b.amount - a.amount)

      return { summary, trend, breakdown, groupDim: dim }
    },
    placeholderData: (prev) => prev,
  })
}

// ── 매출 캘린더(현장 피드백 7/24, 정의현 차장 — 기존 전산 동일 구성) ──────────────────
// 월별 달력에 일자별 합계 + 담당자별(건수·금액) 내역을 표시. 전체매출(real)과 동일한 승인결제
// 기준·역할 스코프를 쓰되, 팀장매출/실장매출처럼 뷰별 하위집합 필터는 적용하지 않는다(전체 기준).
export interface RevenueCalendarStaffRow {
  staffId: string | null
  label: string
  count: number
  amount: number
}
export interface RevenueCalendarDay {
  date: string // yyyy-MM-dd
  total: number
  count: number
  byStaff: RevenueCalendarStaffRow[] // 금액 내림차순
}
export interface RevenueCalendarResult {
  month: string // yyyy-MM
  monthTotal: number
  monthCount: number
  days: RevenueCalendarDay[] // 실적이 있는 날짜만(빈 날짜는 화면에서 0으로 처리)
}

/** month = 'yyyy-MM'. view: 전체매출(real)·팀장매출(conversion=1차결제만)·실장매출(team=1차결제 제외)(현장 피드백 7/28). */
export function useRevenueCalendar(month: string, view: RevenueView = 'real') {
  const user = useCurrentUser()
  return useQuery({
    queryKey: revenueKeys.calendar(`${month}:${view}:${user?.id ?? 'anon'}:${user?.role ?? 'none'}`),
    queryFn: async (): Promise<RevenueCalendarResult> => {
      if (dataSource === 'supabase') {
        const { data, error } = await sb().rpc('admin_revenue_calendar', { p_month: `${month}-01`, p_view: view })
        if (error) throw error
        return data as RevenueCalendarResult
      }
      const db = readDb()
      const staffNames: Record<string, string> = {}
      for (const s of db.staff) staffNames[s.id] = s.name

      const scoped = scopeApproved(db.payments, user)
      const roleById = staffRoleById(db.staff)
      // 팀장매출(conversion)=담당자 역할이 팀장. 실장매출(team)=실장 이상(현장 피드백 7/29).
      const viewScoped =
        view === 'conversion' || view === 'team'
          ? scoped.filter((p) => inRoleView(p, view, roleById))
          : scoped
      const inMonth = viewScoped.filter((p) => dayOf(recognitionIso(p)).startsWith(month))

      const byDay = new Map<string, Map<string, { label: string; count: number; amount: number }>>()
      for (const p of inMonth) {
        const day = dayOf(recognitionIso(p))
        const sid = p.staff_id ?? 'none'
        const label = p.staff_id ? (staffNames[p.staff_id] ?? p.staff_id) : '미배정'
        const dayMap = byDay.get(day) ?? new Map()
        const cur = dayMap.get(sid) ?? { label, count: 0, amount: 0 }
        cur.count += 1
        cur.amount += p.amount
        dayMap.set(sid, cur)
        byDay.set(day, dayMap)
      }

      const days: RevenueCalendarDay[] = [...byDay.entries()]
        .map(([date, dayMap]) => {
          const byStaff = [...dayMap.entries()]
            .map(([staffId, v]) => ({
              staffId: staffId === 'none' ? null : staffId,
              label: v.label,
              count: v.count,
              amount: v.amount,
            }))
            .sort((a, b) => b.amount - a.amount)
          return {
            date,
            total: byStaff.reduce((s, r) => s + r.amount, 0),
            count: byStaff.reduce((s, r) => s + r.count, 0),
            byStaff,
          }
        })
        .sort((a, b) => a.date.localeCompare(b.date))

      return {
        month,
        monthTotal: days.reduce((s, d) => s + d.total, 0),
        monthCount: days.reduce((s, d) => s + d.count, 0),
        days,
      }
    },
    placeholderData: (prev) => prev,
  })
}

// ── 캘린더 일자 클릭 → 결제내역(현장 피드백 7/24, 기존 전산 우측 패널과 동일) ────────────
export interface RevenueDayPaymentRow {
  id: string
  depositorName: string | null
  memberUserId: string | null
  staffName: string | null
  method: Payment['method']
  productName: string | null
  amount: number
}

/** date = 'yyyy-MM-dd'. null 이면 비활성(선택된 날짜 없음). view: 캘린더와 동일 3뷰(현장 피드백 7/28). */
export function useRevenueDayPayments(date: string | null, view: RevenueView = 'real') {
  const user = useCurrentUser()
  return useQuery({
    queryKey: ['revenue', 'day-payments', date, view, user?.id ?? 'anon', user?.role ?? 'none'],
    queryFn: async (): Promise<RevenueDayPaymentRow[]> => {
      if (!date) return []
      if (dataSource === 'supabase') {
        const { data, error } = await sb().rpc('admin_revenue_day_payments', { p_day: date, p_view: view })
        if (error) throw error
        return (data ?? []) as RevenueDayPaymentRow[]
      }
      const db = readDb()
      const members = indexMembers(db.members)
      const staffNames: Record<string, string> = {}
      for (const s of db.staff) staffNames[s.id] = s.name
      const productNames: Record<string, string> = {}
      for (const pr of db.products) productNames[pr.id] = pr.name

      const scoped = scopeApproved(db.payments, user)
      const roleById = staffRoleById(db.staff)
      // 팀장매출(conversion)=담당자 역할이 팀장. 실장매출(team)=실장 이상(현장 피드백 7/29).
      const viewScoped =
        view === 'conversion' || view === 'team'
          ? scoped.filter((p) => inRoleView(p, view, roleById))
          : scoped

      return viewScoped
        .filter((p) => dayOf(recognitionIso(p)) === date)
        .map((p) => ({
          id: p.id,
          depositorName: p.depositor_name,
          memberUserId: members[p.member_id]?.user_id ?? null,
          staffName: p.staff_id ? (staffNames[p.staff_id] ?? p.staff_id) : null,
          method: p.method,
          productName: p.product_id ? (productNames[p.product_id] ?? null) : null,
          amount: p.amount,
        }))
        .sort((a, b) => b.amount - a.amount)
    },
    enabled: !!date,
  })
}
