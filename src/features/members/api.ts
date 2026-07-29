// 이용자 모듈 데이터 훅 (CLAUDE §1·§8). 전부 TanStack Query 경유 —
// 컴포넌트 직접 fetch 금지. 뮤테이션은 mock DB 를 변경하고 §8 흐름대로
// 로그/배정/문자 부수효과를 만든 뒤 관련 쿼리를 무효화한다.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CallRecording, Grade, LogEntry, Member, MemberStatus, Payment, PaymentMethod, Role, SmsSend, Staff, WeeklyRecoIssue } from '@/types/db'
import { genId, mutateDb, nowIso, readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { staffById, staffRoleById, assignableReps } from '@/lib/staff'
import { useCurrentUser, type CurrentUser } from '@/lib/auth'
import { callReservationAlertsKey } from '@/lib/callReservations'
import { memberKeys, operationalKeys, paymentKeys, revenueKeys, smsTemplateKeys } from '@/lib/queryKeys'
import { recoSmsBody, renderSms, smsTypeForTemplate, spamSafeRound } from '@/lib/sms'
import { sendOneShot } from '@/lib/oneshot'
import { resolveExcludeForGrade } from '@/lib/lotto'
import { generateIssueSetsForGrade } from '@/lib/lottoPatentExclude'
import { membershipTermsUrl } from '@/lib/membership'
import { normalizeInflowType } from '@/lib/inflow'
import { filterMembers, getView, MEMBER_VIEWS, type MemberFilter } from './views'
import * as supa from './supa'

export { memberKeys }

// ── RLS 에뮬레이션: 역할별 데이터 스코프 (mock). 실 전환 시 RLS 가 대신. ──
// 명칭변경/권한(현장 피드백): 최고관리자(admin)·관리자(manager)·실장(leader)=전체 이용자,
// 팀장(rep)=본인 담당만. (실장이 팀 한정 → 전체로 확대)
function scopeMembers(all: readonly Member[], user: CurrentUser | null): Member[] {
  if (!user) return []
  if (user.role === 'rep') return all.filter((m) => m.assigned_staff_id === user.id) // 팀장 = 본인 담당
  return [...all] // 최고관리자·관리자·실장 = 전체
}

// ── 정렬 ──────────────────────────────────────────────────────────────
type SortVal = string | number
function sortValue(m: Member, id: string): SortVal | null {
  switch (id) {
    case 'name':
      return m.name
    case 'user_id':
      return m.user_id
    case 'grade':
      return m.grade
    case 'status':
      return m.status
    case 'registered_at':
      return Date.parse(m.registered_at)
    case 'last_active_at':
      return m.last_active_at ? Date.parse(m.last_active_at) : null
    default:
      return null
  }
}

// 유입시간(registered_at) 내림차순 + id 를 안정 타이브레이커로 사용한다.
// 현장 피드백: 유입분류/기타 수정 시에도 목록 순서가 흔들리지 않고 유입시간 기준으로 고정되어야 함.
function inflowTimeCmp(a: Member, b: Member): number {
  const ta = Date.parse(a.registered_at)
  const tb = Date.parse(b.registered_at)
  if (ta !== tb) return tb - ta // 최신 유입 우선
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function sortMembers(rows: Member[], sortId: string, desc: boolean): Member[] {
  const dir = desc ? -1 : 1
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sortId)
    const vb = sortValue(b, sortId)
    if (va === null && vb === null) return inflowTimeCmp(a, b)
    if (va === null) return 1 // null 은 항상 뒤로
    if (vb === null) return -1
    if (va < vb) return -1 * dir
    if (va > vb) return 1 * dir
    return inflowTimeCmp(a, b) // 동일 키는 유입시간으로 고정
  })
}

// 중복 DB 필터에서는 가입일이 아니라 "최근 중복 입력 시각"이 업무 우선순위다.
// 과거 실제 중복행은 그룹 내 가장 늦은 가입일을 중복 발생시각으로 폴백한다.
function sortByDuplicateInputTime(rows: Member[], allMembers: readonly Member[]): Member[] {
  const phoneGroups = new Map<string, { count: number; latest: number }>()
  for (const member of allMembers) {
    const phone = member.phone.replace(/\D/g, '')
    if (!phone) continue
    const current = phoneGroups.get(phone) ?? { count: 0, latest: 0 }
    current.count += 1
    current.latest = Math.max(current.latest, Date.parse(member.registered_at) || 0)
    phoneGroups.set(phone, current)
  }
  const timeOf = (member: Member): number => {
    const raw = member.meta.duplicate_last_at
    const marked = typeof raw === 'string' ? Date.parse(raw) : NaN
    const group = phoneGroups.get(member.phone.replace(/\D/g, ''))
    const legacy = group && group.count > 1 ? group.latest : 0
    return Math.max(Number.isFinite(marked) ? marked : 0, legacy, Date.parse(member.registered_at) || 0)
  }
  return [...rows].sort((a, b) => timeOf(b) - timeOf(a) || inflowTimeCmp(a, b))
}

// ── 공통 헬퍼 ─────────────────────────────────────────────────────────
function adminLog(
  actor: string | null,
  action: string,
  targetId: string | null,
  meta: Record<string, unknown> = {},
): LogEntry {
  return {
    id: genId('log'),
    kind: 'admin',
    actor,
    action,
    target_type: 'member',
    target_id: targetId,
    meta,
    created_at: nowIso(),
  }
}

function syncStatusFlags(m: Member): void {
  m.is_suspended = m.status === 'suspended'
  m.is_deleted = m.status === 'deleted'
  m.is_withdrawn = m.status === 'withdrawn'
}

export interface MemberPatch {
  grade?: Grade
  status?: MemberStatus
  memo?: string | null
  tendency?: string | null
  consult_status?: string | null
  outcall_done?: boolean
  name?: string // 기본정보 인라인 수정(현장 피드백 7/6)
  phone?: string
  nickname?: string | null // 인라인 수정(현장 피드백 7/23)
  inflow_code?: string | null // 인라인 수정(현장 피드백 7/23)
}

// ── 콜메모(리스트형) — 현장 피드백: 메모 1건만이 아니라 순차적으로 누적 ──────
// 삭제는 소프트(deleted_at) — 최고관리자만 삭제 가능하며 삭제분도 최고관리자만 열람(<회원정보창> 7).
export interface MemoEntry {
  id: string
  body: string
  author: string | null // 작성 staff id
  created_at: string
  deleted_at?: string | null
  deleted_by?: string | null
}

// ── 민원관리(현장 피드백 7/6) — meta.complaints 리스트형 누적(메모와 동일 패턴) ────────
export interface ComplaintEntry {
  id: string
  created_at: string
  author: string | null // 작성 staff id
  body: string // 메모
  type: string // 민원유형: 카드/경찰/소보원
  result: string // 민원처리결과: 성공/실패
}

/** member.meta.complaints 를 안전하게 읽는다(없으면 빈 배열). 민원횟수 = 이 배열 길이. */
export function readComplaints(m: Member | null | undefined): ComplaintEntry[] {
  if (!m) return []
  const list = m.meta?.complaints as ComplaintEntry[] | undefined
  return Array.isArray(list) ? list : []
}

