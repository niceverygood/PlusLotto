// 이용자 26 세그먼트 (CLAUDE §7) — 별도 화면이 아니라 필터 프리셋 배열.
// MembersPage 1개가 ?view= 로 프리셋을 적용한다. 의미 모호한 세그먼트
// (오늘다비·재시도·중복유입)는 합리적으로 정의하고 docs/ASSUMPTIONS.md 에 기록.
import type { Grade, Member, MemberStatus, Role } from '@/types/db'
import { CONSULT_STATUSES, type ConsultStatus } from '@/lib/consultStatus'

export { CONSULT_STATUSES, type ConsultStatus }

// ── 필터 스펙 (모든 세그먼트가 이 형태의 술어 집합으로 표현된다) ──────────
export interface MemberFilter {
  status?: MemberStatus
  grade?: Grade
  gradeIn?: readonly Grade[]
  hasStaff?: boolean // true=배정됨, false=담당미지정
  assignedStaffId?: string // 특정 담당자(FilterBar)
  staffRole?: Extract<Role, 'manager' | 'leader'> // 담당 staff 의 역할(실장/팀장담당)
  is_suspended?: boolean
  is_deleted?: boolean
  is_withdrawn?: boolean
  hasWin?: boolean
  hasMemo?: boolean
  outcall?: boolean // 아웃콜 처리 여부
  tendency?: string
  inflowCode?: string
  inflowType?: string // 유입구분(콜 단계) 필터 — 현장 피드백
  consultStatus?: string // 상담상태 필터 — 현장 피드백
  registeredToday?: boolean
  registeredFrom?: string // 가입일 범위(YYYY-MM-DD, 포함) — 현장 피드백
  registeredTo?: string
  dupPhone?: boolean // 전화번호 중복 입력된 디비만 — 현장 피드백
  inactiveDays?: number // last_active 가 N일 이상 경과(또는 한 번도 미접속)
  dupInflow?: 'today' | 'all' // 동일 유입코드가 2건 이상
  retry?: boolean // 아웃콜 완료했으나 미전환(재접촉 대상) — 추정 정의
  search?: string // 통합검색: ID·이름·닉·전화
}

// 유입구분(=유입분류) — 현장 피드백(2026-06): 채널명(네이버/카카오)이 아니라
// "콜 단계/DB구분" 분류로 운영한다. inflow_code(채널)와 별개. DECISIONS.md 참조.
export const INFLOW_TYPES = ['신규', '하루전부재', '하루전거절', '이틀전', '삼일전', '구디비'] as const
export type InflowType = (typeof INFLOW_TYPES)[number]

// 페이지당 행 수 옵션(현장 피드백) — 50 고정 → 선택형.
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200, 500, 1000] as const
export const DEFAULT_PAGE_SIZE = 50

// 성향 — 현장 피드백(2026-07-03): 좋음/보통/나쁨으로 재정의(기존 자유값도 그대로 표시됨, 자유텍스트 컬럼).
export const TENDENCIES = ['좋음', '보통', '나쁨'] as const
export type Tendency = (typeof TENDENCIES)[number]

// 연령대·성별 — 현장 피드백(2026-07-03). member.meta.age_band / member.meta.gender 로 저장.
export const AGE_BANDS = ['40미만', '40~70', '70이상'] as const
export type AgeBand = (typeof AGE_BANDS)[number]
export const GENDERS = ['남', '여'] as const
export type Gender = (typeof GENDERS)[number]

// 민원관리 — 현장 피드백(2026-07-06). member.meta.complaints[] 로 누적 저장(리스트형, 메모와 동일 패턴).
export const COMPLAINT_TYPES = ['카드', '경찰', '소보원'] as const
export type ComplaintType = (typeof COMPLAINT_TYPES)[number]
export const COMPLAINT_RESULTS = ['성공', '실패'] as const
export type ComplaintResult = (typeof COMPLAINT_RESULTS)[number]

export type ViewGroup = '상태' | '등급' | '담당' | '유입' | '운영'

export interface MemberView {
  key: string
  label: string
  filter: MemberFilter
  tab?: boolean // 상단 탭 노출(자주 쓰는 6개)
  group?: ViewGroup // '더보기' 드롭다운 그룹
  hint?: string // 추정 정의(라이브 확인 대상) 툴팁
}

