// 이용자 모듈 — supabase 데이터 경로 (M6). dataSource==='supabase' 일 때 api.ts 가 호출.
// 설계: 읽기는 RLS 가 역할 스코프를 처리하고 목록/뷰/검색/정렬/페이지는 서버 RPC에서 끝낸다.
//       쓰기는 mock 의 mutateDb 부수효과(§8)를 supabase 호출로 1:1 미러링한다.
import { type SupabaseClient } from '@supabase/supabase-js'
import type { Assignment, CallAiAnalysis, CallRecording, LottoRound, Member, MemberStatus, Payment, Product, SiteSettings, SmsSend, SmsTemplate, WeeklyRecoIssue } from '@/types/db'
import { supabase } from '@/lib/supabase'
import { genId, nowIso } from '@/lib/db/store'
import { recoSmsBody, renderSms, smsTypeForTemplate } from '@/lib/sms'
import { sendOneShot } from '@/lib/oneshot'
import { fetchSiteSettings, ID_IN_CHUNK, paginateAll, selectAll, selectByIds, updateByIds } from '@/lib/db/remote'
import { mapPool } from '@/lib/async'

// 단체문자 동시 발송 한도(브라우저). 너무 높이면 Fixie 동시연결·OneShot 레이트리밋 위험 → 보수적 6
// (크론 weekly-reco 는 server-side CONC=12). 1000건 기준 순차 대비 체감 ~6배 단축.
const SMS_SEND_CONC = 6
import { resolveExcludeForGrade } from '@/lib/lotto'
import { membershipTermsUrl } from '@/lib/membership'
import { generateIssueSets } from '@/lib/lottoGenerator'
import type { ManualIssueInput, MemberCreateInput, MemberPatch, MySmsRow } from './api'
import type { MemberFilter } from './views'

function sb(): SupabaseClient {
  if (!supabase) throw new Error('supabase 클라이언트가 초기화되지 않았습니다.')
  return supabase
}

// 상태 변경 시 파생 불리언 플래그(스키마 컬럼)를 함께 갱신.
function statusFlags(status: MemberStatus | undefined): Record<string, unknown> {
  if (!status) return {}
  return {
    is_suspended: status === 'suspended',
    is_deleted: status === 'deleted',
    is_withdrawn: status === 'withdrawn',
  }
}

async function pushLog(row: {
  kind: 'admin' | 'sms'
  actor: string | null
  action: string
  target_type?: string | null
  target_id?: string | null
  meta?: Record<string, unknown>
}): Promise<void> {
  const { error } = await sb()
    .from('logs')
    .insert({
      id: genId('log'),
      kind: row.kind,
      actor: row.actor,
      action: row.action,
      target_type: row.target_type ?? null,
      target_id: row.target_id ?? null,
      meta: row.meta ?? {},
      created_at: nowIso(),
    })
  // 감사 로그는 best-effort — 실패해도 실제 작업(발송·결제 등)을 막지 않는다.
  if (error) console.warn('pushLog 실패(무시):', error.message)
}

// ── 읽기 ──────────────────────────────────────────────────────────────────
export interface RemoteMembersResult {
  rows: Member[]
  total: number
  pageCount: number
}

export interface RemoteMemberFacets {
  counts: Record<string, number>
  inflowCodes: string[]
}

/** 회원 목록은 DB에서 필터·정렬·페이지를 끝낸 뒤 현재 페이지 행만 받는다. */
export async function fetchMembersPage(
  filter: MemberFilter,
  page: number,
  pageSize: number,
  sortId: string | undefined,
  sortDesc: boolean,
  assignedStaffId: string | null = null,
): Promise<RemoteMembersResult> {
  const { data, error } = await sb().rpc('admin_members_page', {
    p_filter: filter,
    p_offset: Math.max(0, page - 1) * pageSize,
    p_limit: pageSize,
    p_sort_id: sortId ?? null,
    p_sort_desc: sortDesc,
    p_assigned_staff_id: assignedStaffId,
  })
  if (error) throw error
  const result = data as { rows?: Member[]; total?: number } | null
  const total = Number(result?.total ?? 0)
  return {
    rows: result?.rows ?? [],
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  }
}

/** 26개 세그먼트 건수와 유입코드 distinct를 한 번의 서버 집계로 가져온다. */
export async function fetchMemberFacets(assignedStaffId: string | null = null): Promise<RemoteMemberFacets> {
  const { data, error } = await sb().rpc('admin_member_facets', {
    p_assigned_staff_id: assignedStaffId,
  })
  if (error) throw error
  const result = data as { counts?: Record<string, number>; inflowCodes?: string[] } | null
  return { counts: result?.counts ?? {}, inflowCodes: result?.inflowCodes ?? [] }
}

export async function fetchMember(id: string): Promise<Member | null> {
  const { data, error } = await sb().from('members').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return (data as Member | null) ?? null
}

export async function fetchMemberPayments(id: string): Promise<Payment[]> {
  const { data, error } = await sb().from('payments').select('*').eq('member_id', id)
  if (error) throw error
  return (data ?? []) as Payment[]
}

export async function fetchMemberSms(id: string): Promise<SmsSend[]> {
  const { data, error } = await sb().from('sms_sends').select('*').eq('member_id', id)
  if (error) throw error
  return (data ?? []) as SmsSend[]
}

export async function fetchMemberAssignments(id: string): Promise<Assignment[]> {
  const { data, error } = await sb().from('assignments').select('*').eq('member_id', id)
  if (error) throw error
  return (data ?? []) as Assignment[]
}

