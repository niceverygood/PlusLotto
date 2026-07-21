// 결제 모듈 데이터 훅 (CLAUDE §1·§8). 전부 TanStack Query 경유 — 컴포넌트 직접 fetch 금지.
// 승인/취소/수기등록은 mock DB 를 변경하고 §8 흐름대로 회원 등급·상태·매출 귀속을
// 갱신한 뒤 payments + members 양쪽 쿼리를 무효화한다(교차 연동).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { addMonths } from 'date-fns'
import type {
  Grade,
  LogEntry,
  Member,
  Payment,
  PaymentMethod,
  Product,
} from '@/types/db'
import { genId, mutateDb, nowIso, readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchTables } from '@/lib/db/remote'
import { useCurrentUser, type CurrentUser } from '@/lib/auth'
import { memberKeys, paymentKeys, revenueKeys } from '@/lib/queryKeys'
import * as supa from './supa'

export { paymentKeys }

// ── 표시용 enrich (회원/상품 조인) ────────────────────────────────────
export interface PaymentRow extends Payment {
  member: { id: string; name: string; user_id: string; inflow_code: string | null } | null
  product: { id: string; name: string; grade_granted: Grade } | null
}

function indexBy<T extends { id: string }>(rows: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const r of rows) out[r.id] = r
  return out
}

function enrich(
  p: Payment,
  members: Record<string, Member>,
  products: Record<string, Product>,
): PaymentRow {
  const m = members[p.member_id]
  const pr = p.product_id ? products[p.product_id] : undefined
  return {
    ...p,
    member: m ? { id: m.id, name: m.name, user_id: m.user_id, inflow_code: m.inflow_code } : null,
    product: pr ? { id: pr.id, name: pr.name, grade_granted: pr.grade_granted } : null,
  }
}

// ── RLS 에뮬레이션: 회원 배정 기준으로 결제를 스코프 (members 와 동일 기준). ──
// 명칭변경/권한(현장 피드백): 최고관리자·관리자·실장=전체, 팀장(rep)=본인 담당 회원 결제만.
function scopePayments(
  payments: readonly Payment[],
  members: Record<string, Member>,
  user: CurrentUser | null,
): Payment[] {
  if (!user) return []
  if (user.role === 'rep')
    return payments.filter((p) => members[p.member_id]?.assigned_staff_id === user.id)
  return [...payments]
}

// ── 정렬 ──────────────────────────────────────────────────────────────
type SortVal = string | number
function sortValue(p: PaymentRow, id: string): SortVal | null {
  switch (id) {
    case 'amount':
      return p.amount
    case 'status':
      return p.status
    case 'method':
      return p.method
    case 'paid_at':
      return p.paid_at ? Date.parse(p.paid_at) : null
    case 'created_at':
      return Date.parse(p.created_at)
    default:
      return null
  }
}

function sortRows(rows: PaymentRow[], sortId: string, desc: boolean): PaymentRow[] {
  const dir = desc ? -1 : 1
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sortId)
    const vb = sortValue(b, sortId)
    if (va === null && vb === null) return 0
    if (va === null) return 1
    if (vb === null) return -1
    if (va < vb) return -1 * dir
    if (va > vb) return 1 * dir
    return 0
  })
}

// ── 목록 ──────────────────────────────────────────────────────────────
export const PAYMENT_STATUS_TABS = ['all', 'wait', 'approved', 'failed', 'cancelled'] as const
export type PaymentStatusTab = (typeof PAYMENT_STATUS_TABS)[number]

export interface PaymentsQuery {
  status?: PaymentStatusTab
  search?: string
  method?: PaymentMethod | ''
  pg?: string
  staffId?: string
  dateFrom?: string // 결제일 범위(YYYY-MM-DD, 포함) — 현장 피드백. paid_at 없으면 created_at 기준
  dateTo?: string
  page: number
  pageSize: number
  sortId?: string
  sortDesc?: boolean
}

export interface PaymentsResult {
  rows: PaymentRow[]
  total: number
  pageCount: number
}

