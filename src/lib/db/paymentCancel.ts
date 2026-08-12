/**
 * 결제 취소(승인/대기 → 취소)의 단일 구현.
 *
 * 왜 lib 로 뺐나: 취소는 §8 부수효과가 붙은 위험 액션(등급 롤백·매출 차감·감사로그)인데,
 * 8/12 현장 요청("실장 이상급 권한으로 회원정보창에서 수기취소 버튼 추가")으로 결제 모듈 밖인
 * 회원정보창에서도 같은 동작이 필요해졌다. feature 간 직접 import 는 금지(CLAUDE §2)이고
 * 로직을 복사하면 등급 롤백 규칙이 두 벌이 되므로, 양쪽이 함께 쓰는 lib 로 옮긴다.
 *
 * 라이브(supabase)와 mock 두 경로를 같은 규칙으로 유지한다 — 어느 한쪽만 고치는 실수를 막으려
 * 두 구현을 이 파일에 나란히 둔다.
 */
import type { LogEntry, Member, Payment, Product } from '@/types/db'
import { insertLog, sb } from './remote'
import { genId, nowIso, type DbShape } from './store'

/** 취소 결과 — 호출부가 로그·무효화에 쓴다. memberId 가 null 이면 대상이 없거나 이미 취소된 건. */
export interface CancelPaymentResult {
  memberId: string | null
  wasApproved: boolean
  gradeRolledBack: boolean
}

const NOOP: CancelPaymentResult = { memberId: null, wasApproved: false, gradeRolledBack: false }

// ── 라이브(supabase) ──────────────────────────────────────────────────────
async function fetchOne<T>(table: string, id: string): Promise<T | null> {
  const { data, error } = await sb().from(table).select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as T | null) ?? null
}

/**
 * PG취소/환불. 승인이었고 다른 승인결제가 그 등급을 더는 받쳐주지 않으면 free 로 롤백한다.
 * 매출은 승인 결제에서 파생 집계라 상태 변경만으로 자동 차감된다.
 */
export async function cancelPaymentRemote(id: string, actor: string | null): Promise<CancelPaymentResult> {
  const p = await fetchOne<Payment>('payments', id)
  if (!p || p.status === 'cancelled') return NOOP
  const wasApproved = p.status === 'approved'
  const { error } = await sb().from('payments').update({ status: 'cancelled' }).eq('id', id)
  if (error) throw error

  let gradeRolledBack = false
  if (wasApproved) {
    const member = await fetchOne<Member>('members', p.member_id)
    const product = p.product_id ? await fetchOne<Product>('products', p.product_id) : null
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
        gradeRolledBack = true
      }
    }
  }

  await insertLog({
    kind: 'payment',
    actor,
    action: 'payment.cancel',
    target_type: 'payment',
    target_id: id,
    meta: { member_id: p.member_id, amount: p.amount, was_approved: wasApproved, grade_rolled_back: gradeRolledBack },
  })
  return { memberId: p.member_id, wasApproved, gradeRolledBack }
}

// ── mock ─────────────────────────────────────────────────────────────────
/** mutateDb 콜백 안에서 호출한다(자체적으로 mutateDb 를 열지 않는다). */
export function cancelPaymentInDb(db: DbShape, id: string, actor: string | null): CancelPaymentResult {
  const p = db.payments.find((x) => x.id === id)
  if (!p || p.status === 'cancelled') return NOOP
  const wasApproved = p.status === 'approved'
  p.status = 'cancelled'

  let gradeRolledBack = false
  const member = db.members.find((m) => m.id === p.member_id)
  const product = p.product_id ? db.products.find((pr) => pr.id === p.product_id) : undefined
  if (wasApproved && member && product && member.grade === product.grade_granted) {
    const stillPaid = db.payments.some(
      (o) => o.id !== p.id && o.member_id === member.id && o.status === 'approved' && o.product_id != null,
    )
    if (!stillPaid) {
      member.grade = 'free'
      gradeRolledBack = true
    }
  }

  const log: LogEntry = {
    id: genId('log'),
    kind: 'payment',
    actor,
    action: 'payment.cancel',
    target_type: 'payment',
    target_id: p.id,
    meta: { member_id: p.member_id, amount: p.amount, was_approved: wasApproved, grade_rolled_back: gradeRolledBack },
    created_at: nowIso(),
  }
  db.logs.push(log)
  return { memberId: p.member_id, wasApproved, gradeRolledBack }
}
