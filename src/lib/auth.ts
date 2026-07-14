import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Role } from '@/types/db'
import { dataSource, supabase } from './supabase'
import { genId, mutateDb, nowIso, readDb } from './db/store'

// 세션·역할 (DECISIONS D1/Phase 2). mock 모드는 staff 레코드 기반 데모 로그인,
// supabase 모드는 supabase.auth(이메일/비번) 세션 → staff 레코드 해석.
// 컴포넌트는 훅(useCurrentUser/useRole)만 사용한다.

// 라이브 인증 규약: 운영자는 login_id 로 로그인하지만 Supabase Auth 는 email 을 요구한다.
// 따라서 '<login_id>@<도메인>' 합성 이메일로 auth.users 를 만들고 staff.auth_user_id 로 잇는다.
// 이미 '@' 가 포함된 식별자는 그대로 이메일로 본다. (docs/SUPABASE_MIGRATION.md 의 연결 SQL 참조)
const AUTH_EMAIL_DOMAIN = 'pluslotto.local'
function toAuthEmail(identifier: string): string {
  const id = identifier.trim()
  return id.includes('@') ? id : `${id.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`
}

export interface CurrentUser {
  id: string // staff.id (업무 키) — 앱 전역 FK·§8 의 기준. auth uid 가 아님.
  name: string
  loginId: string
  role: Role
  teamId: string | null
}

// staff 해석 결과 (mock Staff 와 supabase select 양쪽이 만족하는 부분집합).
interface StaffRow {
  id: string
  login_id: string
  name: string
  role: Role
  team_id: string | null
  is_active: boolean
}

export interface SignInResult {
  ok: boolean
  error?: string
}

interface SessionState {
  currentUser: CurrentUser | null
  /** loginId(또는 email) + 비밀번호로 로그인. */
  signIn: (identifier: string, password?: string) => Promise<SignInResult>
  signOut: () => Promise<void>
  /** 앱 부팅 시 호출 — supabase 모드에서 새로고침 후 세션 복원/검증. */
  restoreSession: () => Promise<void>
}

function toCurrentUser(s: StaffRow): CurrentUser {
  return { id: s.id, name: s.name, loginId: s.login_id, role: s.role, teamId: s.team_id }
}

// supabase 모드: auth uid → staff 레코드 해석 (RLS staff_read = 전원 읽기 허용).
async function resolveStaff(authUid: string): Promise<StaffRow | null> {
  if (!supabase) return null
  const { data } = await supabase
    .from('staff')
    .select('id, login_id, name, role, team_id, is_active')
    .eq('auth_user_id', authUid)
    .maybeSingle()
  return (data as StaffRow | null) ?? null
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      currentUser: null,

      async signIn(identifier, password) {
        if (dataSource === 'supabase' && supabase) {
          const { data, error } = await supabase.auth.signInWithPassword({
            email: toAuthEmail(identifier),
            password: password ?? '',
          })
          if (error || !data.user) {
            return { ok: false, error: error?.message ?? '로그인에 실패했습니다.' }
          }
          const staff = await resolveStaff(data.user.id)
          if (!staff) {
            await supabase.auth.signOut()
            return { ok: false, error: '연결된 운영자 계정이 없습니다. (staff.auth_user_id 미연결)' }
          }
          if (!staff.is_active) {
            await supabase.auth.signOut()
            return { ok: false, error: '비활성화된 계정입니다.' }
          }
          // §8: 로그인 → last_login_at 갱신 + 로그인 로그. staff write 는 admin 전용이라
          // security-definer RPC 로 본인 행만 갱신/적재한다. 로깅 실패는 로그인을 막지 않는다.
          try {
            await supabase.rpc('app_touch_login')
          } catch {
            /* best-effort */
          }
          set({ currentUser: toCurrentUser(staff) })
          return { ok: true }
        }

        // mock: staff.login_id 매칭
        const staff = readDb().staff.find(
          (s) => s.login_id.toLowerCase() === identifier.trim().toLowerCase(),
        )
        if (!staff) return { ok: false, error: '존재하지 않는 계정입니다.' }
        if (!staff.is_active) return { ok: false, error: '비활성화된 계정입니다.' }

        const ts = nowIso()
        // §8: 로그인 → staff.last_login_at 갱신 + admin_log 적재
        mutateDb((db) => {
          const row = db.staff.find((s) => s.id === staff.id)
          if (row) row.last_login_at = ts
          db.logs.push({
            id: genId('log'),
            kind: 'admin',
            actor: staff.id,
            action: 'auth.login',
            target_type: 'staff',
            target_id: staff.id,
            meta: {},
            created_at: ts,
          })
        })
        set({ currentUser: toCurrentUser(staff) })
        return { ok: true }
      },

      async signOut() {
        if (dataSource === 'supabase' && supabase) await supabase.auth.signOut()
        set({ currentUser: null })
      },

      async restoreSession() {
        if (dataSource !== 'supabase' || !supabase) return
        const { data } = await supabase.auth.getSession()
        const uid = data.session?.user?.id
        if (!uid) {
          set({ currentUser: null })
          return
        }
        const staff = await resolveStaff(uid)
        set({ currentUser: staff && staff.is_active ? toCurrentUser(staff) : null })
      },
    }),
    {
      name: 'pluslotto-session',
      partialize: (s) => ({ currentUser: s.currentUser }),
    },
  ),
)

export function useCurrentUser(): CurrentUser | null {
  return useSessionStore((s) => s.currentUser)
}

export function useRole(): Role | null {
  return useSessionStore((s) => s.currentUser?.role ?? null)
}

export function useSignIn() {
  return useSessionStore((s) => s.signIn)
}

export function useSignOut() {
  return useSessionStore((s) => s.signOut)
}
