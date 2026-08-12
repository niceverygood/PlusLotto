// 결제 모듈 — supabase 쓰기 경로 (M7). dataSource==='supabase' 일 때 api.ts 의 뮤테이션이 호출.
// mock 의 mutateDb 부수효과(§8)를 supabase 호출로 1:1 미러링한다:
//   승인 → 결제상태=승인·이용기간·회원 등급↑/정상화·매출 반영(파생)·로그
//   취소 → 결제상태=취소·등급 롤백 검토(다른 승인결제 없으면 free)·매출 차감(파생)·로그
//   수기등록 → 대기 또는 즉시승인(§8 동일 흐름)
// 읽기는 서버 RPC가 회원·상품 조인과 필터·집계·페이지네이션을 처리한다.
// TODO(live-verify): 다중 테이블 갱신은 원자성 보장을 위해 RPC(트랜잭션)로 이관 권장.
import { addMonths } from 'date-fns'
import type { Grade, Member, Payment, Product, SiteSettings, SmsTemplate } from '@/types/db'
import { genId, nowIso } from '@/lib/db/store'
import { insertLog, insertWithOptionalColumns, sb } from '@/lib/db/remote'
import { cancelPaymentRemote } from '@/lib/db/paymentCancel'
import { renderSms } from '@/lib/sms'
import { sendOneShot } from '@/lib/oneshot'
import type {
  ManualPaymentInput,
  MemberOption,
  PaymentRow,
  PaymentsQuery,
  PaymentsResult,
  PaymentStatusTab,
} from './api'

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

/** 결제 목록은 회원·상품 조인과 필터·페이지네이션을 DB에서 끝낸다. */
export async function fetchPaymentsPage(q: PaymentsQuery): Promise<PaymentsResult> {
  const filter: Record<string, unknown> = {
    status: q.status,
    search: q.search,
    method: q.method,
    pg: q.pg,
    staffId: q.staffId,
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
  }
  // 빈 문자열을 JSON 키로 보내면 DB가 실제 등급값 ''로 해석해 전체 목록이 0건이 된다.
  if (q.grade) filter.grade = q.grade
  const { data, error } = await sb().rpc('admin_payments_page', {
    p_filter: filter,
    p_offset: Math.max(0, q.page - 1) * q.pageSize,
    p_limit: q.pageSize,
    p_sort_id: q.sortId ?? null,
    p_sort_desc: q.sortDesc ?? false,
  })
  if (error) throw error
  const result = data as { rows?: PaymentRow[]; total?: number } | null
  const total = Number(result?.total ?? 0)
  return {
    rows: await withMemberPhones(result?.rows ?? []),
    total,
    pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
  }
}

export async function fetchPaymentCounts(): Promise<Record<PaymentStatusTab, number>> {
  const { data, error } = await sb().rpc('admin_payment_counts')
  if (error) throw error
  const result = data as Partial<Record<PaymentStatusTab, number>> | null
  return {
    all: Number(result?.all ?? 0),
    wait: Number(result?.wait ?? 0),
    approved: Number(result?.approved ?? 0),
    failed: Number(result?.failed ?? 0),
    cancelled: Number(result?.cancelled ?? 0),
  }
}

export async function fetchPaymentDetail(id: string): Promise<PaymentRow | null> {
  const { data, error } = await sb().rpc('admin_payment_detail', { p_id: id })
  if (error) throw error
  const row = (data as PaymentRow | null) ?? null
  return row ? (await withMemberPhones([row]))[0] : null
}