// 결제일 비교용 — paid_at(승인일) 우선, 없으면 created_at(등록일). 로컬 YYYY-MM-DD.
function paymentDateStr(p: PaymentRow): string {
  const d = new Date(p.paid_at ?? p.created_at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function matchFilters(p: PaymentRow, q: PaymentsQuery): boolean {
  if (q.status && q.status !== 'all' && p.status !== q.status) return false
  if (q.method && p.method !== q.method) return false
  if (q.pg && p.pg_provider !== q.pg) return false
  if (q.staffId && p.staff_id !== q.staffId) return false
  if (q.dateFrom || q.dateTo) {
    const d = paymentDateStr(p)
    if (q.dateFrom && d < q.dateFrom) return false
    if (q.dateTo && d > q.dateTo) return false
  }
  if (q.search) {
    const s = q.search.trim().toLowerCase()
    if (s) {
      const hay = [p.member?.name, p.member?.user_id, p.depositor_name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!hay.includes(s)) return false
    }
  }
  return true
}

export function usePayments(q: PaymentsQuery) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: paymentKeys.list({ ...q, uid: user?.id ?? 'anon', role: user?.role ?? 'none' }),
    queryFn: async (): Promise<PaymentsResult> => {
      const db =
        dataSource === 'supabase'
          ? await fetchTables(['members', 'products', 'payments'])
          : readDb()
      const members = indexBy(db.members)
      const products = indexBy(db.products)
      const scoped = scopePayments(db.payments, members, user)
      const rows = scoped.map((p) => enrich(p, members, products)).filter((p) => matchFilters(p, q))
      const sorted = q.sortId
        ? sortRows(rows, q.sortId, q.sortDesc ?? false)
        : sortRows(rows, 'created_at', true)
      const total = sorted.length
      const start = (q.page - 1) * q.pageSize
      return {
        rows: sorted.slice(start, start + q.pageSize),
        total,
        pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
      }
    },
    placeholderData: (prev) => prev,
  })
}

/** 상태 탭 건수(스코프 적용, 검색/기타필터 제외). */
export function usePaymentCounts() {
  const user = useCurrentUser()
  return useQuery({
    queryKey: paymentKeys.counts(`${user?.id ?? 'anon'}:${user?.role ?? 'none'}`),
    queryFn: async (): Promise<Record<PaymentStatusTab, number>> => {
      const db =
        dataSource === 'supabase' ? await fetchTables(['members', 'payments']) : readDb()
      const members = indexBy(db.members)
      const scoped = scopePayments(db.payments, members, user)
      const out: Record<PaymentStatusTab, number> = {
        all: scoped.length,
        wait: 0,
        approved: 0,
        failed: 0,
        cancelled: 0,
      }
      for (const p of scoped) out[p.status] += 1
      return out
    },
  })
}

export function usePayment(id: string | null) {
  return useQuery({
    queryKey: paymentKeys.detail(id ?? ''),
    queryFn: async (): Promise<PaymentRow | null> => {
      const db =
        dataSource === 'supabase'
          ? await fetchTables(['members', 'products', 'payments'])
          : readDb()
      const p = db.payments.find((x) => x.id === id)
      if (!p) return null
      return enrich(p, indexBy(db.members), indexBy(db.products))
    },
    enabled: !!id,
  })
}

// ── 뮤테이션 ──────────────────────────────────────────────────────────
function paymentLog(
  actor: string | null,
  action: string,
  paymentId: string,
  meta: Record<string, unknown> = {},
): LogEntry {
  return {
    id: genId('log'),
    kind: 'payment',
    actor,
    action,
    target_type: 'payment',
    target_id: paymentId,
    meta,
    created_at: nowIso(),
  }
}

/**
 * 결제 승인의 §8 부수효과를 회원에 반영(in-place):
 * 등급 상향 + 상태=정상 + 이용기간 설정. 매출은 승인 결제 합계로 자동 산출.
 */
function applyApproval(member: Member | undefined, product: Product | undefined, p: Payment): void {
  const ts = new Date()
  p.status = 'approved'
  p.paid_at = ts.toISOString()
  if (product) {
    p.period_start = ts.toISOString()
    p.period_end = addMonths(ts, product.duration_months).toISOString()
  }
  if (member && product) {
    member.grade = product.grade_granted
    member.status = 'active'
    member.is_suspended = false
    member.is_deleted = false
    member.is_withdrawn = false
  }
}