/** member.meta.memos 를 안전하게 읽는다(없으면 빈 배열). */
export function readMemos(m: Member | null | undefined): MemoEntry[] {
  if (!m) return []
  const list = m.meta?.memos as MemoEntry[] | undefined
  return Array.isArray(list) ? list : []
}

function applyPatch(m: Member, patch: MemberPatch): void {
  Object.assign(m, patch)
  if (patch.status) syncStatusFlags(m)
}

// ── 목록 ──────────────────────────────────────────────────────────────
export interface MembersQuery {
  view?: string
  search?: string
  extra?: MemberFilter // FilterBar 추가 필터 (뷰 위에 병합)
  page: number // 1-based
  pageSize: number
  sortId?: string
  sortDesc?: boolean
}

export interface MembersResult {
  rows: Member[]
  total: number // scope+filter 후, 페이지네이션 전
  pageCount: number
}

interface MemberFacets {
  counts: Record<string, number>
  inflowCodes: string[]
}

function resolvedFilter(q: MembersQuery): MemberFilter {
  return { ...getView(q.view).filter, ...q.extra, search: q.search }
}

function useMemberFacets(scope: 'all' | 'mine') {
  const user = useCurrentUser()
  return useQuery({
    queryKey: memberKeys.facets(`${scope}:${user?.id ?? 'anon'}:${user?.role ?? 'none'}`),
    queryFn: async (): Promise<MemberFacets> => {
      if (dataSource === 'supabase') {
        return supa.fetchMemberFacets(scope === 'mine' ? (user?.id ?? '') : null)
      }
      const base = scope === 'mine'
        ? scopeMine(readDb().members, user)
        : scopeMembers(readDb().members, user)
      const roleMap = staffRoleById()
      const inflowCodes = Array.from(
        new Set(base.map((m) => m.inflow_code).filter((code): code is string => !!code && code.trim().length > 0)),
      ).sort((a, b) => a.localeCompare(b, 'ko'))
      return { counts: countsFrom(base, roleMap), inflowCodes }
    },
    staleTime: 2 * 60 * 1000,
  })
}

// 목록/카운트 공통 코어 — base(이미 스코프된 회원 배열)에 뷰·필터·정렬·페이지를 적용.
// roleMap(assigned_staff_id→role)은 모드별 출처(mock=staffRoleById / supabase=fetchStaffRoleMap)에서 주입.
function listFrom(base: readonly Member[], q: MembersQuery, roleMap: Record<string, Role>): MembersResult {
  const view = getView(q.view)
  const filter: MemberFilter = { ...view.filter, ...q.extra, search: q.search }
  const ctx = { now: Date.now(), staffRoleById: roleMap }
  const filtered = filterMembers(base, filter, ctx)
  const sorted = filter.dupPhone
    ? sortByDuplicateInputTime(filtered, base)
    : q.sortId
      ? sortMembers(filtered, q.sortId, q.sortDesc ?? false)
      : sortMembers(filtered, 'registered_at', true) // 기본: 최신가입 우선
  const total = sorted.length
  const start = (q.page - 1) * q.pageSize
  return {
    rows: sorted.slice(start, start + q.pageSize),
    total,
    pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
  }
}

function countsFrom(base: readonly Member[], roleMap: Record<string, Role>): Record<string, number> {
  const ctx = { now: Date.now(), staffRoleById: roleMap }
  const out: Record<string, number> = {}
  for (const v of MEMBER_VIEWS) out[v.key] = filterMembers(base, v.filter, ctx).length
  return out
}

export function useMembers(q: MembersQuery) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: memberKeys.list({ ...q, uid: user?.id ?? 'anon', role: user?.role ?? 'none' }),
    queryFn: async (): Promise<MembersResult> => {
      if (dataSource === 'supabase') {
        return supa.fetchMembersPage(
          resolvedFilter(q), q.page, q.pageSize, q.sortId, q.sortDesc ?? false,
        )
      }
      return listFrom(scopeMembers(readDb().members, user), q, staffRoleById())
    },
    placeholderData: (prev) => prev,
  })
}

/** 각 뷰의 건수(스코프 적용, 검색 제외) — 탭/드롭다운 배지용. */
export function useMemberViewCounts() {
  const facets = useMemberFacets('all')
  return { ...facets, data: facets.data?.counts }
}

/** 실제 데이터에 존재하는 유입코드 목록(역할 스코프, 중복 제거·정렬) — 필터 드롭다운용(현장 피드백). */
export function useInflowCodes() {
  const facets = useMemberFacets('all')
  return { ...facets, data: facets.data?.inflowCodes }
}

// ── 나의고객 (CLAUDE §4 나의고객) — '내가 담당하는' 회원만(assigned_staff_id===나).
// 역할 RLS 스코프와 달리, manager/leader 도 '본인 담당' 케이스로드만 본다.
function scopeMine(all: readonly Member[], user: CurrentUser | null): Member[] {
  if (!user) return []
  return all.filter((m) => m.assigned_staff_id === user.id)
}

export function useMyCustomers(q: MembersQuery) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: memberKeys.list({ ...q, scope: 'mine', uid: user?.id ?? 'anon' }),
    queryFn: async (): Promise<MembersResult> => {
      if (dataSource === 'supabase') {
        return supa.fetchMembersPage(
          resolvedFilter(q), q.page, q.pageSize, q.sortId, q.sortDesc ?? false, user?.id ?? '',
        )
      }
      return listFrom(scopeMine(readDb().members, user), q, staffRoleById())
    },
    placeholderData: (prev) => prev,
  })
}

export function useMyCustomerCounts() {
  const facets = useMemberFacets('mine')
  return { ...facets, data: facets.data?.counts }
}

export interface MySmsRow {
  id: string
  member_id: string
  member_name: string
  phone: string
  body: string
  type: string
  status: string
  sent_at: string | null
}

/** 내 담당 회원에게 발송된 문자 내역(최신순) — 나의고객 문자 발송 센터용. */
export function useMySmsLog(limit = 80) {
  const user = useCurrentUser()
  return useQuery({
    queryKey: ['my-sms', user?.id ?? 'anon', limit],
    queryFn: async (): Promise<MySmsRow[]> => {
      if (dataSource === 'supabase') return supa.fetchMineSmsLog(user?.id ?? '', limit)
      const db = readDb()
      const mine = new Map(scopeMine(db.members, user).map((m) => [m.id, m.name]))
      return db.sms_sends
        .filter((s) => mine.has(s.member_id))
        .sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? ''))
        .slice(0, limit)
        .map((s) => ({
          id: s.id,
          member_id: s.member_id,
          member_name: mine.get(s.member_id) ?? s.member_id,
          phone: s.phone,
          body: s.body,
          type: s.type,
          status: s.status,
          sent_at: s.sent_at,
        }))
    },
  })
}

export function useSmsTemplates() {
  return useQuery({
    queryKey: smsTemplateKeys.all,
    queryFn: () => (dataSource === 'supabase' ? supa.fetchSmsTemplates() : readDb().sms_templates),
  })
}

export function useProducts() {
  return useQuery({
    queryKey: ['products'],
    queryFn: () => (dataSource === 'supabase' ? supa.fetchProducts() : readDb().products),
  })
}