/**
 * 결제행의 회원 전화번호 보강 (현장 8/4 요청 → 8/12 재요청 "유저이름 옆에 전화번호").
 *
 * 전화번호는 원래 `admin_payments_page` / `admin_payment_detail` RPC 가 member 객체에 함께
 * 내려주도록 마이그레이션(20260804120000)을 만들어 뒀는데, 그게 아직 라이브에 적용되지 않아
 * 현장 화면에서 휴대폰 칸이 전부 '-' 로 보였다. RPC 적용을 기다리는 대신 여기서 채운다.
 *
 * 판정은 `phone` 키의 **부재**(undefined)로 한다 — 마이그레이션이 적용되면 번호 없는 회원도
 * `phone: null` 로 내려오므로 이 보강 쿼리는 자동으로 멈춘다(적용 후 불필요한 왕복 없음).
 */
async function withMemberPhones(rows: PaymentRow[]): Promise<PaymentRow[]> {
  const missing = [...new Set(rows.filter((r) => r.member && r.member.phone === undefined).map((r) => r.member!.id))]
  if (missing.length === 0) return rows
  const { data, error } = await sb().from('members').select('id, phone').in('id', missing)
  if (error) throw error
  const phoneById = new Map((data ?? []).map((m) => [m.id as string, (m.phone as string | null) ?? null]))
  return rows.map((r) =>
    r.member && r.member.phone === undefined
      ? { ...r, member: { ...r.member, phone: phoneById.get(r.member.id) ?? null } }
      : r,
  )
}

export async function searchMembers(term: string): Promise<MemberOption[]> {
  const { data, error } = await sb().rpc('admin_member_search', { p_term: term, p_limit: 20 })
  if (error) throw error
  return (data as MemberOption[] | null) ?? []
}

/** 회원을 정상·해당 유료등급으로 갱신(승인 §8 부수효과). */
async function promoteMember(memberId: string, grade: Grade): Promise<void> {
  const { error } = await sb()
    .from('members')
    .update({ grade, status: 'active', is_suspended: false, is_deleted: false, is_withdrawn: false })
    .eq('id', memberId)
  if (error) throw error
}

/**
 * 가입환영문자 자동발송(현장 피드백 7/28, 정의현 차장) — "가입환영문자도 결제승인이 되면
 * 자동으로 나갈수 있도록". site_settings.join_sms_auto 가 켜져 있고, 이 결제가 이 회원의
 * *첫* 승인 결제일 때만 1회 발송한다(갱신결제엔 나가지 않음 — "환영" 문구 성격상).
 * approvePayment · createManualPayment(approveNow) 두 승인 경로에서만 호출한다
 * (updatePayment 의 상품변경 분기는 이미 승인된 결제의 플랜 변경이라 신규 승인이 아니므로 제외).
 */