/** 결제 승인 (대기/실패 → 승인). §8: 회원 등급↑·정상화·매출 반영·로그. */
export function useApprovePayment() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string }) => {
      if (dataSource === 'supabase') return supa.approvePayment(v.id, user?.id ?? null)
      let memberId: string | null = null
      mutateDb((db) => {
        const p = db.payments.find((x) => x.id === v.id)
        if (!p || p.status === 'approved') return
        memberId = p.member_id
        const member = db.members.find((m) => m.id === p.member_id)
        const product = p.product_id
          ? db.products.find((pr) => pr.id === p.product_id)
          : undefined
        applyApproval(member, product, p)
        db.logs.push(
          paymentLog(user?.id ?? null, 'payment.approve', p.id, {
            member_id: p.member_id,
            amount: p.amount,
            product_id: p.product_id,
            grade: product?.grade_granted ?? null,
          }),
        )
      })
      return memberId
    },
    onSuccess: (memberId, v) => {
      qc.invalidateQueries({ queryKey: paymentKeys.all })
      qc.invalidateQueries({ queryKey: paymentKeys.detail(v.id) })
      qc.invalidateQueries({ queryKey: memberKeys.all })
      qc.invalidateQueries({ queryKey: revenueKeys.all })
      if (memberId) qc.invalidateQueries({ queryKey: memberKeys.detail(memberId) })
    },
  })
}

/** PG취소/환불 (승인/대기 → 취소). §8: 매출 차감(자동) + 등급 롤백 검토 + 로그. */
export function useCancelPayment() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string }) => {
      if (dataSource === 'supabase') return supa.cancelPayment(v.id, user?.id ?? null)
      let memberId: string | null = null
      mutateDb((db) => {
        const p = db.payments.find((x) => x.id === v.id)
        if (!p || p.status === 'cancelled') return
        memberId = p.member_id
        const wasApproved = p.status === 'approved'
        p.status = 'cancelled'
        // 등급 롤백 검토: 이 결제가 부여한 등급이고, 다른 승인 결제가 그 등급을
        // 더는 받쳐주지 않으면 무료로 되돌린다(매출 귀속/등급 정합).
        let rolledBack = false
        const member = db.members.find((m) => m.id === p.member_id)
        const product = p.product_id ? db.products.find((pr) => pr.id === p.product_id) : undefined
        if (wasApproved && member && product && member.grade === product.grade_granted) {
          const stillPaid = db.payments.some(
            (o) =>
              o.id !== p.id &&
              o.member_id === member.id &&
              o.status === 'approved' &&
              o.product_id != null,
          )
          if (!stillPaid) {
            member.grade = 'free'
            rolledBack = true
          }
        }
        db.logs.push(
          paymentLog(user?.id ?? null, 'payment.cancel', p.id, {
            member_id: p.member_id,
            amount: p.amount,
            was_approved: wasApproved,
            grade_rolled_back: rolledBack,
          }),
        )
      })
      return memberId
    },
    onSuccess: (memberId, v) => {
      qc.invalidateQueries({ queryKey: paymentKeys.all })
      qc.invalidateQueries({ queryKey: paymentKeys.detail(v.id) })
      qc.invalidateQueries({ queryKey: memberKeys.all })
      qc.invalidateQueries({ queryKey: revenueKeys.all })
      if (memberId) qc.invalidateQueries({ queryKey: memberKeys.detail(memberId) })
    },
  })
}

export interface UpdatePaymentInput {
  id: string
  patch: Partial<Pick<Payment, 'amount' | 'method' | 'pg_provider' | 'depositor_name'>>
}

/** 결제내역 수정(금액·결제수단·PG사·입금자명) — 실장 이상 전용(현장 피드백 7/21). UI 가드는 PaymentDrawer. */
export function useUpdatePayment() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: UpdatePaymentInput) => {
      if (dataSource === 'supabase') return supa.updatePayment(v.id, v.patch, user?.id ?? null)
      let memberId: string | null = null
      mutateDb((db) => {
        const p = db.payments.find((x) => x.id === v.id)
        if (!p) return
        memberId = p.member_id
        Object.assign(p, v.patch)
        db.logs.push(paymentLog(user?.id ?? null, 'payment.update', p.id, { member_id: p.member_id, patch: v.patch }))
      })
      return memberId
    },
    onSuccess: (memberId, v) => {
      qc.invalidateQueries({ queryKey: paymentKeys.all })
      qc.invalidateQueries({ queryKey: paymentKeys.detail(v.id) })
      qc.invalidateQueries({ queryKey: revenueKeys.all })
      if (memberId) qc.invalidateQueries({ queryKey: memberKeys.detail(memberId) })
    },
  })
}