export function useMember(id: string | null) {
  return useQuery({
    queryKey: memberKeys.detail(id ?? ''),
    queryFn: () =>
      dataSource === 'supabase'
        ? supa.fetchMember(id ?? '')
        : readDb().members.find((m) => m.id === id) ?? null,
    enabled: !!id,
  })
}

export function useMemberPayments(id: string | null) {
  return useQuery({
    queryKey: memberKeys.payments(id ?? ''),
    queryFn: async () =>
      (dataSource === 'supabase'
        ? await supa.fetchMemberPayments(id ?? '')
        : readDb().payments.filter((p) => p.member_id === id)
      ).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    enabled: !!id,
  })
}

export function useMemberSms(id: string | null) {
  return useQuery({
    queryKey: memberKeys.sms(id ?? ''),
    queryFn: async () =>
      (dataSource === 'supabase'
        ? await supa.fetchMemberSms(id ?? '')
        : readDb().sms_sends.filter((s) => s.member_id === id)
      ).sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? '')),
    enabled: !!id,
  })
}

export function useMemberAssignments(id: string | null) {
  return useQuery({
    queryKey: memberKeys.assignments(id ?? ''),
    queryFn: async () =>
      (dataSource === 'supabase'
        ? await supa.fetchMemberAssignments(id ?? '')
        : readDb().assignments.filter((a) => a.member_id === id)
      ).sort((a, b) => b.created_at.localeCompare(a.created_at)),
    enabled: !!id,
  })
}

// ── 뮤테이션 ──────────────────────────────────────────────────────────
function useInvalidateMembers() {
  const qc = useQueryClient()
  return (ids?: string[]) => {
    qc.invalidateQueries({ queryKey: memberKeys.all }) // list + counts
    qc.invalidateQueries({ queryKey: operationalKeys.all })
    // 통화예약(call_reservation_at)은 회원 meta 갱신 경로 어디서든 바뀔 수 있어 함께 무효화한다(현장
    // 피드백 7/24 "예약해도 알람이 안 울린다" — 저장 직후 벨이 최신 상태를 즉시 반영하도록 보장).
    qc.invalidateQueries({ queryKey: callReservationAlertsKey })
    for (const id of ids ?? []) qc.invalidateQueries({ queryKey: memberKeys.detail(id) })
  }
}

/** 단건 필드 수정(등급/상태/메모/성향/아웃콜). 담당 변경은 useAssignStaff 사용. */
export function useUpdateMember() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; patch: MemberPatch }) => {
      if (dataSource === 'supabase') {
        await supa.updateMember(v.id, v.patch, user?.id ?? null)
        return v.id
      }
      mutateDb((db) => {
        const m = db.members.find((x) => x.id === v.id)
        if (!m) return
        const before: MemberPatch = { grade: m.grade, status: m.status }
        applyPatch(m, v.patch)
        db.logs.push(adminLog(user?.id ?? null, 'member.update', v.id, { patch: v.patch, before }))
      })
      return v.id
    },
    onSuccess: (id) => invalidate([id]),
  })
}

/**
 * 콜메모 추가(리스트형 누적) — 현장 피드백. meta.memos 에 한 건씩 append 하고
 * member.memo(최신 1건)는 목록/필터 호환을 위해 마지막 메모로 동기화한다.
 */
export function useAddMemo() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; body: string }) => {
      const body = v.body.trim()
      if (!body) return v.id
      if (dataSource === 'supabase') {
        await supa.addMemo(v.id, body, user?.id ?? null)
        return v.id
      }
      mutateDb((db) => {
        const m = db.members.find((x) => x.id === v.id)
        if (!m) return
        const entry: MemoEntry = {
          id: genId('memo'),
          body,
          author: user?.id ?? null,
          created_at: nowIso(),
        }
        const list = (Array.isArray(m.meta?.memos) ? (m.meta!.memos as MemoEntry[]) : []).slice()
        list.push(entry)
        m.meta = { ...m.meta, memos: list }
        m.memo = body // 최신 메모(컬럼/메모있음 세그먼트 호환)
        db.logs.push(adminLog(user?.id ?? null, 'member.memo_add', v.id, { body }))
      })
      return v.id
    },
    onSuccess: (id) => invalidate([id]),
  })
}

/** 민원 1건 추가(현장 피드백 7/6) — 메모+유형(카드/경찰/소보원)+처리결과(성공/실패) 리스트형 누적. */
export function useAddComplaint() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; body: string; type: string; result: string }) => {
      if (dataSource === 'supabase') {
        await supa.addComplaint(v.id, v.body, v.type, v.result, user?.id ?? null)
        return v.id
      }
      mutateDb((db) => {
        const m = db.members.find((x) => x.id === v.id)
        if (!m) return
        const entry: ComplaintEntry = {
          id: genId('cmpl'),
          created_at: nowIso(),
          author: user?.id ?? null,
          body: v.body,
          type: v.type,
          result: v.result,
        }
        m.meta = { ...m.meta, complaints: [...readComplaints(m), entry] }
        db.logs.push(adminLog(user?.id ?? null, 'member.complaint_add', v.id, { type: v.type, result: v.result }))
      })
      return v.id
    },
    onSuccess: (id) => invalidate([id]),
  })
}

// ── 회원정보창 추가(현장 피드백): 조합발송요일·갯수·홈페이지 비번 등 meta 설정 ──────────
export interface MemberSettingsPatch {
  homepage_pw?: string | null // 홈페이지 로그인 비번(미설정 시 전화 뒷4자리)
  weekly_reco_day?: number | null // 조합발송요일 0=일..6=토 (미설정 시 전역 기본=금)
  weekly_reco_count?: number | null // 조합발송갯수 (미설정 시 전역 기본)
  end_date?: string | null // 구독 종료일(수정용 override) — 미설정 시 결제 period_end (현장 6/26)
  reco_paused?: boolean // 조합발송 일시정지(true=발급·문자 중단). 일시정지 유료회원 문자 정지용(현장 6/26)
  age_band?: string | null // 연령대(40미만/40~70/70이상) — 현장 피드백(7/3)
  gender?: string | null // 성별(남/여) — 현장 피드백(7/3)
  call_reservation_at?: string | null // 통화예약 일시(ISO) — 현장 피드백(7/23), AppShell 알림 배너가 참조
}

/** 회원별 발송 설정/홈페이지 비번 등(member.meta) 갱신. */
export function useUpdateMemberSettings() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; patch: MemberSettingsPatch }) => {
      if (dataSource === 'supabase') {
        await supa.updateMemberMeta(v.id, v.patch as Record<string, unknown>, user?.id ?? null)
        return v.id
      }
      mutateDb((db) => {
        const m = db.members.find((x) => x.id === v.id)
        if (!m) return
        const meta = { ...m.meta }
        for (const [k, val] of Object.entries(v.patch)) {
          if (val === null || val === undefined || val === '') delete meta[k]
          else meta[k] = val
        }
        m.meta = meta
        db.logs.push(adminLog(user?.id ?? null, 'member.settings_update', v.id, { patch: v.patch }))
      })
      return v.id
    },
    onSuccess: (id) => invalidate([id]),
  })
}