async function maybeSendJoinSms(memberId: string, approvedPaymentId: string, actor: string | null): Promise<void> {
  const { data: setData } = await sb().from('site_settings').select('join_sms_auto, sms').eq('id', 1).maybeSingle()
  const settings = setData as Pick<SiteSettings, 'join_sms_auto' | 'sms'> | null
  if (!settings?.join_sms_auto) return

  // 이 결제 말고 이미 승인된 결제가 있으면 갱신결제 — 환영문자 대상 아님.
  const { data: prior, error: pe } = await sb()
    .from('payments')
    .select('id')
    .eq('member_id', memberId)
    .eq('status', 'approved')
    .neq('id', approvedPaymentId)
    .limit(1)
  if (pe) throw pe
  if ((prior ?? []).length > 0) return

  const member = await fetchMember(memberId)
  if (!member || !member.phone) return
  const { data: tplData } = await sb().from('sms_templates').select('*').eq('key', 'join').maybeSingle()
  const tpl = tplData as SmsTemplate | null
  if (!tpl || !tpl.body.trim()) return

  const body = renderSms(tpl.body, member)
  const realSend = !!settings.sms?.oneshot_enabled && !!settings.sms?.sender_no
  let status = '미발송'
  if (realSend) {
    const r = await sendOneShot({ dest_phone: member.phone, msg_body: body, send_phone: settings.sms.sender_no })
    status = r.ok ? '발송완료' : `실패(${r.code ?? '?'})`
  }
  const { error: se } = await sb().from('sms_sends').insert({
    id: genId('sms'),
    member_id: member.id,
    template_key: 'join',
    phone: member.phone,
    body,
    type: 'join',
    status,
    sent_at: nowIso(),
  })
  if (se) {
    console.warn('[join-sms] sms_sends insert 실패(발송내역 미기록):', se.message)
    return
  }
  await insertLog({
    kind: 'sms',
    actor,
    action: 'sms.join_auto',
    target_type: 'member',
    target_id: member.id,
    meta: { payment_id: approvedPaymentId, real: realSend },
  })
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
  // best-effort — 문자 발송 실패로 결제 승인 자체가 실패 처리되면 안 된다.
  try {
    await maybeSendJoinSms(p.member_id, id, actor)
  } catch (e) {
    console.warn('[join-sms] 자동발송 실패:', e instanceof Error ? e.message : e)
  }
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

/**
 * PG취소/환불 (승인/대기 → 취소). 승인이었고 다른 승인결제가 등급을 못 받치면 free 로 롤백.
 * 구현은 `lib/db/paymentCancel` 하나로 모았다 — 회원정보창의 수기취소(현장 8/12)와 같은 동작이라
 * 등급 롤백 규칙이 두 벌이 되지 않게 한다.
 */
export async function cancelPayment(id: string, actor: string | null): Promise<string | null> {
  const { memberId } = await cancelPaymentRemote(id, actor)
  return memberId
}

/** 결제내역 수정(금액·결제수단·PG사·입금자명) — 실장 이상 전용(현장 피드백 7/21). 반환=대상 회원 id. */
/** 결제내역 수정(§V2 확장 7/23: 등급(상품)·담당자·결제일시 포함). 승인된 결제의 상품을 바꾸면
 *  approvePayment 와 동일하게 회원 등급·이용기간을 다시 반영한다. */
export async function updatePayment(
  id: string,
  patch: Partial<
    Pick<Payment, 'amount' | 'method' | 'pg_provider' | 'depositor_name' | 'product_id' | 'staff_id' | 'paid_at'>
  >,
  actor: string | null,
): Promise<string | null> {
  const p = await fetchPayment(id)
  if (!p) return null
  const { error } = await sb().from('payments').update(patch).eq('id', id)
  if (error) throw error
  if (p.status === 'approved' && patch.product_id !== undefined && patch.product_id !== p.product_id) {
    const product = await fetchProduct(patch.product_id)
    if (product) {
      await promoteMember(p.member_id, product.grade_granted)
      if (p.paid_at) {
        const ts = new Date(p.paid_at)
        const { error: pe } = await sb()
          .from('payments')
          .update({ period_start: ts.toISOString(), period_end: addMonths(ts, product.duration_months).toISOString() })
          .eq('id', id)
        if (pe) throw pe
      }
    }
  }
  await insertLog({
    kind: 'payment',
    actor,
    action: 'payment.update',
    target_type: 'payment',
    target_id: id,
    meta: { member_id: p.member_id, patch },
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
    round_label: v.roundLabel ?? null,
    // 매출 귀속은 "결제를 요청/등록한 담당자" 기준(현장 피드백 7/21) — 회원의 현재 담당자보다 우선.
    staff_id: actor ?? member?.assigned_staff_id ?? null,
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
  // round_label 은 마이그레이션 미적용 가능성이 있어 optional(현장 8/11 결제요청 중단 사고와 동일 이유).
  await insertWithOptionalColumns('payments', row as unknown as Record<string, unknown>, ['round_label'])
  if (v.approveNow && product) await promoteMember(v.memberId, product.grade_granted)
  if (v.approveNow) {
    try {
      await maybeSendJoinSms(v.memberId, id, actor)
    } catch (e) {
      console.warn('[join-sms] 자동발송 실패:', e instanceof Error ? e.message : e)
    }
  }
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
