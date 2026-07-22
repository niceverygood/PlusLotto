// 운영 대시보드 데이터 훅 (CLAUDE §8 — 전부 실시간 집계, 하드코딩 금지).
// 로그인 역할의 데이터 스코프(admin/manager=전체, leader=팀, rep=본인 담당) 안에서
// 오늘 신규유입·미아웃콜·결제대기·오늘매출 KPI + 14일 가입 추이 + 처리대기 목록을 파생한다.
// 집계 화면이므로 항상 최신 조회(staleTime 0 + refetchOnMount) — §8 액션(아웃콜/결제승인 등) 즉시 반영.
import { useQuery } from '@tanstack/react-query'
import { eachDayOfInterval, format, parseISO, subDays } from 'date-fns'
import type { Grade, Member, Payment } from '@/types/db'
import { readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { sb } from '@/lib/db/remote'
import { useCurrentUser, type CurrentUser } from '@/lib/auth'
import { operationalKeys } from '@/lib/queryKeys'
import { PAYMENT_METHOD_LABEL } from '@/design-system/labels'

const TREND_DAYS = 14
const LIST_LIMIT = 6

export interface DashKpis {
  todayJoin: number
  weekJoin: number
  noOutcall: number
  paymentWait: number
  paymentWaitAmount: number
  todayRevenue: number
  todayApproved: number
}
export interface DashSignupPoint {
  date: string
  label: string // MM-dd (축)
  value: number
}
export interface DashOutcallItem {
  id: string
  name: string
  grade: Grade
  phone: string
  registeredAt: string
}
export interface DashPaymentItem {
  id: string
  memberName: string
  amount: number
  methodLabel: string
  createdAt: string
}
export interface DashboardResult {
  kpis: DashKpis
  trend: DashSignupPoint[]
  pendingOutcall: DashOutcallItem[]
  pendingPayment: DashPaymentItem[]
  outcallMore: number // 목록 미표시 잔여 건수
  paymentMore: number
}

// ── RLS 에뮬레이션 (통계 모듈과 동일 기준): admin/manager=전체, leader=본인 팀, rep=본인 담당. ──
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

function methodLabelOf(p: Payment): string {
  if (p.method === 'pg') return p.pg_provider ?? 'PG'
  return PAYMENT_METHOD_LABEL[p.method]
}

export function useDashboard() {
  const user = useCurrentUser()
  return useQuery({
    queryKey: operationalKeys.dashboard(`${user?.id ?? 'anon'}:${user?.role ?? 'none'}`),
    queryFn: async (): Promise<DashboardResult> => {
      if (dataSource === 'supabase') {
        const { data, error } = await sb().rpc('admin_dashboard')
        if (error) throw error
        return data as DashboardResult
      }
      const db = readDb()
      const members = scopeMembers(db.members, user)
      const memberMap: Record<string, Member> = {}
      for (const m of db.members) memberMap[m.id] = m
      const payments = scopePayments(db.payments, memberMap, user)

      const today = format(new Date(), 'yyyy-MM-dd')
      const weekAgo = format(subDays(new Date(), 6), 'yyyy-MM-dd')

      // KPI(회원 파생): 오늘 신규유입 / 최근 7일 / 미아웃콜
      let todayJoin = 0
      let weekJoin = 0
      let noOutcall = 0
      for (const m of members) {
        const d = dayOf(m.registered_at)
        if (d === today) todayJoin += 1
        if (d >= weekAgo && d <= today) weekJoin += 1
        if (!m.outcall_done) noOutcall += 1
      }

      // KPI(결제 파생): 결제대기(건·금액) / 오늘매출(승인일 기준)
      let paymentWait = 0
      let paymentWaitAmount = 0
      let todayRevenue = 0
      let todayApproved = 0
      for (const p of payments) {
        if (p.status === 'wait') {
          paymentWait += 1
          paymentWaitAmount += p.amount
        }
        if (p.status === 'approved' && p.paid_at != null && dayOf(p.paid_at) === today) {
          todayRevenue += p.amount
          todayApproved += 1
        }
      }

      // 14일 가입 추이(연속 축)
      const byDay = new Map<string, number>()
      for (const m of members) {
        const d = dayOf(m.registered_at)
        byDay.set(d, (byDay.get(d) ?? 0) + 1)
      }
      const start = subDays(new Date(), TREND_DAYS - 1)
      const trend: DashSignupPoint[] = eachDayOfInterval({ start, end: new Date() }).map((d) => {
        const k = format(d, 'yyyy-MM-dd')
        return { date: k, label: format(d, 'MM-dd'), value: byDay.get(k) ?? 0 }
      })

      // 처리대기: 미아웃콜(최근 가입 순)
      const outcallAll = members
        .filter((m) => !m.outcall_done)
        .sort((a, b) => b.registered_at.localeCompare(a.registered_at))
      const pendingOutcall: DashOutcallItem[] = outcallAll.slice(0, LIST_LIMIT).map((m) => ({
        id: m.id,
        name: m.name,
        grade: m.grade,
        phone: m.phone,
        registeredAt: m.registered_at,
      }))

      // 처리대기: 결제대기(최근 접수 순)
      const waitAll = payments
        .filter((p) => p.status === 'wait')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
      const pendingPayment: DashPaymentItem[] = waitAll.slice(0, LIST_LIMIT).map((p) => ({
        id: p.id,
        memberName: memberMap[p.member_id]?.name ?? '(알 수 없음)',
        amount: p.amount,
        methodLabel: methodLabelOf(p),
        createdAt: p.created_at,
      }))

      return {
        kpis: {
          todayJoin,
          weekJoin,
          noOutcall,
          paymentWait,
          paymentWaitAmount,
          todayRevenue,
          todayApproved,
        },
        trend,
        pendingOutcall,
        pendingPayment,
        outcallMore: Math.max(0, outcallAll.length - LIST_LIMIT),
        paymentMore: Math.max(0, waitAll.length - LIST_LIMIT),
      }
    },
    staleTime: 30_000,
    refetchOnMount: 'always',
    placeholderData: (prev) => prev,
  })
}