/** 회원별 발송 설정(조합발송요일/갯수 등 meta)을 선택 회원에 일괄 적용(§자동조합 일괄). */
export function useBulkUpdateMemberSettings() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { ids: string[]; patch: MemberSettingsPatch }) => {
      if (dataSource === 'supabase') {
        await supa.bulkUpdateMemberMeta(v.ids, v.patch as Record<string, unknown>, user?.id ?? null)
        return v.ids
      }
      mutateDb((db) => {
        for (const m of db.members) {
          if (!v.ids.includes(m.id)) continue
          const meta = { ...m.meta }
          for (const [k, val] of Object.entries(v.patch)) {
            if (val === null || val === undefined || val === '') delete meta[k]
            else meta[k] = val
          }
          m.meta = meta
        }
        db.logs.push(
          adminLog(user?.id ?? null, 'member.bulk_settings_update', null, {
            count: v.ids.length,
            ids: v.ids,
            patch: v.patch,
          }),
        )
      })
      return v.ids
    },
    onSuccess: (ids) => invalidate(ids),
  })
}

// ── 결제 요청(현장 피드백): 담당이 본인 회원 결제를 '대기'로 올림 → 관리자 승인 ──────────
export interface RequestPaymentInput {
  memberId: string
  productId: string
  amount: number
  method: PaymentMethod
  depositorName?: string | null
}

/** 회원 상세에서 결제 요청 → 대기(wait) 결제 생성. 승인은 결제 모듈(최고관리자/관리자). */
export function useRequestPayment() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: RequestPaymentInput) => {
      if (dataSource === 'supabase') {
        await supa.requestPayment(v, user?.id ?? null)
        return v.memberId
      }
      const id = genId('pay')
      mutateDb((db) => {
        const member = db.members.find((m) => m.id === v.memberId)
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
          depositor_name: v.depositorName?.trim() || member?.name || null,
          // 매출 귀속은 "결제를 요청/등록한 담당자" 기준(현장 피드백 7/21) — payments/api.ts 와 동일 원칙.
          staff_id: user?.id ?? member?.assigned_staff_id ?? null,
          paid_at: null,
          created_at: ts,
        }
        db.payments.push(p)
        db.logs.push(adminLog(user?.id ?? null, 'payment.request', v.memberId, {
          product_id: v.productId,
          amount: v.amount,
          method: v.method,
        }))
      })
      return v.memberId
    },
    onSuccess: (memberId) => {
      qc.invalidateQueries({ queryKey: paymentKeys.all })
      qc.invalidateQueries({ queryKey: revenueKeys.all })
      qc.invalidateQueries({ queryKey: memberKeys.payments(memberId) })
      qc.invalidateQueries({ queryKey: memberKeys.detail(memberId) })
    },
  })
}

/** 결제건별 담당자 배정 변경(현장 피드백 7/6) — 1차/2차/3차결제마다 다른 담당자 지정 가능.
 *  매출 귀속은 이미 payment.staff_id 기준(REVENUE_RULES.attribution='payment_staff')이라 이 값만 바꾸면 매출 화면에도 바로 반영됨. */
export function useUpdatePaymentStaff() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { paymentId: string; memberId: string; staffId: string | null }) => {
      if (dataSource === 'supabase') {
        await supa.updatePaymentStaff(v.paymentId, v.staffId, user?.id ?? null)
        return v
      }
      mutateDb((db) => {
        const p = db.payments.find((x) => x.id === v.paymentId)
        if (!p) return
        p.staff_id = v.staffId
        db.logs.push(adminLog(user?.id ?? null, 'payment.staff_update', v.paymentId, { staff_id: v.staffId }))
      })
      return v
    },
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: paymentKeys.all })
      qc.invalidateQueries({ queryKey: revenueKeys.all })
      qc.invalidateQueries({ queryKey: memberKeys.payments(v.memberId) })
    },
  })
}

/**
 * 콜메모 소프트삭제(<회원정보창> 7) — 최고관리자 전용(UI 가드). deleted_at 마킹만 하고 보존,
 * member.memo(최신 1건)는 남은(미삭제) 최신 메모로 동기화한다.
 */
export function useDeleteMemo() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; memoId: string }) => {
      if (dataSource === 'supabase') {
        await supa.deleteMemo(v.id, v.memoId, user?.id ?? null)
        return v.id
      }
      mutateDb((db) => {
        const m = db.members.find((x) => x.id === v.id)
        if (!m) return
        const list = (Array.isArray(m.meta?.memos) ? (m.meta!.memos as MemoEntry[]) : []).map((e) =>
          e.id === v.memoId ? { ...e, deleted_at: nowIso(), deleted_by: user?.id ?? null } : e,
        )
        m.meta = { ...m.meta, memos: list }
        m.memo = [...list].reverse().find((e) => !e.deleted_at)?.body ?? null
        db.logs.push(adminLog(user?.id ?? null, 'member.memo_delete', v.id, { memo_id: v.memoId }))
      })
      return v.id
    },
    onSuccess: (id) => invalidate([id]),
  })
}

// ── 통화 녹음(현장 피드백 7/3, 김형준 이사) — meta.call_recordings 리스트 ──────────────
/** member.meta.call_recordings 를 안전하게 읽는다(없으면 빈 배열). */
export function readCallRecordings(m: Member | null | undefined): CallRecording[] {
  if (!m) return []
  const list = m.meta?.call_recordings as CallRecording[] | undefined
  return Array.isArray(list) ? list : []
}

/** 녹음 파일 업로드(1단계: 상담원 수동 업로드 — PBX/통신사 자동연동은 정보 확보 후 별도). */
export function useUploadCallRecording() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; file: File }) => {
      if (dataSource === 'supabase') {
        await supa.uploadCallRecording(v.id, v.file, user?.id ?? null)
        return v.id
      }
      const entry: CallRecording = {
        id: genId('rec'),
        created_at: nowIso(),
        uploaded_by: user?.id ?? null,
        file_path: URL.createObjectURL(v.file), // mock: 세션 한정 blob URL(새로고침 시 소실)
        file_name: v.file.name,
      }
      mutateDb((db) => {
        const m = db.members.find((x) => x.id === v.id)
        if (!m) return
        m.meta = { ...m.meta, call_recordings: [entry, ...readCallRecordings(m)] }
        db.logs.push(adminLog(user?.id ?? null, 'member.call_recording_upload', v.id, { file_name: v.file.name }))
      })
      return v.id
    },
    onSuccess: (id) => invalidate([id]),
  })
}

/** 녹음 삭제(파일 + meta 항목). */
export function useDeleteCallRecording() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; recId: string; filePath: string }) => {
      if (dataSource === 'supabase') {
        await supa.deleteCallRecording(v.id, v.recId, v.filePath, user?.id ?? null)
        return v.id
      }
      mutateDb((db) => {
        const m = db.members.find((x) => x.id === v.id)
        if (!m) return
        m.meta = { ...m.meta, call_recordings: readCallRecordings(m).filter((r) => r.id !== v.recId) }
        db.logs.push(adminLog(user?.id ?? null, 'member.call_recording_delete', v.id, { rec_id: v.recId }))
      })
      return v.id
    },
    onSuccess: (id) => invalidate([id]),
  })
}

