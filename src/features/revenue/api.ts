// 매출 모듈 데이터 훅 (CLAUDE §8·§9, BUILD_PROMPTS Phase 5). 원본 스샷 없음 → 직접 구현.
// 매출은 별도 테이블 없이 payments(status='approved') 파생 집계다(DECISIONS D14). 귀속/인식
// 규칙은 lib/revenueRules 의 REVENUE_RULES 한 곳에서 교체 가능. 컴포넌트 직접 fetch 금지 — 훅 경유.
import { useQuery } from '@tanstack/react-query'
import { eachDayOfInterval, format, parseISO } from 'date-fns'
import type { Member, Payment } from '@/types/db'
import { readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchTables } from '@/lib/db/remote'
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

// RLS 에뮬레이션: 매출은 rep 제외(admin/manager=전체, leader=본인 팀). 라우트 가드와 이중.
function scopeApproved(
  payments: readonly Payment[],
  members: Record<string, Member>,
  user: CurrentUser | null,
): Payment[] {
  const approved = payments.filter((p) => p.status === 'approved')
  if (!user) return []
  if (user.role === 'admin' || user.role === 'manager') return approved
  if (user.role === 'leader')
    return approved.filter((p) => members[p.member_id]?.team_id === user.teamId)
  return []
}

const dayOf = (iso: string): string => format(parseISO(iso), 'yyyy-MM-dd')
function inRange(day: string, from: string | null, to: string | null): boolean {
  if (from && day < from) return false
  if (to && day > to) return false
  return true
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

export function useRevenue(q: RevenueQuery) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: revenueKeys.summary({ ...q, uid: user?.id ?? 'anon', role: user?.role ?? 'none' }),
    queryFn: async (): Promise<RevenueResult> => {
      const db =
        dataSource === 'supabase'
          ? await fetchTables(['members', 'staff', 'teams', 'products', 'payments'])
          : readDb()
      const members = indexMembers(db.members)
      const staffNames: Record<string, string> = {}
      for (const s of db.staff) staffNames[s.id] = s.name
      const teamNames: Record<string, string> = {}
      for (const t of db.teams) teamNames[t.id] = t.name
      const productNames: Record<string, string> = {}
      for (const pr of db.products) productNames[pr.id] = pr.name

      const scoped = scopeApproved(db.payments, members, user)
      const convIds = conversionIds(scoped)

      // 기간 필터(승인일 기준). periodAll = 전체 승인, periodConv = 그중 전환.
      const periodAll = scoped.filter((p) => inRange(dayOf(recognitionIso(p)), q.from, q.to))
      const periodConv = periodAll.filter((p) => convIds.has(p.id))
      const activeSet = q.view === 'conversion' ? periodConv : periodAll

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

      // 그룹 분해(뷰별 차원 고정 / real 은 선택).
      const dim: GroupDim = q.view === 'team' ? 'team' : q.view === 'conversion' ? 'staff' : q.groupBy
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