// 기본값은 status=active(정상)만 보이도록 하는 게 운영상 자연스럽지만,
// 삭제/탈퇴/정지 세그먼트를 그대로 보여줘야 하므로 뷰별로 명시한다.
export const MEMBER_VIEWS: readonly MemberView[] = [
  // ── 탭 (자주 쓰는 6개) ─────────────────────────────
  { key: 'all', label: '전체', filter: {}, tab: true },
  { key: 'today-join', label: '오늘가입', filter: { registeredToday: true }, tab: true },
  {
    key: 'paid',
    label: '유료',
    filter: { gradeIn: ['gold', 'goldp', 'vip', 'royal'] },
    tab: true,
  },
  { key: 'no-staff', label: '담당미지정', filter: { hasStaff: false }, tab: true },
  {
    key: 'no-outcall-new',
    label: '미아웃콜(신규)',
    filter: { outcall: false, registeredToday: true },
    tab: true,
    hint: '오늘 가입했고 아직 아웃콜하지 않은 회원',
  },
  { key: 'winner', label: '당첨자', filter: { hasWin: true }, tab: true },

  // ── 상태 ──────────────────────────────────────────
  { key: 'normal', label: '정상', filter: { status: 'active' }, group: '상태' },
  { key: 'suspended', label: '정지', filter: { is_suspended: true }, group: '상태' },
  { key: 'deleted', label: '삭제목록', filter: { is_deleted: true }, group: '상태' },
  { key: 'withdrawn', label: '탈퇴목록', filter: { is_withdrawn: true }, group: '상태' },

  // ── 등급 ──────────────────────────────────────────
  { key: 'free', label: '무료', filter: { grade: 'free' }, group: '등급' },
  { key: 'simple', label: '간편가입', filter: { grade: 'simple' }, group: '등급' },
  { key: 'gold', label: '골드회원', filter: { gradeIn: ['gold', 'goldp'] }, group: '등급' },
  { key: 'vip-royal', label: 'VIP·로얄', filter: { gradeIn: ['vip', 'royal'] }, group: '등급' },
  {
    key: 'ovr',
    label: '인반언스',
    filter: { grade: 'ovr' },
    group: '등급',
    hint: '명칭/의미 미확인 — 라이브 확인 대상',
  },
  {
    key: 'toss',
    label: '토스DB',
    filter: { grade: 'toss' },
    group: '등급',
    hint: '등급인지 유입분류인지 미확인',
  },

  // ── 담당 ──────────────────────────────────────────
  {
    key: 'manager-own',
    label: '실장담당',
    filter: { staffRole: 'manager' },
    group: '담당',
    hint: '담당자가 실장(manager) 역할인 회원',
  },
  {
    key: 'leader-own',
    label: '팀장담당',
    filter: { staffRole: 'leader' },
    group: '담당',
    hint: '담당자가 팀장(leader) 역할인 회원',
  },

  // ── 유입 ──────────────────────────────────────────
  {
    key: 'dup-today',
    label: '중복유입(오늘)',
    filter: { dupInflow: 'today' },
    group: '유입',
    hint: '오늘 가입 중 동일 유입코드가 2건 이상인 회원',
  },
  {
    key: 'dup-all',
    label: '중복유입(전체)',
    filter: { dupInflow: 'all' },
    group: '유입',
    hint: '전체에서 동일 유입코드가 2건 이상인 회원',
  },

  // ── 운영 ──────────────────────────────────────────
  {
    key: 'today-dabi',
    label: '오늘 다비',
    filter: { registeredToday: true, hasStaff: true },
    group: '운영',
    hint: '"다비" 의미 미확인 → 오늘 가입 + 담당 배정 완료 건으로 가정',
  },
  {
    key: 'retry',
    label: '재시도',
    filter: { retry: true },
    group: '운영',
    hint: '의미 미확인 → 아웃콜 완료했으나 미전환(무료·간편) 재접촉 대상으로 가정',
  },
  { key: 'has-memo', label: '메모있음', filter: { hasMemo: true }, group: '운영' },
  {
    key: 'tendency-active',
    label: '적극성향',
    filter: { tendency: '적극' },
    group: '운영',
  },
  { key: 'no-outcall-all', label: '미아웃콜(전체)', filter: { outcall: false }, group: '운영' },
  {
    key: 'long-inactive',
    label: '장기미접속',
    filter: { inactiveDays: 30 },
    group: '운영',
    hint: '30일 이상 미접속(또는 한 번도 접속 안 함)',
  },
] as const

export const TAB_VIEWS = MEMBER_VIEWS.filter((v) => v.tab)
export const MORE_VIEWS = MEMBER_VIEWS.filter((v) => !v.tab)
const VIEW_BY_KEY = new Map(MEMBER_VIEWS.map((v) => [v.key, v]))

export function getView(key: string | null | undefined): MemberView {
  return (key && VIEW_BY_KEY.get(key)) || MEMBER_VIEWS[0]
}

// ── 필터 적용 (순수 함수) ─────────────────────────────────────────────
export interface MemberFilterCtx {
  now: number
  staffRoleById: Record<string, Role> // 담당 staff 역할 해석용(실장/팀장담당)
}