/** 녹음 재생 URL — supabase 는 서명 URL(1시간) 발급, mock 은 blob URL 그대로 재사용. */
export function useCallRecordingUrl() {
  return useMutation({
    mutationFn: async (filePath: string) =>
      dataSource === 'supabase' ? supa.signCallRecordingUrl(filePath) : filePath,
  })
}

/** STT 전사 + 키워드 탐지(/api/transcribe-call, OpenAI) — mock 모드는 미지원(실제 저장 파일이 없음). */
export function useTranscribeCallRecording() {
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; recId: string; filePath: string }) => {
      if (dataSource !== 'supabase') throw new Error('텍스트 변환은 라이브(Supabase) 모드에서만 지원됩니다.')
      return supa.transcribeCallRecording(v.id, v.recId, v.filePath)
    },
    onSuccess: (_r, v) => invalidate([v.id]),
  })
}

/** AI 통화분석(/api/analyze-call, OpenAI) — 전사본 필요, mock 모드 미지원(현장 피드백 7/10). */
export function useAnalyzeCallRecording() {
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { id: string; recId: string; transcript: string }) => {
      if (dataSource !== 'supabase') throw new Error('AI 분석은 라이브(Supabase) 모드에서만 지원됩니다.')
      return supa.analyzeCallRecording(v.id, v.recId, v.transcript)
    },
    onSuccess: (_r, v) => invalidate([v.id]),
  })
}

/** 상태/유입분류 등 일괄 패치. */
export function useBulkUpdateMembers() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { ids: string[]; patch: MemberPatch & { inflow_type?: string } }) => {
      if (dataSource === 'supabase') {
        await supa.bulkUpdateMembers(v.ids, v.patch, user?.id ?? null)
        return v.ids
      }
      mutateDb((db) => {
        for (const m of db.members) {
          if (!v.ids.includes(m.id)) continue
          if (v.patch.inflow_type !== undefined) m.inflow_type = normalizeInflowType(v.patch.inflow_type)
          applyPatch(m, v.patch)
        }
        db.logs.push(
          adminLog(user?.id ?? null, 'member.bulk_update', null, {
            count: v.ids.length,
            ids: v.ids,
            patch: v.patch,
          }),
        )
      })
      return v.ids
    },
    onSuccess: (ids) => invalidate(ids),
  })
}

// ── 회원 단건 등록 (§V2-2 DB 입력) ────────────────────────────────────
export interface MemberCreateInput {
  name: string
  phone: string
  user_id?: string | null
  nickname?: string | null
  grade?: Grade
  inflow_code?: string | null
  inflow_type?: string | null
  consult_status?: string | null
  tendency?: string | null
  age_band?: string | null // 연령대(40미만/40~70/70이상) — 현장 피드백(7/3), meta 저장
  gender?: string | null // 성별(남/여) — 현장 피드백(7/3), meta 저장
  memo?: string | null
  assigned_staff_id?: string | null
}

export interface MemberCreateResult {
  id: string | null
  created: boolean
}

const onlyDigits = (s: string) => s.replace(/\D/g, '')

// 단건/일괄 공통: MemberCreateInput → 신규 리드 Member(기본값 동일 — 미배분·무료·정상·미아웃콜).
function buildLeadMember(
  input: MemberCreateInput,
  opts: { id: string; userId: string; staff: Staff | null; imported?: boolean },
): Member {
  return {
    id: opts.id,
    user_id: input.user_id?.trim() || opts.userId,
    name: input.name.trim(),
    nickname: input.nickname?.trim() || null,
    phone: input.phone.trim(),
    grade: input.grade ?? 'free',
    status: 'active',
    tendency: input.tendency?.trim() || null,
    consult_status: input.consult_status?.trim() || '신규',
    inflow_code: input.inflow_code?.trim() || null,
    inflow_type: normalizeInflowType(input.inflow_type),
    assigned_staff_id: opts.staff?.id ?? null,
    team_id: opts.staff?.team_id ?? null,
    memo: input.memo?.trim() || null,
    win_history: null,
    outcall_done: false,
    registered_at: nowIso(),
    last_active_at: null,
    is_suspended: false,
    is_deleted: false,
    is_withdrawn: false,
    meta: {
      ...(opts.imported ? { imported: true } : {}),
      ...(input.age_band ? { age_band: input.age_band } : {}),
      ...(input.gender ? { gender: input.gender } : {}),
    },
  }
}

/** 중복 입력은 새 행 대신 기존 회원에 표시·최근 시도 정보를 남긴다. */
function markDuplicateAttempt(member: Member, input: MemberCreateInput, source: 'manual' | 'bulk_import'): void {
  const previousCount = Number(member.meta.duplicate_attempt_count)
  member.meta = {
    ...member.meta,
    dup_phone: true,
    duplicate_attempt_count: Number.isFinite(previousCount) ? previousCount + 1 : 1,
    duplicate_last_at: nowIso(),
    duplicate_last_source: source,
    duplicate_last_inflow_code: input.inflow_code?.trim() || null,
    duplicate_last_inflow_type: normalizeInflowType(input.inflow_type),
  }
}

// user_id(pl####) 자동 채번 시드: 기존 최대 번호.
function maxUserSeq(members: readonly { user_id: string }[]): number {
  return members.reduce((mx, m) => {
    const mm = /^pl(\d+)$/.exec(m.user_id)
    return mm ? Math.max(mx, parseInt(mm[1], 10)) : mx
  }, 1000)
}

/** 신규 리드 1건 등록. 전화 중복이면 신규 행을 만들지 않고 기존 DB를 중복으로 표시한다. */
export function useCreateMember() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (input: MemberCreateInput) => {
      if (dataSource === 'supabase') return supa.createMember(input, user?.id ?? null)
      let result: MemberCreateResult = { id: null, created: false }
      mutateDb((db) => {
        const phone = onlyDigits(input.phone)
        const existing = phone ? db.members.find((m) => onlyDigits(m.phone) === phone) : undefined
        if (existing) {
          markDuplicateAttempt(existing, input, 'manual')
          db.logs.push(
            adminLog(user?.id ?? null, 'member.duplicate_rejected', existing.id, {
              source: 'manual',
              attempted_name: input.name.trim(),
            }),
          )
          result = { id: existing.id, created: false }
          return
        }
        const id = genId('m')
        const staff = input.assigned_staff_id
          ? (db.staff.find((s) => s.id === input.assigned_staff_id) ?? null)
          : null
        const member = buildLeadMember(input, {
          id,
          userId: `pl${maxUserSeq(db.members) + 1}`,
          staff,
        })
        db.members.push(member)
        if (staff) {
          db.assignments.push({
            id: genId('as'),
            member_id: id,
            staff_id: staff.id,
            assigned_by: user?.id ?? null,
            type: 'manual',
            created_at: nowIso(),
          })
        }
        db.logs.push(adminLog(user?.id ?? null, 'member.create', id, { name: member.name, dup: false }))
        result = { id, created: true }
      })
      return result
    },
    onSuccess: (result) => invalidate(result.id ? [result.id] : undefined),
  })
}