// ── 수기결제 폼용 참조 데이터 (cross-feature import 회피: 스토어 직접 조회) ──
export function useActiveProducts() {
  return useQuery({
    queryKey: ['products', 'active'],
    queryFn: async () =>
      (dataSource === 'supabase' ? await fetchTables(['products']) : readDb()).products.filter(
        (p) => p.is_active,
      ),
  })
}

export interface MemberOption {
  id: string
  name: string
  user_id: string
  phone: string
  grade: Grade
}

/** 수기결제 대상 회원 검색(스코프 적용, 최대 20건). 빈 검색어면 앞에서부터 노출. */
export function useMemberSearch(term: string) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: ['payments', 'member-search', term, user?.id ?? 'anon', user?.role ?? 'none'],
    queryFn: async (): Promise<MemberOption[]> => {
      const db = dataSource === 'supabase' ? await fetchTables(['members']) : readDb()
      let scoped: Member[]
      if (!user) scoped = []
      else if (user.role === 'rep') scoped = db.members.filter((m) => m.assigned_staff_id === user.id)
      else scoped = [...db.members] // 최고관리자·관리자·실장 = 전체
      const s = term.trim().toLowerCase()
      const matched = s
        ? scoped.filter((m) =>
            [m.name, m.user_id, m.phone].filter(Boolean).join(' ').toLowerCase().includes(s),
          )
        : scoped
      return matched.slice(0, 20).map((m) => ({
        id: m.id,
        name: m.name,
        user_id: m.user_id,
        phone: m.phone,
        grade: m.grade,
      }))
    },
  })
}

export interface ManualPaymentInput {
  memberId: string
  productId: string
  amount: number
  method: PaymentMethod
  depositorName: string
  /** true 면 즉시 승인(§8 트리거), false 면 대기 상태로 등록. */
  approveNow: boolean
}

/** 수기결제 등록(/payments/manual). approveNow=true 면 승인 §8 흐름까지 즉시 적용. */
export function useCreateManualPayment() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: ManualPaymentInput) => {
      if (dataSource === 'supabase') return supa.createManualPayment(v, user?.id ?? null)
      const id = genId('pay')
      mutateDb((db) => {
        const member = db.members.find((m) => m.id === v.memberId)
        const product = db.products.find((pr) => pr.id === v.productId)
        const ts = nowIso()
        const p: Payment = {
          id,
          member_id: v.memberId,
          product_id: v.productId,
          amount: v.amount,
          method: v.method,
          pg_provider: null,
          status: 'wait',
          period_start: null,
          period_end: null,
          depositor_name: v.depositorName || (member?.name ?? null),
          // 매출 귀속은 "결제를 요청/등록한 담당자" 기준 — 회원의 현재 담당자가 아니라 이 결제를
          // 실제로 처리한 로그인 사용자를 우선한다(현장 피드백 7/21, D93 이전 로직은 반대였음).
          staff_id: user?.id ?? member?.assigned_staff_id ?? null,
          paid_at: null,
          created_at: ts,
        }
        if (v.approveNow) applyApproval(member, product, p)
        db.payments.push(p)
        db.logs.push(
          paymentLog(user?.id ?? null, 'payment.manual_create', id, {
            member_id: v.memberId,
            amount: v.amount,
            method: v.method,
            approved: v.approveNow,
          }),
        )
      })
      return v.memberId
    },
    onSuccess: (memberId) => {
      qc.invalidateQueries({ queryKey: paymentKeys.all })
      qc.invalidateQueries({ queryKey: memberKeys.all })
      qc.invalidateQueries({ queryKey: revenueKeys.all })
      if (memberId) qc.invalidateQueries({ queryKey: memberKeys.detail(memberId) })
    },
  })
}