function isSameDay(iso: string, nowMs: number): boolean {
  const d = new Date(iso)
  const n = new Date(nowMs)
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  )
}

function normalizePhone(s: string): string {
  return s.replace(/\D/g, '')
}

/** 동일 유입코드가 2건 이상인 코드 집합. (중복유입 세그먼트용) */
function dupInflowCodes(members: readonly Member[], scope: 'today' | 'all', nowMs: number): Set<string> {
  const counts = new Map<string, number>()
  for (const m of members) {
    if (!m.inflow_code) continue
    if (scope === 'today' && !isSameDay(m.registered_at, nowMs)) continue
    counts.set(m.inflow_code, (counts.get(m.inflow_code) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const [code, c] of counts) if (c > 1) out.add(code)
  return out
}

function matchesSearch(m: Member, q: string): boolean {
  const t = q.trim().toLowerCase()
  if (!t) return true
  const digits = normalizePhone(t)
  if (digits && normalizePhone(m.phone).includes(digits)) return true
  return (
    m.user_id.toLowerCase().includes(t) ||
    m.name.toLowerCase().includes(t) ||
    (m.nickname?.toLowerCase().includes(t) ?? false)
  )
}

/** 과거 실제 중복행의 전화번호 집합 — 신규 중복 차단 이후에는 meta.dup_phone 표시도 함께 본다. */
function dupPhoneSet(members: readonly Member[]): Set<string> {
  const counts = new Map<string, number>()
  for (const m of members) {
    const d = normalizePhone(m.phone)
    if (!d) continue
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const [d, c] of counts) if (c > 1) out.add(d)
  return out
}

// 가입일 범위 비교용 — registered_at(ISO) → 로컬 YYYY-MM-DD.
function localDateStr(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 세그먼트 필터 + 통합검색을 멤버 배열에 적용한다. RLS(역할 데이터 스코프)는 api 계층에서 별도 처리. */
export function filterMembers(
  members: readonly Member[],
  filter: MemberFilter,
  ctx: MemberFilterCtx,
): Member[] {
  const dupSet = filter.dupInflow ? dupInflowCodes(members, filter.dupInflow, ctx.now) : null
  const dupPhones = filter.dupPhone ? dupPhoneSet(members) : null

  return members.filter((m) => {
    if (filter.status && m.status !== filter.status) return false
    if (filter.grade && m.grade !== filter.grade) return false
    if (filter.gradeIn && !filter.gradeIn.includes(m.grade)) return false
    if (filter.hasStaff === true && !m.assigned_staff_id) return false
    if (filter.hasStaff === false && m.assigned_staff_id) return false
    if (filter.assignedStaffId && m.assigned_staff_id !== filter.assignedStaffId) return false
    if (filter.staffRole) {
      const role = m.assigned_staff_id ? ctx.staffRoleById[m.assigned_staff_id] : undefined
      if (role !== filter.staffRole) return false
    }
    if (filter.is_suspended !== undefined && m.is_suspended !== filter.is_suspended) return false
    if (filter.is_deleted !== undefined && m.is_deleted !== filter.is_deleted) return false
    if (filter.is_withdrawn !== undefined && m.is_withdrawn !== filter.is_withdrawn) return false
    if (filter.hasWin === true && !m.win_history) return false
    if (filter.hasMemo === true && !m.memo) return false
    if (filter.outcall !== undefined && m.outcall_done !== filter.outcall) return false
    if (filter.tendency && m.tendency !== filter.tendency) return false
    if (filter.inflowCode && m.inflow_code !== filter.inflowCode) return false
    if (filter.inflowType && m.inflow_type !== filter.inflowType) return false
    if (filter.consultStatus && m.consult_status !== filter.consultStatus) return false
    if (filter.registeredToday && !isSameDay(m.registered_at, ctx.now)) return false
    if (filter.registeredFrom || filter.registeredTo) {
      const d = localDateStr(m.registered_at)
      if (filter.registeredFrom && d < filter.registeredFrom) return false
      if (filter.registeredTo && d > filter.registeredTo) return false
    }
    if (dupPhones && !dupPhones.has(normalizePhone(m.phone)) && m.meta.dup_phone !== true) return false
    if (filter.inactiveDays !== undefined) {
      const last = m.last_active_at ? Date.parse(m.last_active_at) : null
      const inactive = last === null || ctx.now - last >= filter.inactiveDays * 864e5
      if (!inactive) return false
    }
    if (dupSet && !(m.inflow_code && dupSet.has(m.inflow_code))) return false
    if (filter.retry === true) {
      const isUnconverted = m.grade === 'free' || m.grade === 'simple'
      if (!(m.outcall_done && isUnconverted)) return false
    }
    if (filter.search && !matchesSearch(m, filter.search)) return false
    return true
  })
}
