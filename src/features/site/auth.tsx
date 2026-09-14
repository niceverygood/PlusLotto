// ─────────────────────────────────────────────────────────────────────────
// 플러스로또 고객 홈페이지 — 회원 인증 컨텍스트 (Phase 1 공유 기반)
// ─────────────────────────────────────────────────────────────────────────
// 운영콘솔(staff) 인증과 분리된 고객 세션. sourceSite를 포함한 v2 캐시만 복원한다.
// 양쪽 로그인 화면은 lib/portalLogin을 공유하며 사이트 안에서 기존 계약 선택 규칙을 적용한다.
// 비밀번호 규칙: member.meta.homepage_pw 우선, 없으면 전화번호 뒷 4자리(homepagePw).
//
// ── Phase2 가 쓸 export 시그니처 ─────────────────────────────────────────
//   <MemberAuthProvider>{children}</MemberAuthProvider>   // app/providers 안에서 1회 래핑
//   const { member, loading, login, logout, signup } = useMemberAuth()
//
//   member: SiteMember | null
//     SiteMember = {
//       name: string
//       grade: Grade           // 'simple'|'free'|'gold'|'goldp'|'vip'|'royal'|'ovr'|'toss'
//       phone: string          // 숫자만(로그인에 쓴 전화)
//       recos: WeeklyRecoIssue[]   // [{ round_no:number; issued_at:string; sets:number[][] }]
//     }
//   loading: boolean           // 초기 세션 복원 중 true
//   login(phone, pw, sourceSite?): Promise<{ ok:boolean; error?:string }>
//   logout(): void
//   signup(input): Promise<{ ok:boolean; error?:string }>   // SignupInput 아래 참조
//     - 실제 members INSERT 는 RLS(anon)+트리거(members_admin_ops)로 차단 → '가입문의' 폴백.
//     - ok:true 면 inquiries 로 가입문의 접수 완료, ok:false 면 error 안내(전화 가입 유도).
// ─────────────────────────────────────────────────────────────────────────
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { BRAND } from '@/lib/brand'
import { dataSource, supabase } from '@/lib/supabase'
import { loginPortal } from '@/lib/portalLogin'
import {
  DEFAULT_PORTAL_SITE, loadPortalSession, savePortalSession,
  type PortalMemberSession, type PortalSourceSite,
} from '@/lib/portalScope'

// ── 공개 타입 ────────────────────────────────────────────────────────────
export type SiteMember = PortalMemberSession

export interface SignupInput {
  name: string
  phone: string
  /** 선택: 추천인/유입경로 메모 등(가입문의 본문에 첨부). */
  memo?: string
}

export interface AuthResult {
  ok: boolean
  error?: string
}

export interface MemberAuthValue {
  member: SiteMember | null
  loading: boolean
  login: (phone: string, pw: string, sourceSite?: PortalSourceSite) => Promise<AuthResult>
  logout: () => void
  signup: (input: SignupInput) => Promise<AuthResult>
}

const digits = (s: string): string => s.replace(/\D/g, '')

// ── 세션 영속화(localStorage) ────────────────────────────────────────────
function loadSession(): SiteMember | null {
  try {
    return loadPortalSession(localStorage)
  } catch {
    return null
  }
}

function saveSession(m: SiteMember | null): void {
  try {
    savePortalSession(localStorage, m)
  } catch {
    /* private 모드 등 — 무시(메모리 세션만 유지) */
  }
}

// ── 회원가입 코어 ─────────────────────────────────────────────────────────
// signupApproach = "가입문의(inquiry) 폼".
// 이유: ① 고객 사이트는 anon 키 → members INSERT 는 RLS(0002: members 정책 to authenticated)에
//   걸려 애초에 불가. ② 설령 authenticated 라도 0003 트리거(members_admin_ops)가 비-admin INSERT 차단.
//   → 셀프 가입은 불가하므로, 운영자가 후처리하도록 '가입문의'를 inquiries 에 남기는 폴백.
// 그런데 inquiries RLS 도 to authenticated 라 anon insert 가 막힐 가능성이 높다.
//   막히면 graceful 에러(전화 가입 안내)로 폴백한다 — 화면이 죽지 않게.
async function doSignup(input: SignupInput): Promise<AuthResult> {
  const name = input.name.trim()
  const d = digits(input.phone)
  if (!name) return { ok: false, error: '이름을 입력해주세요.' }
  if (d.length < 9) return { ok: false, error: '올바른 전화번호를 입력해주세요.' }

  const body = [
    `이름: ${name}`,
    `연락처: ${d}`,
    input.memo?.trim() ? `메모: ${input.memo.trim()}` : null,
    `경로: ${BRAND.name} 홈페이지 가입문의`,
  ]
    .filter(Boolean)
    .join('\n')

  if (dataSource === 'supabase' && supabase) {
    try {
      const { error } = await supabase.from('inquiries').insert({
        member_id: null,
        author_name: name,
        category: '가입문의',
        title: '홈페이지 회원가입 신청',
        body,
        status: 'open',
      })
      // RLS(anon) 거부 등 → graceful 폴백
      if (error) {
        return {
          ok: false,
          error:
            '온라인 가입 신청이 일시적으로 어렵습니다. 고객센터로 전화 주시면 바로 가입을 도와드립니다.',
        }
      }
      return { ok: true }
    } catch {
      return {
        ok: false,
        error:
          '온라인 가입 신청이 일시적으로 어렵습니다. 고객센터로 전화 주시면 바로 가입을 도와드립니다.',
      }
    }
  }

  // mock: 항상 접수 성공으로 간주(실제 저장은 하지 않음 — 데모)
  return { ok: true }
}

// ── 컨텍스트 ──────────────────────────────────────────────────────────────
const MemberAuthContext = createContext<MemberAuthValue | null>(null)

export function MemberAuthProvider({ children }: { children: ReactNode }) {
  const [member, setMember] = useState<SiteMember | null>(null)
  const [loading, setLoading] = useState(true)

  // 초기 세션 복원
  useEffect(() => {
    setMember(loadSession())
    setLoading(false)
  }, [])

  const login = useCallback(async (phone: string, pw: string, sourceSite: PortalSourceSite = DEFAULT_PORTAL_SITE): Promise<AuthResult> => {
    // 다른 사이트의 로그인 실패 후 이전 계약 데이터가 계속 표시되지 않게 비운다.
    setMember(null)
    saveSession(null)
    try {
      const m = await loginPortal(phone, pw, sourceSite)
      if (!m) return { ok: false, error: '선택한 서비스의 회원 정보와 일치하지 않습니다. 서비스와 전화번호, 비밀번호를 확인해주세요.' }
      setMember(m)
      saveSession(m)
      return { ok: true }
    } catch {
      return { ok: false, error: '일시적인 오류입니다. 잠시 후 다시 시도해주세요.' }
    }
  }, [])

  const logout = useCallback((): void => {
    setMember(null)
    saveSession(null)
  }, [])

  const signup = useCallback((input: SignupInput) => doSignup(input), [])

  const value = useMemo<MemberAuthValue>(
    () => ({ member, loading, login, logout, signup }),
    [member, loading, login, logout, signup],
  )

  return <MemberAuthContext.Provider value={value}>{children}</MemberAuthContext.Provider>
}

/** 고객 사이트 회원 인증 훅. <MemberAuthProvider> 하위에서만 사용. */
export function useMemberAuth(): MemberAuthValue {
  const ctx = useContext(MemberAuthContext)
  if (!ctx) throw new Error('useMemberAuth must be used within <MemberAuthProvider>')
  return ctx
}