/** 일괄 임포트(§V2-3) — 전화 중복은 건너뛰고 기존 DB를 중복으로 표시한다. */
export function useBulkImportMembers() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (inputs: MemberCreateInput[]) => {
      if (dataSource === 'supabase') return supa.bulkImportMembers(inputs, user?.id ?? null)
      let created = 0
      let dupCount = 0
      mutateDb((db) => {
        let seq = maxUserSeq(db.members)
        for (const input of inputs) {
          const phone = onlyDigits(input.phone)
          const existing = phone ? db.members.find((m) => onlyDigits(m.phone) === phone) : undefined
          if (existing) {
            dupCount++
            markDuplicateAttempt(existing, input, 'bulk_import')
            db.logs.push(
              adminLog(user?.id ?? null, 'member.duplicate_rejected', existing.id, {
                source: 'bulk_import',
                attempted_name: input.name.trim(),
              }),
            )
            continue
          }
          seq++
          const staff = input.assigned_staff_id
            ? (db.staff.find((s) => s.id === input.assigned_staff_id) ?? null)
            : null
          const id = genId('m')
          db.members.push(buildLeadMember(input, { id, userId: `pl${seq}`, staff, imported: true }))
          if (staff) {
            db.assignments.push({
              id: genId('as'),
              member_id: id,
              staff_id: staff.id,
              assigned_by: user?.id ?? null,
              type: 'manual',
              created_at: nowIso(),
            })
          }
          created++
        }
        db.logs.push(adminLog(user?.id ?? null, 'member.bulk_import', null, { count: created, dup: dupCount }))
      })
      return { created, dup: dupCount }
    },
    onSuccess: () => invalidate(),
  })
}

/** 담당자 수동 배정. members.assigned_staff_id/team_id 갱신 + assignments 로그(§8). */
export function useAssignStaff() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { ids: string[]; staffId: string }) => {
      if (dataSource === 'supabase') {
        await supa.assignStaff(v.ids, v.staffId, user?.id ?? null)
        return v.ids
      }
      const staff = staffById()[v.staffId]
      const teamId = staff?.team_id ?? null
      mutateDb((db) => {
        const ts = nowIso()
        for (const m of db.members) {
          if (!v.ids.includes(m.id)) continue
          m.assigned_staff_id = v.staffId
          m.team_id = teamId
          db.assignments.push({
            id: genId('as'),
            member_id: m.id,
            staff_id: v.staffId,
            assigned_by: user?.id ?? null,
            type: 'manual',
            created_at: ts,
          })
        }
        db.logs.push(
          adminLog(user?.id ?? null, 'member.assign', null, {
            count: v.ids.length,
            staff_id: v.staffId,
          }),
        )
      })
      return v.ids
    },
    onSuccess: (ids) => invalidate(ids),
  })
}

/**
 * 자동할당 — 라운드로빈. 풀 = 실행 시 지정한 staffIds(임시 가감) 우선,
 * 없으면 '자동배분 대상' 플래그가 켜진 활성 rep(§V2-1, assignableReps).
 */
export function useAutoAssign() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { ids: string[]; staffIds?: string[] }) => {
      if (dataSource === 'supabase') {
        await supa.autoAssign(v.ids, v.staffIds ?? null, user?.id ?? null)
        return v.ids
      }
      const pool =
        v.staffIds && v.staffIds.length > 0
          ? readDb().staff.filter((s) => v.staffIds!.includes(s.id))
          : assignableReps()
      if (pool.length === 0) return v.ids
      mutateDb((db) => {
        const ts = nowIso()
        // 라운드로빈 커서(현장 피드백 7/28, "이전 분배자에게 재분배되는 상황") — supa.ts autoAssign
        // 과 동일 이유: i 를 매 호출 0부터 다시 세면, 같은(또는 겹치는) 대상을 나눠서 여러 번
        // 자동배분할 때 배치 내 같은 상대 위치의 회원이 매번 같은 담당자로만 몰린다. 마지막으로
        // 배정한 staff_id 를 site_settings 에 남겨 다음 호출이 그 다음 사람부터 이어받게 한다.
        const cursor = db.site_settings.auto_assign_cursor ?? null
        const cursorIdx = cursor ? pool.findIndex((s) => s.id === cursor) : -1
        const startAt = cursorIdx === -1 ? 0 : (cursorIdx + 1) % pool.length
        let i = 0
        let last: string | null = null
        for (const m of db.members) {
          if (!v.ids.includes(m.id)) continue
          const rep = pool[(startAt + i) % pool.length]
          i++
          last = rep.id
          m.assigned_staff_id = rep.id
          m.team_id = rep.team_id
          db.assignments.push({
            id: genId('as'),
            member_id: m.id,
            staff_id: rep.id,
            assigned_by: user?.id ?? null,
            type: 'auto',
            created_at: ts,
          })
        }
        if (last) db.site_settings.auto_assign_cursor = last
        db.logs.push(
          adminLog(user?.id ?? null, 'member.auto_assign', null, {
            count: v.ids.length,
            pool: pool.length,
          }),
        )
      })
      return v.ids
    },
    onSuccess: (ids) => invalidate(ids),
  })
}

/** 담당 리셋 — 미지정으로 되돌림. */
export function useResetAssign() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { ids: string[] }) => {
      if (dataSource === 'supabase') {
        await supa.resetAssign(v.ids, user?.id ?? null)
        return v.ids
      }
      mutateDb((db) => {
        const ts = nowIso()
        for (const m of db.members) {
          if (!v.ids.includes(m.id)) continue
          m.assigned_staff_id = null
          m.team_id = null
          db.assignments.push({
            id: genId('as'),
            member_id: m.id,
            staff_id: null,
            assigned_by: user?.id ?? null,
            type: 'manual',
            created_at: ts,
          })
        }
        db.logs.push(
          adminLog(user?.id ?? null, 'member.reset_assign', null, { count: v.ids.length }),
        )
      })
      return v.ids
    },
    onSuccess: (ids) => invalidate(ids),
  })
}

// ── DB 초기화 (§V2-4) — 회원을 입력 시점(신규 리드) 상태로 되돌림 ───────────
export interface ResetMemo {
  body: string
  archived_at: string
  reset_by: string | null
}

/**
 * DB 초기화 — 재사용을 위해 회원을 신규 리드 상태로 되돌린다(차장 확정 옵션3).
 * 등급→무료·상태→정상·담당/팀 해제·아웃콜/성향/활동 초기화. 콜메모는 소프트삭제(meta.reset_memos)로
 * 보존해 최고관리자(admin)만 열람한다. 결제행은 감사용으로 보존(물리삭제 금지).
 */
