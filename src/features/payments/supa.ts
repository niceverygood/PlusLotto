// 결제 모듈 — supabase 쓰기 경로 (M7). dataSource==='supabase' 일 때 api.ts 의 뮤테이션이 호출.
// mock 의 mutateDb 부수효과(§8)를 supabase 호출로 1:1 미러링한다:
//   승인 → 결제상태=승인·이용기간·회원 등급↑/정상화·매출 반영(파생)·로그
//   취소 → 결제상태=취소·등급 롤백 검토(다른 승인결제 없으면 free)·매출 차감(파생)·로그
//   수기등록 → 대기 또는 즉시승인(§8 동일 흐름)
// 읽기는 fetchTables 스냅샷으로 api.ts 가 순수 변환을 재사용(별도 fetch 불필요).
// TODO(live-verify): 다중 테이블 갱신은 원자성 보장을 위해 RPC(트랜잭션)로 이관 권장.
import { addMonths } from 'date-fns'
import type { Grade, Member, Payment, Product } from '@/types/db'
import { genId, nowIso } from '@/lib/db/store'
import { insertLog, sb } from '@/lib/db/remote'
import type { ManualPaymentInput } from './api'

async function fetchPayment(id: string): Promise<Payment | null> {
  const { data, error } = await sb().from('payments').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as Payment | null) ?? null
}

async function fetchMember(id: string): Promise<Member | null> {
  const { data, error } = await sb().from('members').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as Member | null) ?? null
}

async function fetchProduct(id: string | null): Promise<Product | null> {
  if (!id) return null
  const { data, error } = await sb().from('products').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as Product | null) ?? null
}

/** 회원을 정상·해당 유료등급으로 갱신(승인 §8 부수효과). */
async function promoteMember(memberId: string, grade: Grade): Promise<void> {
  const { error } = await sb()
    .from('members')
    .update({ grade, status: 'active', is_suspended: false, is_deleted: false, is_withdrawn: false })
    .eq('id', memberId)
  if (error) throw error
}

/** 결제 승인 (대기/실패 → 승인). 반환=영향 회원 id(무효화 대상). */
export async function approvePayment(id: string, actor: string | null): Promise<string | null> {
  const p = await fetchPayment(id)
  if (!p || p.status === 'approved') return null
  const product = await fetchProduct(p.product_id)
  const ts = new Date()
  const upd: Partial<Payment> = { status: 'approved', paid_at: ts.toISOString() }
  if (product) {
    upd.period_start = ts.toISOString()
    upd.period_end = addMonths(ts, product.duration_months).toISOString()
  }
  const { error } = await sb().from('payments').update(upd).eq('id', id)
  if (error) throw error
  if (product) await promoteMember(p.member_id, product.grade_granted)
  await insertLog({
    kind: 'payment',
    actor,
    action: 'payment.approve',
    target_type: 'payment',
    target_id: id,
    meta: {
      member_id: p.member_id,
      amount: p.amount,
      product_id: p.product_id,
      grade: product?.grade_granted ?? null,
    },
  })
  return p.member_id
}

/** PG취소/환불 (승인/대기 → 취소). 승인이었고 다른 승인결제가 등급을 못 받치면 free 로 롤백. */
export async function cancelPayment(id: string, actor: string | null): Promise<string | null> {
  const p = await fetchPayment(id)
  if (!p || p.status === 'cancelled') return null
  const wasApproved = p.status === 'approved'
  const { error } = await sb().from('payments').update({ status: 'cancelled' }).eq('id', id)
  if (error) throw error
  let rolledBack = false
  if (wasApproved) {
    const member = await fetchMember(p.member_id)
    const product = await fetchProduct(p.product_id)
    if (member && product && member.grade === product.grade_granted) {
      const { data, error: qe } = await sb()
        .from('payments')
        .select('id')
        .eq('member_id', member.id)
        .eq('status', 'approved')
        .not('product_id', 'is', null)
        .neq('id', p.id)
        .limit(1)
      if (qe) throw qe
      if ((data ?? []).length === 0) {
        const { error: ue } = await sb().from('members').update({ grade: 'free' }).eq('id', member.id)
        if (ue) throw ue
        rolledBack = true
      }
    }
  }
  await insertLog({
    kind: 'payment',
    actor,
    action: 'payment.cancel',
    target_type: 'payment',
    target_id: id,
    meta: { member_id: p.member_id, amount: p.amount, was_approved: wasApproved, grade_rolled_back: rolledBack },
  })
  return p.member_id
}

/** 수기결제 등록. approveNow 면 승인 §8 흐름까지 즉시 적용. 반환=대상 회원 id. */
export async function createManualPayment(v: ManualPaymentInput, actor: string | null): Promise<string> {
  const id = genId('pay')
  const member = await fetchMember(v.memberId)
  const product = await fetchProduct(v.productId)
  const row: Payment = {
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
    staff_id: member?.assigned_staff_id ?? actor,
    paid_at: null,
    created_at: nowIso(),
  }
  if (v.approveNow) {
    const ts = new Date()
    row.status = 'approved'
    row.paid_at = ts.toISOString()
    if (product) {
      row.period_start = ts.toISOString()
      row.period_end = addMonths(ts, product.duration_months).toISOString()
    }
  }
  const { error } = await sb().from('payments').insert(row)
  if (error) throw error
  if (v.approveNow && product) await promoteMember(v.memberId, product.grade_granted)
  await insertLog({
    kind: 'payment',
    actor,
    action: 'payment.manual_create',
    target_type: 'payment',
    target_id: id,
    meta: { member_id: v.memberId, amount: v.amount, method: v.method, approved: v.approveNow },
  })
  return v.memberId
}