export async function fetchSmsTemplates(): Promise<SmsTemplate[]> {
  const { data, error } = await sb().from('sms_templates').select('*')
  if (error) throw error
  return (data ?? []) as SmsTemplate[]
}

export async function fetchProducts(): Promise<Product[]> {
  const { data, error } = await sb().from('products').select('*')
  if (error) throw error
  return (data ?? []) as Product[]
}

/** 내 담당 회원에게 발송된 문자 내역(최신순). */
export async function fetchMineSmsLog(uid: string, limit: number): Promise<MySmsRow[]> {
  if (!uid) return []
  const { data: mem, error: me } = await sb().from('members').select('id, name').eq('assigned_staff_id', uid)
  if (me) throw me
  const nameById = new Map((mem ?? []).map((m) => [(m as { id: string }).id, (m as { name: string }).name]))
  const ids = [...nameById.keys()]
  if (ids.length === 0) return []
  // id 청크별 조회(URL 414 회피 — 담당 회원 300+ 명인 rep) 후 병합·정렬·상위 limit.
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += ID_IN_CHUNK) chunks.push(ids.slice(i, i + ID_IN_CHUNK))
  const parts = await Promise.all(
    chunks.map((c) =>
      sb().from('sms_sends').select('*').in('member_id', c).order('sent_at', { ascending: false }).limit(limit),
    ),
  )
  const merged: SmsSend[] = []
  for (const p of parts) {
    if (p.error) throw p.error
    merged.push(...((p.data ?? []) as SmsSend[]))
  }
  const sms = merged.sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? '')).slice(0, limit)
  return sms.map((s) => ({
    id: s.id,
    member_id: s.member_id,
    member_name: nameById.get(s.member_id) ?? s.member_id,
    phone: s.phone,
    body: s.body,
    type: s.type,
    status: s.status,
    sent_at: s.sent_at,
  }))
}

// ── 쓰기 (§8 미러링) ───────────────────────────────────────────────────────
/** 회원 단건 등록(§V2-2) — mock useCreateMember 의 supabase 미러. 전화 중복 허용(meta.dup_phone). */
export async function createMember(input: MemberCreateInput, actor: string | null): Promise<string> {
  const id = genId('m')
  const digits = (s: string) => s.replace(/\D/g, '')
  // 중복검사·user_id 채번은 전체 회원 대상 — 1000행 캡에 걸리면 캡 너머 회원과 중복을 못 잡아
  // 실데이터(15만) 임포트 시 중복이 그대로 들어간다. range 로 전량 조회(D69).
  const existing = await paginateAll<{ phone: string; user_id: string }>((from, to) =>
    sb().from('members').select('phone, user_id').range(from, to),
  )
  const rows = (existing ?? []) as { phone: string; user_id: string }[]
  const phone = digits(input.phone)
  const dup = phone.length > 0 && rows.some((m) => digits(m.phone) === phone)
  const maxNum = rows.reduce((mx, m) => {
    const mm = /^pl(\d+)$/.exec(m.user_id ?? '')
    return mm ? Math.max(mx, parseInt(mm[1], 10)) : mx
  }, 1000)
  let staff: { id: string; team_id: string | null } | null = null
  if (input.assigned_staff_id) {
    const { data } = await sb()
      .from('staff')
      .select('id, team_id')
      .eq('id', input.assigned_staff_id)
      .maybeSingle()
    staff = (data as { id: string; team_id: string | null } | null) ?? null
  }
  const row: Member = {
    id,
    user_id: input.user_id?.trim() || `pl${maxNum + 1}`,
    name: input.name.trim(),
    nickname: input.nickname?.trim() || null,
    phone: input.phone.trim(),
    grade: input.grade ?? 'free',
    status: 'active',
    tendency: input.tendency?.trim() || null,
    consult_status: input.consult_status?.trim() || '신규',
    inflow_code: input.inflow_code?.trim() || null,
    inflow_type: input.inflow_type?.trim() || null,
    assigned_staff_id: staff?.id ?? null,
    team_id: staff?.team_id ?? null,
    memo: input.memo?.trim() || null,
    win_history: null,
    outcall_done: false,
    registered_at: nowIso(),
    last_active_at: null,
    is_suspended: false,
    is_deleted: false,
    is_withdrawn: false,
    meta: {
      ...(dup ? { dup_phone: true } : {}),
      ...(input.age_band ? { age_band: input.age_band } : {}),
      ...(input.gender ? { gender: input.gender } : {}),
    },
  }
  const { error } = await sb().from('members').insert(row)
  if (error) throw error
  if (staff) {
    await sb().from('assignments').insert({
      id: genId('as'),
      member_id: id,
      staff_id: staff.id,
      assigned_by: actor,
      type: 'manual',
      created_at: nowIso(),
    })
  }
  await pushLog({
    kind: 'admin',
    actor,
    action: 'member.create',
    target_type: 'member',
    target_id: id,
    meta: { name: row.name, dup },
  })
  return id
}