export function useResetMembers() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  return useMutation({
    mutationFn: async (v: { ids: string[] }) => {
      if (dataSource === 'supabase') return supa.resetMembers(v.ids, user?.id ?? null)
      mutateDb((db) => {
        const ts = nowIso()
        for (const m of db.members) {
          if (!v.ids.includes(m.id)) continue
          const archive = ((m.meta?.reset_memos as ResetMemo[] | undefined) ?? []).slice()
          // 리스트형 콜메모 전체를 보존 후 비운다. 리스트가 없으면 단건 메모로 폴백.
          const memos = Array.isArray(m.meta?.memos) ? (m.meta!.memos as MemoEntry[]) : []
          if (memos.length > 0) {
            for (const e of memos) archive.push({ body: e.body, archived_at: ts, reset_by: user?.id ?? null })
          } else if (m.memo && m.memo.trim()) {
            archive.push({ body: m.memo, archived_at: ts, reset_by: user?.id ?? null })
          }
          m.memo = null
          m.grade = 'free'
          m.status = 'active'
          m.assigned_staff_id = null
          m.team_id = null
          m.outcall_done = false
          m.tendency = null
          m.consult_status = '신규'
          m.last_active_at = null
          m.registered_at = ts // 현장 피드백: 초기화 시점을 새 가입일시로 표시(재사용 신규 리드)
          m.is_suspended = false
          m.is_deleted = false
          m.is_withdrawn = false
          m.win_history = null // DB초기화 시 당첨내역도 함께 초기화(현장 피드백 7/28)
          m.meta = { ...m.meta, memos: [], reset_memos: archive, win_records: [], last_reset_at: ts }
          db.assignments.push({
            id: genId('as'),
            member_id: m.id,
            staff_id: null,
            assigned_by: user?.id ?? null,
            type: 'manual',
            created_at: ts,
          })
        }
        db.logs.push(adminLog(user?.id ?? null, 'member.reset_db', null, { count: v.ids.length }))
      })
      return v.ids
    },
    onSuccess: (ids) => invalidate(ids),
  })
}

// ── 문자 발송 (개별/일괄) — sms_sends 생성 + 회원 문자내역 + 문자로그(§8) ──
export function useSendSms() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { ids: string[]; templateKey: string }) => {
      if (dataSource === 'supabase') {
        await supa.sendSms(v.ids, v.templateKey, user?.id ?? null)
        return v.ids
      }
      // 본문 생성 + (광고성이면 (광고)·무료거부 자동표기). 실발송 설정 시 OneShot(Edge Function) 호출(§V2-6).
      const cur = readDb()
      const tpl = cur.sms_templates.find((t) => t.key === v.templateKey)
      const type = smsTypeForTemplate(v.templateKey)
      const sms = cur.site_settings.sms
      // 실발송: oneshot_enabled + 발신번호 설정 시. 실제 호출은 /api/send-sms(프록시) — 미배포 시 실패로 기록.
      const realSend = !!sms?.oneshot_enabled && !!sms.sender_no
      const targets = cur.members.filter((m) => v.ids.includes(m.id))
      const ts = nowIso()

      // 추천번호 템플릿: 조합발송과 동일 본문(실 발급조합). 발급분 없으면 즉석 발급 후 meta 적재(현장 피드백 6/22).
      const isReco = v.templateKey === 'recommend'
      const recoTarget = isReco ? cur.lotto_rounds.reduce((mx, r) => Math.max(mx, r.round_no), 0) + 1 : 0
      const freshIssues: Record<string, WeeklyRecoIssue> = {}

      // 약관 템플릿: 약관 전문 대신 회원 등급의 공개 약관 페이지 링크를 발송(현장 피드백 7/22).
      const isTerms = v.templateKey === 'terms'

      const records: SmsSend[] = []
      for (const m of targets) {
        let body: string
        if (isReco) {
          const recos = Array.isArray(m.meta?.weekly_recos) ? (m.meta!.weekly_recos as WeeklyRecoIssue[]) : []
          let issue = recos.find((r) => r.round_no === recoTarget) ?? null
          if (!issue) {
            const exclude = resolveExcludeForGrade(cur.site_settings, m.grade)
            const ratio = cur.site_settings.weekly_free_reco?.logic_ratio ?? 100
            const cnt =
              typeof m.meta?.weekly_reco_count === 'number' && (m.meta.weekly_reco_count as number) > 0
                ? (m.meta.weekly_reco_count as number)
                : (cur.site_settings.weekly_free_reco?.set_count ?? 30)
            issue = {
              round_no: recoTarget,
              issued_at: ts,
              // 실버·골드·다이아는 특허 제외수 로직, 그 외 등급은 기존 통계 로직(현장 피드백 7/23).
              sets: generateIssueSetsForGrade(cur.lotto_rounds, m.grade, exclude, Math.max(1, cnt), ratio),
            }
            freshIssues[m.id] = issue
          }
          body = recoSmsBody(m.name, issue.round_no, issue.sets)
        } else if (isTerms) {
          const link = membershipTermsUrl(m.grade)
          body = tpl ? renderSms(tpl.body, m, { link, contents: link }) : link
        } else {
          body = tpl ? renderSms(tpl.body, m) : ''
          if (type === 'marketing' && sms?.ad_optout) body = `(광고)${body}\n무료거부 ${sms.ad_optout}`
        }
        let status = '미발송'
        if (realSend) {
          const r = await sendOneShot({ dest_phone: m.phone, msg_body: body, send_phone: sms.sender_no })
          status = r.ok ? '발송완료' : '실패'
        }
        records.push({
          id: genId('sms'),
          member_id: m.id,
          template_key: v.templateKey,
          phone: m.phone,
          body,
          type,
          status,
          sent_at: ts,
        })
      }
      mutateDb((db) => {
        for (const [mid, issue] of Object.entries(freshIssues)) {
          const m = db.members.find((x) => x.id === mid)
          if (!m) continue
          const recos = Array.isArray(m.meta?.weekly_recos) ? (m.meta!.weekly_recos as WeeklyRecoIssue[]) : []
          m.meta = { ...m.meta, weekly_recos: [issue, ...recos].slice(0, 8) }
        }
        for (const rec of records) db.sms_sends.push(rec)
        db.logs.push({
          id: genId('log'),
          kind: 'sms',
          actor: user?.id ?? null,
          action: 'sms.send',
          target_type: 'member',
          target_id: null,
          meta: { count: records.length, template: v.templateKey, real: realSend },
          created_at: ts,
        })
      })
      return v.ids
    },
    onSuccess: (ids) => {
      qc.invalidateQueries({ queryKey: memberKeys.all })
      qc.invalidateQueries({ queryKey: ['my-sms'] }) // 나의고객 문자내역(§8)
      for (const id of ids) qc.invalidateQueries({ queryKey: memberKeys.sms(id) })
    },
  })
}

// ── 직접 입력 문자 발송(현장 피드백 <회원정보창> 3) — 템플릿 없이 본문 자유 입력 ─────────
export function useSendCustomSms() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { ids: string[]; body: string }) => {
      const body = v.body.trim()
      if (!body) return v.ids
      if (dataSource === 'supabase') {
        await supa.sendCustomSms(v.ids, body, user?.id ?? null)
        return v.ids
      }
      const cur = readDb()
      const sms = cur.site_settings.sms
      const realSend = !!sms?.oneshot_enabled && !!sms.sender_no
      const targets = cur.members.filter((m) => v.ids.includes(m.id))
      const ts = nowIso()
      const records: SmsSend[] = []
      for (const m of targets) {
        let status = '미발송'
        if (realSend) {
          const r = await sendOneShot({ dest_phone: m.phone, msg_body: body, send_phone: sms.sender_no })
          status = r.ok ? '발송완료' : '실패'
        }
        records.push({
          id: genId('sms'),
          member_id: m.id,
          template_key: null,
          phone: m.phone,
          body,
          type: 'direct',
          status,
          sent_at: ts,
        })
      }
      mutateDb((db) => {
        for (const rec of records) db.sms_sends.push(rec)
        db.logs.push({
          id: genId('log'),
          kind: 'sms',
          actor: user?.id ?? null,
          action: 'sms.send_direct',
          target_type: 'member',
          target_id: v.ids.length === 1 ? v.ids[0] : null,
          meta: { count: records.length, real: realSend },
          created_at: ts,
        })
      })
      return v.ids
    },
    onSuccess: (ids) => {
      qc.invalidateQueries({ queryKey: memberKeys.all })
      qc.invalidateQueries({ queryKey: ['my-sms'] })
      for (const id of ids) qc.invalidateQueries({ queryKey: memberKeys.sms(id) })
    },
  })
}

