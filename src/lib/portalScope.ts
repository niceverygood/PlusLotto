import type { Grade, Member, WeeklyRecoIssue } from '../types/db'
import { memberSite, SITE_SCOPES, type SiteScope } from './siteScope'

export type PortalSourceSite = Exclude<SiteScope, 'all'>
export const PORTAL_SITES = SITE_SCOPES.filter(
  (site): site is (typeof SITE_SCOPES)[number] & { key: PortalSourceSite } => site.key !== 'all',
)
export const DEFAULT_PORTAL_SITE: PortalSourceSite = 'pluslotto'

export function isPortalSourceSite(value: unknown): value is PortalSourceSite {
  return PORTAL_SITES.some((site) => site.key === value)
}

/** 로그인과 발송에서 사용하는 국내 휴대전화 표기를 동일하게 비교한다. */
export function normalizePortalPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  const international = digits.startsWith('0082') ? digits.slice(4) : digits.startsWith('82') ? digits.slice(2) : null
  return international === null ? digits : international && !international.startsWith('0') ? `0${international}` : international
}

export interface PortalMemberSession {
  name: string
  grade: Grade
  phone: string
  sourceSite: PortalSourceSite
  recos: WeeklyRecoIssue[]
}

type LoginMember = Pick<Member, 'name' | 'grade' | 'phone' | 'meta' | 'registered_at' | 'is_deleted' | 'is_withdrawn'>

/** 플러스의 기존 최신 가입자 선택은 사이트 안에서 유지하고, 이관 사이트의 모호한 선택은 거부한다. */
export function loginPortalMock(
  members: readonly LoginMember[], phone: string, password: string, sourceSite: unknown,
): PortalMemberSession | null {
  if (!isPortalSourceSite(sourceSite)) return null
  const domestic = normalizePortalPhone(phone)
  const pw = password.trim()
  if (!/^0[0-9]{8,10}$/.test(domestic) || !pw) return null
  const matches = members.filter((member) => memberSite(member.meta) === sourceSite
    && normalizePortalPhone(member.phone) === domestic && !member.is_deleted && !member.is_withdrawn)
  if (matches.length === 0 || (sourceSite !== 'pluslotto' && matches.length !== 1)) return null
  if (sourceSite === 'pluslotto') matches.sort((a, b) => Date.parse(b.registered_at) - Date.parse(a.registered_at))
  const member = matches[0]
  const storedPw = member.meta?.homepage_pw
  const expectedPw = typeof storedPw === 'string' ? storedPw : domestic.slice(-4)
  if (pw !== expectedPw) return null
  return {
    name: member.name, grade: member.grade, phone: domestic, sourceSite,
    recos: Array.isArray(member.meta?.weekly_recos) ? member.meta.weekly_recos as WeeklyRecoIssue[] : [],
  }
}

export const PORTAL_SESSION_KEY = 'site_member_v2'
const UNSCOPED_SESSION_KEY = 'site_member'
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function parseSession(raw: string | null): PortalMemberSession | null {
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object') return null
  const session = value as Record<string, unknown>
  if (typeof session.name !== 'string' || typeof session.grade !== 'string'
    || typeof session.phone !== 'string' || !isPortalSourceSite(session.sourceSite)) return null
  return {
    name: session.name, grade: session.grade as Grade, phone: session.phone,
    sourceSite: session.sourceSite, recos: Array.isArray(session.recos) ? session.recos as WeeklyRecoIssue[] : [],
  }
}

/** 이전 캐시는 어느 계약의 데이터인지 검증할 수 없으므로 새 세션으로 승격하지 않는다. */
export function loadPortalSession(storage: SessionStorage): PortalMemberSession | null {
  try {
    storage.removeItem(UNSCOPED_SESSION_KEY)
    const session = parseSession(storage.getItem(PORTAL_SESSION_KEY))
    if (!session) storage.removeItem(PORTAL_SESSION_KEY)
    return session
  } catch {
    return null
  }
}

export function savePortalSession(storage: SessionStorage, session: PortalMemberSession | null): void {
  try {
    storage.removeItem(UNSCOPED_SESSION_KEY)
    if (session && isPortalSourceSite(session.sourceSite)) storage.setItem(PORTAL_SESSION_KEY, JSON.stringify(session))
    else storage.removeItem(PORTAL_SESSION_KEY)
  } catch {
    // 저장소를 사용할 수 없으면 현재 탭의 메모리 세션만 사용한다.
  }
}