/** 일괄 임포트(§V2-3) — mock useBulkImportMembers 의 supabase 미러. 청크 분할 insert. */
export async function bulkImportMembers(
  inputs: MemberCreateInput[],
  actor: string | null,
): Promise<{ created: number; dup: number }> {
  const digits = (s: string) => s.replace(/\D/g, '')
  // 중복검사·user_id 채번은 전체 회원 대상 — 1000행 캡에 걸리면 캡 너머 회원과 중복을 못 잡아
  // 실데이터(15만) 임포트 시 중복이 그대로 들어간다. range 로 전량 조회(D69).
  const existing = await paginateAll<{ phone: string; user_id: string }>((from, to) =>
    sb().from('members').select('phone, user_id').range(from, to),
  )
  const rows = (existing ?? []) as { phone: string; user_id: string }[]
  const phones = new Set(rows.map((m) => digits(m.phone)).filter(Boolean))
  let seq = rows.reduce((mx, m) => {
    const mm = /^pl(\d+)$/.exec(m.user_id ?? '')
    return mm ? Math.max(mx, parseInt(mm[1], 10)) : mx
  }, 1000)
  const staffIds = [...new Set(inputs.map((i) => i.assigned_staff_id).filter(Boolean) as string[])]
  const staffTeam = new Map<string, string | null>()
  if (staffIds.length) {
    const { data } = await sb().from('staff').select('id, team_id').in('id', staffIds)
    for (const s of (data ?? []) as { id: string; team_id: string | null }[]) staffTeam.set(s.id, s.team_id)
  }
  const memberRows: Member[] = []
  const assignmentRows: Record<string, unknown>[] = []
  let dup = 0
  const ts = nowIso()
  for (const input of inputs) {
    const phone = digits(input.phone)
    const isDup = phone.length > 0 && phones.has(phone)
    if (isDup) dup++
    if (phone) phones.add(phone)
    seq++
    const id = genId('m')
    const sid = input.assigned_staff_id ?? null
    const team = sid ? (staffTeam.get(sid) ?? null) : null
    memberRows.push({
      id,
      user_id: input.user_id?.trim() || `pl${seq}`,
      name: input.name.trim(),
      nickname: input.nickname?.trim() || null,
      phone: input.phone.trim(),
      grade: input.grade ?? 'free',
      status: 'active',
      tendency: input.tendency?.trim() || null,
      consult_status: input.consult_status?.trim() || '신규',
      inflow_code: input.inflow_code?.trim() || null,
      inflow_type: input.inflow_type?.trim() || null,
      assigned_staff_id: sid,
      team_id: team,
      memo: input.memo?.trim() || null,
      win_history: null,
      outcall_done: false,
      registered_at: ts,
      last_active_at: null,
      is_suspended: false,
      is_deleted: false,
      is_withdrawn: false,
      meta: { imported: true, ...(isDup ? { dup_phone: true } : {}) },
    })
    if (sid) {
      assignmentRows.push({
        id: genId('as'),
        member_id: id,
        staff_id: sid,
        assigned_by: actor,
        type: 'manual',
        created_at: ts,
      })
    }
  }
  const CHUNK = 500
  for (let i = 0; i < memberRows.length; i += CHUNK) {
    const { error } = await sb().from('members').insert(memberRows.slice(i, i + CHUNK))
    if (error) throw error
  }
  for (let i = 0; i < assignmentRows.length; i += CHUNK) {
    const { error } = await sb().from('assignments').insert(assignmentRows.slice(i, i + CHUNK))
    if (error) throw error
  }
  await pushLog({
    kind: 'admin',
    actor,
    action: 'member.bulk_import',
    target_type: 'member',
    target_id: null,
    meta: { count: memberRows.length, dup },
  })
  return { created: memberRows.length, dup }
}

export async function updateMember(id: string, patch: MemberPatch, actor: string | null): Promise<void> {
  const { data: cur } = await sb().from('members').select('grade, status').eq('id', id).maybeSingle()
  const before = cur ? { grade: (cur as Member).grade, status: (cur as Member).status } : {}
  const { error } = await sb()
    .from('members')
    .update({ ...patch, ...statusFlags(patch.status) })
    .eq('id', id)
  if (error) throw error
  await pushLog({ kind: 'admin', actor, action: 'member.update', target_type: 'member', target_id: id, meta: { patch, before } })
}