// ── 수동 조합 발급/발송(현장 피드백 <회원정보창> 4) ────────────────────────────────
// 회원 1명에게 즉시 조합을 생성·발급(발급번호 탭/홈페이지 노출). 옵션으로 문자 발송.
export interface ManualIssueInput {
  memberId: string
  setCount: number
  alsoSms: boolean // true 면 조합 본문을 문자로도 발송
}

export interface DeleteRecoInput {
  memberId: string
  roundNo: number
  issuedAt: string
}

export interface DeleteRecoResult {
  deletedIssues: number
  deletedSms: number
}

export function useManualIssueReco() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: ManualIssueInput): Promise<{ round_no: number; sets: number[][] }> => {
      if (dataSource === 'supabase') return supa.manualIssueReco(v, user?.id ?? null)
      const cur = readDb()
      const member = cur.members.find((m) => m.id === v.memberId)
      if (!member) throw new Error('회원을 찾을 수 없습니다.')
      const rounds = cur.lotto_rounds
      const exclude = resolveExcludeForGrade(cur.site_settings, member.grade)
      const targetRound = rounds.reduce((mx, r) => Math.max(mx, r.round_no), 0) + 1
      const setCount = Math.max(1, v.setCount)
      const ratio = cur.site_settings.weekly_free_reco?.logic_ratio ?? 100
      const sets = generateIssueSetsForGrade(rounds, member.grade, exclude, setCount, ratio)
      const res = { sets }
      const ts = nowIso()
      const issue: WeeklyRecoIssue = { round_no: targetRound, issued_at: ts, sets: res.sets }

      // 문자 발송(옵션) — 직접 발송과 동일한 실발송 게이트.
      const sms = cur.site_settings.sms
      const realSend = !!sms?.oneshot_enabled && !!sms.sender_no
      let smsStatus: string | null = null
      if (v.alsoSms) {
        smsStatus = '미발송'
        if (realSend) {
          const r = await sendOneShot({
            dest_phone: member.phone,
            msg_body: recoSmsBody(member.name, targetRound, res.sets),
            send_phone: sms.sender_no,
          })
          smsStatus = r.ok ? '발송완료' : '실패'
        }
      }

      mutateDb((db) => {
        const m = db.members.find((x) => x.id === v.memberId)
        if (!m) return
        const recos = Array.isArray(m.meta?.weekly_recos) ? (m.meta!.weekly_recos as WeeklyRecoIssue[]) : []
        m.meta = { ...m.meta, weekly_recos: [issue, ...recos].slice(0, 8) }
        if (v.alsoSms && smsStatus) {
          db.sms_sends.push({
            id: genId('sms'),
            member_id: m.id,
            template_key: 'recommend',
            phone: m.phone,
            body: recoSmsBody(member.name, targetRound, res.sets),
            type: 'recommend',
            status: smsStatus,
            sent_at: ts,
          })
        }
        db.logs.push(adminLog(user?.id ?? null, 'reco.manual_issue', v.memberId, {
          round_no: targetRound,
          set_count: res.sets.length,
          sms: v.alsoSms,
        }))
      })
      return { round_no: targetRound, sets: res.sets }
    },
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: memberKeys.detail(v.memberId) })
      qc.invalidateQueries({ queryKey: memberKeys.sms(v.memberId) })
      qc.invalidateQueries({ queryKey: ['weekly-free-reco-status'] })
    },
  })
}

/**
 * 잘못 발급·발송한 조합 1건 삭제. weekly_recos에서 제거해야 추첨 후 당첨 집계 대상에서도 빠진다.
 * 연결된 추천 SMS 이력과 해당 회차의 추천 당첨기록도 함께 정리하고 감사로그는 보존한다.
 */
export function useDeleteRecoIssue() {
  const user = useCurrentUser()
  const invalidate = useInvalidateMembers()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: DeleteRecoInput): Promise<DeleteRecoResult> => {
      if (dataSource === 'supabase') return supa.deleteRecoIssue(v)

      const current = readDb().members.find((m) => m.id === v.memberId)
      const issueExists = current
        ? ((current.meta?.weekly_recos as WeeklyRecoIssue[] | undefined) ?? []).some(
            (issue) => issue.round_no === v.roundNo && issue.issued_at === v.issuedAt,
          )
        : false
      if (!issueExists) throw new Error('삭제할 조합 발급내역을 찾을 수 없습니다.')

      let deletedSms = 0
      mutateDb((db) => {
        const member = db.members.find((m) => m.id === v.memberId)
        if (!member) return
        const recos = Array.isArray(member.meta?.weekly_recos)
          ? (member.meta.weekly_recos as WeeklyRecoIssue[])
          : []
        const remaining = recos.filter(
          (issue) => !(issue.round_no === v.roundNo && issue.issued_at === v.issuedAt),
        )
        const hasSameRound = remaining.some((issue) => issue.round_no === v.roundNo)
        const nextMeta: Record<string, unknown> = { ...member.meta, weekly_recos: remaining }
        if (!hasSameRound && Array.isArray(member.meta?.win_records)) {
          nextMeta.win_records = (member.meta.win_records as { round_no?: number; source?: string }[]).filter(
            (win) => !(win.source === 'reco' && win.round_no === v.roundNo),
          )
          if (member.win_history?.startsWith(`${v.roundNo}회`)) member.win_history = null
        }
        member.meta = nextMeta

        const roundLabel = `${spamSafeRound(v.roundNo)}회차`
        for (let i = db.sms_sends.length - 1; i >= 0; i--) {
          const sms = db.sms_sends[i]
          if (
            sms.member_id === v.memberId &&
            sms.type === 'recommend' &&
            (sms.sent_at === v.issuedAt || sms.body.includes(roundLabel))
          ) {
            db.sms_sends.splice(i, 1)
            deletedSms++
          }
        }
        db.logs.push(
          adminLog(user?.id ?? null, 'reco.issue_delete', v.memberId, {
            round_no: v.roundNo,
            issued_at: v.issuedAt,
            deleted_sms: deletedSms,
          }),
        )
      })
      return { deletedIssues: 1, deletedSms }
    },
    onSuccess: (_result, v) => {
      invalidate([v.memberId])
      qc.invalidateQueries({ queryKey: memberKeys.sms(v.memberId) })
      qc.invalidateQueries({ queryKey: ['weekly-reco-status'] })
    },
  })
}