/** 콜메모 1건 append(리스트형). meta.memos 에 누적하고 members.memo(최신)를 동기화. */
export async function addMemo(id: string, body: string, actor: string | null): Promise<void> {
  const { data: cur } = await sb().from('members').select('meta').eq('id', id).maybeSingle()
  const meta = ((cur as { meta: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>
  const list = Array.isArray(meta.memos) ? (meta.memos as unknown[]) : []
  const entry = { id: genId('memo'), body, author: actor, created_at: nowIso() }
  const nextMeta = { ...meta, memos: [...list, entry] }
  const { error } = await sb().from('members').update({ meta: nextMeta, memo: body }).eq('id', id)
  if (error) throw error
  await pushLog({ kind: 'admin', actor, action: 'member.memo_add', target_type: 'member', target_id: id, meta: { body } })
}

/** 민원 1건 append(리스트형, 현장 피드백 7/6). meta.complaints 에 누적. */
export async function addComplaint(
  id: string,
  body: string,
  type: string,
  result: string,
  actor: string | null,
): Promise<void> {
  const { data: cur } = await sb().from('members').select('meta').eq('id', id).maybeSingle()
  const meta = ((cur as { meta: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>
  const list = Array.isArray(meta.complaints) ? (meta.complaints as unknown[]) : []
  const entry = { id: genId('cmpl'), created_at: nowIso(), author: actor, body, type, result }
  const { error } = await sb().from('members').update({ meta: { ...meta, complaints: [...list, entry] } }).eq('id', id)
  if (error) throw error
  await pushLog({
    kind: 'admin',
    actor,
    action: 'member.complaint_add',
    target_type: 'member',
    target_id: id,
    meta: { type, result },
  })
}

/** 회원 meta 설정(조합발송요일/갯수/홈페이지 비번 등) 병합 갱신. */
export async function updateMemberMeta(
  id: string,
  patch: Record<string, unknown>,
  actor: string | null,
): Promise<void> {
  const { data: cur } = await sb().from('members').select('meta').eq('id', id).maybeSingle()
  const meta = ((cur as { meta: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>
  const next = { ...meta }
  for (const [k, val] of Object.entries(patch)) {
    if (val === null || val === undefined || val === '') delete next[k]
    else next[k] = val
  }
  const { error } = await sb().from('members').update({ meta: next }).eq('id', id)
  if (error) throw error
  await pushLog({ kind: 'admin', actor, action: 'member.settings_update', target_type: 'member', target_id: id, meta: { patch } })
}

/** 선택 회원 meta(발송요일/갯수 등) 일괄 병합 갱신(§자동조합 일괄). jsonb 병합이라 회원별 개별 update. */
export async function bulkUpdateMemberMeta(
  ids: string[],
  patch: Record<string, unknown>,
  actor: string | null,
): Promise<void> {
  // id 목록을 청크로 나눠 조회(URL 414 회피 — 300+ 건이면 단일 .in() 가 거절됨).
  const rows = await selectByIds<{ id: string; meta: Record<string, unknown> | null }>(
    'members',
    'id, meta',
    ids,
  )
  // 25건씩 병렬 — 100건 기준 round-trip 체감 최소화.
  const CHUNK = 25
  for (let i = 0; i < rows.length; i += CHUNK) {
    await Promise.all(
      rows.slice(i, i + CHUNK).map((r) => {
        const next = { ...(r.meta ?? {}) }
        for (const [k, val] of Object.entries(patch)) {
          if (val === null || val === undefined || val === '') delete next[k]
          else next[k] = val
        }
        return sb()
          .from('members')
          .update({ meta: next })
          .eq('id', r.id)
          .then(({ error }) => {
            if (error) throw error
          })
      }),
    )
  }
  await pushLog({ kind: 'admin', actor, action: 'member.bulk_settings_update', target_type: 'member', target_id: null, meta: { count: rows.length, patch } })
}

/** 결제 요청 → 대기(wait) 결제 1건 생성. */
export async function requestPayment(
  v: { memberId: string; productId: string; amount: number; method: string; depositorName?: string | null },
  actor: string | null,
): Promise<void> {
  const { data: m } = await sb().from('members').select('name, assigned_staff_id').eq('id', v.memberId).maybeSingle()
  const member = m as { name: string; assigned_staff_id: string | null } | null
  const { error } = await sb().from('payments').insert({
    id: genId('pay'),
    member_id: v.memberId,
    product_id: v.productId,
    amount: v.amount,
    method: v.method,
    pg_provider: null,
    status: 'wait',
    period_start: null,
    period_end: null,
    depositor_name: v.depositorName?.trim() || member?.name || null,
    // 매출 귀속은 "결제를 요청/등록한 담당자" 기준(현장 피드백 7/21) — payments/supa.ts 와 동일 원칙.
    staff_id: actor ?? member?.assigned_staff_id ?? null,
    paid_at: null,
    created_at: nowIso(),
  })
  if (error) throw error
  await pushLog({ kind: 'admin', actor, action: 'payment.request', target_type: 'member', target_id: v.memberId, meta: { product_id: v.productId, amount: v.amount, method: v.method } })
}

/** 결제건별 담당자 배정 변경(현장 피드백 7/6) — 1차/2차/3차결제마다 다른 담당자를 붙일 수 있게.
 *  매출 귀속은 이미 payment.staff_id 기준(REVENUE_RULES.attribution='payment_staff')이라 이 값만 바꾸면 된다. */
export async function updatePaymentStaff(paymentId: string, staffId: string | null, actor: string | null): Promise<void> {
  const { error } = await sb().from('payments').update({ staff_id: staffId }).eq('id', paymentId)
  if (error) throw error
  await pushLog({ kind: 'admin', actor, action: 'payment.staff_update', target_type: 'payment', target_id: paymentId, meta: { staff_id: staffId } })
}

/** 콜메모 소프트삭제(<회원정보창> 7) — deleted_at 마킹, member.memo=미삭제 최신으로 동기화. */
export async function deleteMemo(id: string, memoId: string, actor: string | null): Promise<void> {
  const { data: cur } = await sb().from('members').select('meta').eq('id', id).maybeSingle()
  const meta = ((cur as { meta: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>
  const list = (Array.isArray(meta.memos) ? (meta.memos as { id: string; body: string; deleted_at?: string | null }[]) : []).map(
    (e) => (e.id === memoId ? { ...e, deleted_at: nowIso(), deleted_by: actor } : e),
  )
  const latest = [...list].reverse().find((e) => !e.deleted_at)?.body ?? null
  const { error } = await sb().from('members').update({ meta: { ...meta, memos: list }, memo: latest }).eq('id', id)
  if (error) throw error
  await pushLog({ kind: 'admin', actor, action: 'member.memo_delete', target_type: 'member', target_id: id, meta: { memo_id: memoId } })
}

// ── 통화 녹음(현장 피드백 7/3, 김형준 이사) — meta.call_recordings 에 리스트로 적재 ──────
// 1단계: 상담원 수동 업로드(Storage 버킷 call-recordings). PBX/통신사 자동연동은 정보 확보 후 별도 추가.
async function patchCallRecordings(
  id: string,
  fn: (list: CallRecording[]) => CallRecording[],
): Promise<void> {
  const { data: cur } = await sb().from('members').select('meta').eq('id', id).maybeSingle()
  const meta = ((cur as { meta: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>
  const list = Array.isArray(meta.call_recordings) ? (meta.call_recordings as CallRecording[]) : []
  const { error } = await sb()
    .from('members')
    .update({ meta: { ...meta, call_recordings: fn(list) } })
    .eq('id', id)
  if (error) throw error
}

/** 녹음 파일을 Storage(call-recordings)에 업로드하고 member.meta.call_recordings 에 append. */
export async function uploadCallRecording(id: string, file: File, actor: string | null): Promise<CallRecording> {
  const entry: CallRecording = {
    id: genId('rec'),
    created_at: nowIso(),
    uploaded_by: actor,
    file_path: `${id}/${genId('rec')}_${file.name}`,
    file_name: file.name,
  }
  const { error: upErr } = await sb().storage.from('call-recordings').upload(entry.file_path, file)
  if (upErr) throw upErr
  await patchCallRecordings(id, (list) => [entry, ...list])
  await pushLog({
    kind: 'admin',
    actor,
    action: 'member.call_recording_upload',
    target_type: 'member',
    target_id: id,
    meta: { file_name: file.name },
  })
  return entry
}

/** 녹음 재생용 서명 URL(비공개 버킷이라 매번 발급, 1시간 유효). */
export async function signCallRecordingUrl(filePath: string): Promise<string> {
  const { data, error } = await sb().storage.from('call-recordings').createSignedUrl(filePath, 3600)
  if (error) throw error
  return data.signedUrl
}

/** 녹음 삭제(파일 + meta 항목). */
export async function deleteCallRecording(id: string, recId: string, filePath: string, actor: string | null): Promise<void> {
  await sb().storage.from('call-recordings').remove([filePath])
  await patchCallRecordings(id, (list) => list.filter((r) => r.id !== recId))
  await pushLog({
    kind: 'admin',
    actor,
    action: 'member.call_recording_delete',
    target_type: 'member',
    target_id: id,
    meta: { rec_id: recId },
  })
}

/** STT 전사 결과 + 키워드 탐지 결과를 해당 녹음 항목에 반영. */
export async function saveCallRecordingTranscript(
  id: string,
  recId: string,
  transcript: string,
  keywordHits: { keyword: string; count: number }[],
): Promise<void> {
  await patchCallRecordings(id, (list) =>
    list.map((r) => (r.id === recId ? { ...r, transcript, transcribed_at: nowIso(), keyword_hits: keywordHits } : r)),
  )
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** STT 전사(/api/transcribe-call, OpenAI) 호출 → 전사본 + 키워드(설정>사이트 설정) 탐지 결과 저장. */
export async function transcribeCallRecording(
  id: string,
  recId: string,
  filePath: string,
): Promise<{ transcript: string; keywordHits: { keyword: string; count: number }[] }> {
  const { data } = await sb().auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.')
  const [r, settings] = await Promise.all([
    fetch('/api/transcribe-call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ file_path: filePath }),
    }),
    fetchSiteSettings(),
  ])
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; transcript?: string; message?: string }
  if (!r.ok || !j.ok || typeof j.transcript !== 'string') throw new Error(j.message ?? '전사에 실패했습니다.')
  const keywords = settings.call_keywords ?? ['보장']
  const keywordHits = keywords
    .map((k) => ({ keyword: k, count: (j.transcript!.match(new RegExp(escapeRegExp(k), 'g')) ?? []).length }))
    .filter((h) => h.count > 0)
  await saveCallRecordingTranscript(id, recId, j.transcript, keywordHits)
  return { transcript: j.transcript, keywordHits }
}

/** AI 통화분석(/api/analyze-call, OpenAI) 호출 → 성공/실패요인·스크립트유사성·요약 저장(현장 7/10). */
export async function analyzeCallRecording(
  id: string,
  recId: string,
  transcript: string,
): Promise<CallAiAnalysis> {
  const { data } = await sb().auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.')
  const settings = await fetchSiteSettings()
  const r = await fetch('/api/analyze-call', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ transcript, script: settings.call_script ?? '' }),
  })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; analysis?: CallAiAnalysis; message?: string }
  if (!r.ok || !j.ok || !j.analysis) throw new Error(j.message ?? 'AI 분석에 실패했습니다.')
  await patchCallRecordings(id, (list) =>
    list.map((rec) => (rec.id === recId ? { ...rec, ai_analysis: j.analysis, analyzed_at: nowIso() } : rec)),
  )
  return j.analysis
}

export async function bulkUpdateMembers(
  ids: string[],
  patch: MemberPatch & { inflow_type?: string },
  actor: string | null,
): Promise<void> {
  await updateByIds('members', { ...patch, ...statusFlags(patch.status) }, ids)
  await pushLog({ kind: 'admin', actor, action: 'member.bulk_update', meta: { count: ids.length, ids, patch } })
}

// 배정 3종(수동배정·자동할당·리셋) 은 "회원 갱신 + assignments 감사로그" 를 함께 남겨야
// 관리자 화면·자동할당 모달의 '금일 배분디비' 집계(assignments 기준)가 실제 배정과 어긋나지 않는다
// (현장 피드백 "자동/수동배분 갯수처리 오류"). 로그 insert 를 회원 update 보다 먼저 실행 —
// 로그 기록이 실패하면 회원도 바뀌지 않아 "배정은 됐는데 로그가 없는" 유령 상태를 만들지 않는다.
export async function assignStaff(ids: string[], staffId: string, actor: string | null): Promise<void> {
  const { data: st } = await sb().from('staff').select('team_id').eq('id', staffId).maybeSingle()
  const teamId = (st as { team_id: string | null } | null)?.team_id ?? null
  const ts = nowIso()
  const rows = ids.map((mid) => ({
    id: genId('as'),
    member_id: mid,
    staff_id: staffId,
    assigned_by: actor,
    type: 'manual' as const,
    created_at: ts,
  }))
  // 로그(assignments) 를 먼저 남기고 회원 정보를 나중에 바꾼다(현장 피드백 7/22) — 순서가 반대면
  // members UPDATE 는 성공했는데 assignments INSERT 가 실패할 때 "실제로는 배정됐는데 금일 디비
  // 집계에서 누락"되는 불일치가 생긴다. 이 순서로는 최악의 경우도 "기록은 됐는데 반영 전" 상태라 안전.
  const { error: e2 } = await sb().from('assignments').insert(rows)
  if (e2) throw e2
  await updateByIds('members', { assigned_staff_id: staffId, team_id: teamId }, ids)
  await pushLog({ kind: 'admin', actor, action: 'member.assign', meta: { count: ids.length, staff_id: staffId } })
}

export async function autoAssign(
  ids: string[],
  staffIds: string[] | null,
  actor: string | null,
): Promise<void> {
  // 풀: 실행 시 지정 staffIds 우선, 없으면 '자동배분 대상' 플래그 rep(§V2-1). id 순 정렬로 라운드로빈 결정성 확보.
  let q = sb().from('staff').select('id, team_id')
  q =
    staffIds && staffIds.length > 0
      ? q.in('id', staffIds)
      : q.eq('role', 'rep').eq('is_active', true).eq('auto_assign_enabled', true)
  const { data: repData, error: re } = await q.order('id')
  if (re) throw re
  const reps = (repData ?? []) as { id: string; team_id: string | null }[]
  if (reps.length === 0) return
  const ts = nowIso()
  const repOf = ids.map((_, i) => reps[i % reps.length])
  const asg = ids.map((mid, i) => ({
    id: genId('as'),
    member_id: mid,
    staff_id: repOf[i].id,
    assigned_by: actor,
    type: 'auto' as const,
    created_at: ts,
  }))
  const { error: e2 } = await sb().from('assignments').insert(asg)
  if (e2) throw e2
  // rep 별로 묶어 update 를 배치 처리(회원 수만큼 개별 update 하던 것을 rep 수만큼으로 축소 —
  // 라운드트립이 줄어야 도중 실패 구간도 줄어든다).
  const idsByRep = new Map<string, string[]>()
  ids.forEach((mid, i) => {
    const rep = repOf[i]
    idsByRep.set(rep.id, [...(idsByRep.get(rep.id) ?? []), mid])
  })
  for (const rep of reps) {
    const memberIds = idsByRep.get(rep.id)
    if (!memberIds || memberIds.length === 0) continue
    await updateByIds('members', { assigned_staff_id: rep.id, team_id: rep.team_id }, memberIds)
  }
  await pushLog({ kind: 'admin', actor, action: 'member.auto_assign', meta: { count: ids.length } })
}

export async function resetAssign(ids: string[], actor: string | null): Promise<void> {
  const ts = nowIso()
  const rows = ids.map((mid) => ({
    id: genId('as'),
    member_id: mid,
    staff_id: null,
    assigned_by: actor,
    type: 'manual' as const,
    created_at: ts,
  }))
  // 로그 먼저, 회원 정보 나중(현장 피드백 7/22) — assignStaff/autoAssign 과 동일 원칙.
  const { error: e2 } = await sb().from('assignments').insert(rows)
  if (e2) throw e2
  await updateByIds('members', { assigned_staff_id: null, team_id: null }, ids)
  await pushLog({ kind: 'admin', actor, action: 'member.reset_assign', meta: { count: ids.length } })
}

/** DB 초기화(§V2-4) — mock useResetMembers 의 supabase 미러. 콜메모 소프트삭제(meta.reset_memos) 보존. */
export async function resetMembers(ids: string[], actor: string | null): Promise<string[]> {
  const ts = nowIso()
  const rows = await selectByIds<{ id: string; memo: string | null; meta: Record<string, unknown> | null }>(
    'members',
    'id, memo, meta',
    ids,
  )
  for (const r of rows) {
    const archive = (((r.meta?.reset_memos as unknown[] | undefined) ?? []) as unknown[]).slice()
    // 리스트형 콜메모 전체 보존 후 비움. 없으면 단건 메모 폴백.
    const memos = Array.isArray(r.meta?.memos) ? (r.meta!.memos as { body: string }[]) : []
    if (memos.length > 0) {
      for (const e of memos) archive.push({ body: e.body, archived_at: ts, reset_by: actor })
    } else if (r.memo && r.memo.trim()) {
      archive.push({ body: r.memo, archived_at: ts, reset_by: actor })
    }
    const meta = { ...(r.meta ?? {}), memos: [], reset_memos: archive, last_reset_at: ts }
    const { error } = await sb()
      .from('members')
      .update({
        memo: null,
        grade: 'free',
        status: 'active',
        assigned_staff_id: null,
        team_id: null,
        outcall_done: false,
        tendency: null,
        last_active_at: null,
        registered_at: ts, // 현장 피드백: 초기화 시점을 새 가입일시로
        is_suspended: false,
        is_deleted: false,
        is_withdrawn: false,
        meta,
      })
      .eq('id', r.id)
    if (error) throw error
  }
  const asg = ids.map((id) => ({
    id: genId('as'),
    member_id: id,
    staff_id: null,
    assigned_by: actor,
    type: 'manual' as const,
    created_at: ts,
  }))
  if (asg.length) {
    const { error } = await sb().from('assignments').insert(asg)
    if (error) throw error
  }
  await pushLog({ kind: 'admin', actor, action: 'member.reset_db', target_type: 'member', target_id: null, meta: { count: ids.length } })
  return ids
}

export async function sendSms(ids: string[], templateKey: string, actor: string | null): Promise<void> {
  const { data: tplData } = await sb().from('sms_templates').select('*').eq('key', templateKey).maybeSingle()
  const tpl = tplData as SmsTemplate | null
  // id 청크 조회(URL 414 회피 — 단체문자 300+ 건이면 단일 .in() 가 거절돼 전체 실패하던 버그).
  const members = await selectByIds<Member>('members', '*', ids)
  const { realSend, sender_no, adOptout } = await fetchSmsConfig()
  const ts = nowIso()
  const type = smsTypeForTemplate(templateKey)

  // 추천번호 템플릿 발송: 회원정보창 조합발송과 '동일 본문'(실제 발급조합)으로 통일(현장 피드백 6/22).
  // 회원에게 대상 회차 발급분이 없으면 즉석 발급 후 meta 적재(홈페이지 조회분과 일치).
  const isReco = templateKey === 'recommend'
  // 약관 템플릿: 약관 전문 대신 회원 등급의 공개 약관 페이지 링크를 발송(현장 피드백 7/22).
  const isTerms = templateKey === 'terms'
  let recoRounds: LottoRound[] = []
  let recoSettings: SiteSettings | null = null
  let recoTarget = 0
  if (isReco) {
    recoRounds = await selectAll<LottoRound>('lotto_rounds')
    const { data: sData } = await sb().from('site_settings').select('*').eq('id', 1).maybeSingle()
    recoSettings = sData as SiteSettings
    recoTarget = recoRounds.reduce((mx, r) => Math.max(mx, r.round_no), 0) + 1
  }

  // 제한 동시성(SMS_SEND_CONC)으로 발송 — 순차 1건씩이면 1000건에 수십분 걸려 탭 끊김 위험.
  const rows: SmsSend[] = await mapPool(members, SMS_SEND_CONC, async (m) => {
    let body: string
    if (isReco && recoSettings) {
      const recos = Array.isArray(m.meta.weekly_recos) ? (m.meta.weekly_recos as WeeklyRecoIssue[]) : []
      let issue = recos.find((r) => r.round_no === recoTarget) ?? null
      if (!issue) {
        const exclude = resolveExcludeForGrade(recoSettings, m.grade)
        const ratio = recoSettings.weekly_free_reco?.logic_ratio ?? 100
        const cnt =
          typeof m.meta.weekly_reco_count === 'number' && (m.meta.weekly_reco_count as number) > 0
            ? (m.meta.weekly_reco_count as number)
            : (recoSettings.weekly_free_reco?.set_count ?? 30)
        const sets = generateIssueSets(recoRounds, exclude, Math.max(1, cnt), ratio)
        issue = { round_no: recoTarget, issued_at: ts, sets }
        const meta = { ...m.meta, weekly_recos: [issue, ...recos].slice(0, 8) }
        await sb().from('members').update({ meta }).eq('id', m.id)
      }
      body = recoSmsBody(m.name, issue.sets)
    } else if (isTerms) {
      const link = membershipTermsUrl(m.grade)
      // 기존 라이브 템플릿의 $contents도 링크로 치환해 템플릿 저장 전후 모두 전문이 발송되지 않게 한다.
      body = tpl ? renderSms(tpl.body, m, { link, contents: link }) : link
    } else {
      body = tpl ? renderSms(tpl.body, m) : ''
      if (type === 'marketing' && adOptout) body = `(광고)${body}\n무료거부 ${adOptout}`
    }
    // 실발송(oneshot_enabled+발신번호) 시 OneShot 호출 — 미설정이면 '미발송'으로 기록만.
    let status = '미발송'
    if (realSend) {
      const r = await sendOneShot({ dest_phone: m.phone, msg_body: body, send_phone: sender_no })
      status = r.ok ? '발송완료' : `실패(${r.code ?? '?'})`
    }
    return {
      id: genId('sms'),
      member_id: m.id,
      template_key: templateKey,
      phone: m.phone,
      body,
      type,
      status,
      sent_at: ts,
    }
  })
  // 발송내역 기록 실패는 throw 하지 않음(D68 #7) — 실발송이 이미 나간 뒤라 '실패' 표시·재발송 유도를 막는다.
  const { error: e2 } = await sb().from('sms_sends').insert(rows)
  if (e2) {
    console.warn('[sms] sms_sends insert 실패(발송내역 미기록):', e2.message)
    await pushLog({ kind: 'sms', actor, action: 'sms.record_failed', target_type: 'member', target_id: null, meta: { count: rows.length, template: templateKey, error: e2.message } })
  }
  await pushLog({ kind: 'sms', actor, action: 'sms.send', target_type: 'member', target_id: null, meta: { count: rows.length, template: templateKey, real: realSend } })
}

// 사이트 설정의 문자(oneshot) 게이트 — 실발송 여부 판단용.
async function fetchSmsConfig(): Promise<{ realSend: boolean; sender_no: string; adOptout: string }> {
  const { data } = await sb().from('site_settings').select('sms').eq('id', 1).maybeSingle()
  const sms = (data as { sms: SiteSettings['sms'] } | null)?.sms
  return {
    realSend: !!sms?.oneshot_enabled && !!sms.sender_no,
    sender_no: sms?.sender_no ?? '',
    adOptout: sms?.ad_optout ?? '',
  }
}

/** 직접 입력 문자 발송(<회원정보창> 3) — 템플릿 없이 자유 본문. 실발송 게이트는 mock 과 동일. */
export async function sendCustomSms(ids: string[], body: string, actor: string | null): Promise<void> {
  // id 청크 조회(URL 414 회피 — 자유본문 단체발송 300+ 건 전체 실패 버그).
  const members = await selectByIds<{ id: string; phone: string }>('members', 'id, phone', ids)
  const { realSend, sender_no } = await fetchSmsConfig()
  const ts = nowIso()
  // 제한 동시성 발송(순차 시 대량건 수십분).
  const rows: SmsSend[] = await mapPool(members, SMS_SEND_CONC, async (m) => {
    let status = '미발송'
    if (realSend) {
      const r = await sendOneShot({ dest_phone: m.phone, msg_body: body, send_phone: sender_no })
      status = r.ok ? '발송완료' : '실패'
    }
    return {
      id: genId('sms'),
      member_id: m.id,
      template_key: null,
      phone: m.phone,
      body,
      type: 'direct' as const,
      status,
      sent_at: ts,
    }
  })
  // 기록 실패 best-effort(D68 #7) — 실발송 후라 throw 시 '실패' 오표시·재발송 위험.
  const { error } = await sb().from('sms_sends').insert(rows)
  if (error) {
    console.warn('[sms] 직접발송 sms_sends insert 실패(미기록):', error.message)
    await pushLog({ kind: 'sms', actor, action: 'sms.record_failed', target_type: 'member', target_id: null, meta: { count: rows.length, kind: 'direct', error: error.message } })
  }
  await pushLog({ kind: 'sms', actor, action: 'sms.send_direct', target_type: 'member', target_id: ids.length === 1 ? ids[0] : null, meta: { count: rows.length, real: realSend } })
}

/** 수동 조합 발급/발송(<회원정보창> 4) — mock useManualIssueReco 미러. */
export async function manualIssueReco(
  v: ManualIssueInput,
  actor: string | null,
): Promise<{ round_no: number; sets: number[][] }> {
  const { data: mData } = await sb().from('members').select('id, name, grade, phone, meta').eq('id', v.memberId).maybeSingle()
  const member = mData as { id: string; name: string; grade: Member['grade']; phone: string; meta: Record<string, unknown> | null } | null
  if (!member) throw new Error('회원을 찾을 수 없습니다.')
  const { data: sData, error: se } = await sb().from('site_settings').select('*').eq('id', 1).maybeSingle()
  if (se) throw se
  const settings = sData as SiteSettings
  const rounds = await selectAll<LottoRound>('lotto_rounds') // 1000행 캡 회피(페이지네이션)
  const exclude = resolveExcludeForGrade(settings, member.grade)
  const targetRound = rounds.reduce((mx, r) => Math.max(mx, r.round_no), 0) + 1
  const ratio = settings.weekly_free_reco?.logic_ratio ?? 100
  const res = { sets: generateIssueSets(rounds, exclude, Math.max(1, v.setCount), ratio) }
  const ts = nowIso()
  const issue: WeeklyRecoIssue = { round_no: targetRound, issued_at: ts, sets: res.sets }
  const recos = Array.isArray(member.meta?.weekly_recos) ? (member.meta!.weekly_recos as WeeklyRecoIssue[]) : []
  const meta = { ...(member.meta ?? {}), weekly_recos: [issue, ...recos].slice(0, 8) }
  const { error: ue } = await sb().from('members').update({ meta }).eq('id', v.memberId)
  if (ue) throw ue

  if (v.alsoSms) {
    const body = recoSmsBody(member.name, res.sets)
    const { realSend, sender_no } = await fetchSmsConfig()
    let status = '미발송'
    if (realSend) {
      const r = await sendOneShot({ dest_phone: member.phone, msg_body: body, send_phone: sender_no })
      status = r.ok ? '발송완료' : '실패'
    }
    const { error } = await sb().from('sms_sends').insert({
      id: genId('sms'),
      member_id: v.memberId,
      template_key: 'recommend',
      phone: member.phone,
      body,
      type: 'recommend',
      status,
      sent_at: ts,
    })
    // 기록 실패 best-effort(D68 #7) — 실발송 후라 throw 시 발급 자체가 롤백/오류로 보임.
    if (error) {
      console.warn('[sms] 수동조합 sms_sends insert 실패(미기록):', error.message)
      await pushLog({ kind: 'sms', actor, action: 'sms.record_failed', target_type: 'member', target_id: v.memberId, meta: { kind: 'reco', error: error.message } })
    }
  }
  await pushLog({ kind: 'admin', actor, action: 'reco.manual_issue', target_type: 'member', target_id: v.memberId, meta: { round_no: targetRound, set_count: res.sets.length, sms: v.alsoSms } })
  return { round_no: targetRound, sets: res.sets }
}
