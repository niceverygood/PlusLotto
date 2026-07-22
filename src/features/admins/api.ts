// 관리자(운영자 계정·권한 매트릭스) 데이터 훅 (CLAUDE §5·§8). 전부 TanStack Query 경유.
// 계정 생성/수정/활성토글 + 권한 매트릭스 저장 → mock DB 변경 + admin 로그 적재 후 무효화.
// TODO(live-verify): 실제 환경의 계정 비밀번호 설정·인증 규칙 미확인 → mock 은 비밀번호 없음(로그인 ID 기반).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LogEntry, Role, Staff } from '@/types/db'
import { genId, mutateDb, nowIso, readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { useCurrentUser } from '@/lib/auth'
import { staffKeys } from '@/lib/staff'
import * as supa from './supa'
import { CALL_VOLUME_ALERT_DEFAULT, tallyCallVolume } from '@/lib/callVolume'
import { navAccessKeys } from '@/lib/navAccess'
import { assignableRoles, canManageStaff, type NavAccessMap } from '@/lib/permissions'
export { tallyTodayDb, useTodayDbCounts, type TodayDbCount } from '@/lib/todayDb'

function adminLog(
  actor: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  meta: Record<string, unknown> = {},
): LogEntry {
  return {
    id: genId('log'),
    kind: 'admin',
    actor,
    action,
    target_type: targetType,
    target_id: targetId,
    meta,
    created_at: nowIso(),
  }
}

export interface StaffInput {
  name: string
  login_id: string
  role: Role
  team_id: string | null
  is_active: boolean
  auto_assign_enabled: boolean // 자동배분 대상 풀 포함(rep 한정, §V2-1)
}

/** 이번 달 발신 통화량(상담상태 변경 건수 근사) + 경고 임계치(현장 피드백 7/3). */
export function useCallVolumeStatus() {
  return useQuery({
    queryKey: ['call-volume-status'],
    queryFn: async () => {
      if (dataSource === 'supabase') return supa.fetchCallVolumeStatus()
      const db = readDb()
      const count = tallyCallVolume(db.logs)
      const threshold = db.site_settings.call_volume_alert_threshold ?? CALL_VOLUME_ALERT_DEFAULT
      return { count, threshold, over: count > threshold }
    },
  })
}

/** 운영자 계정 생성/수정. login_id 중복은 거부(throw)한다. */
export function useSaveStaff() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id?: string; input: StaffInput }) => {
      if (dataSource === 'supabase') return supa.saveStaff(v, user?.id ?? null)
      // 계층 위임 가드(§5) — mock 검증. TODO(live-verify): live 는 RLS 로 동일 계층 가드 적용(M단계).
      if (!user) throw new Error('로그인이 필요합니다.')
      if (!assignableRoles(user.role).includes(v.input.role))
        throw new Error('이 역할을 부여할 권한이 없습니다.')
      if (v.id) {
        const target = readDb().staff.find((s) => s.id === v.id)
        if (!target) throw new Error('대상 계정을 찾을 수 없습니다.')
        if (!canManageStaff(user, target)) throw new Error('이 계정을 수정할 권한이 없습니다.')
        if (v.id === user.id && v.input.role !== target.role)
          throw new Error('본인 역할은 변경할 수 없습니다.')
      }
      const login = v.input.login_id.trim()
      const dup = readDb().staff.find(
        (s) => s.login_id.toLowerCase() === login.toLowerCase() && s.id !== v.id,
      )
      if (dup) throw new Error('이미 사용 중인 로그인 ID 입니다.')
      const id = v.id ?? genId('staff')
      const name = v.input.name.trim()
      // admin 은 팀 소속 없음(전체 관리).
      const team_id = v.input.role === 'admin' ? null : v.input.team_id
      mutateDb((db) => {
        if (v.id) {
          const s = db.staff.find((x) => x.id === v.id)
          if (!s) return
          Object.assign(s, { name, login_id: login, role: v.input.role, team_id, is_active: v.input.is_active, auto_assign_enabled: v.input.auto_assign_enabled })
          db.logs.push(adminLog(user?.id ?? null, 'staff.update', 'staff', v.id, { name, role: v.input.role }))
        } else {
          const s: Staff = { id, login_id: login, name, role: v.input.role, team_id, is_active: v.input.is_active, auto_assign_enabled: v.input.auto_assign_enabled, last_login_at: null }
          db.staff.push(s)
          db.logs.push(adminLog(user?.id ?? null, 'staff.create', 'staff', id, { name, role: v.input.role, login_id: login }))
        }
      })
      return id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: staffKeys.all }),
  })
}

/** 계정 활성/비활성 토글(삭제 대신 비활성으로 운영). */
export function useToggleStaffActive() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; active: boolean }) => {
      if (dataSource === 'supabase') return supa.toggleStaffActive(v.id, v.active, user?.id ?? null)
      // 계층 위임 가드(§5) — 본인·관리 불가 대상은 토글 거부.
      if (!user) throw new Error('로그인이 필요합니다.')
      if (v.id === user.id) throw new Error('본인 계정은 변경할 수 없습니다.')
      const target = readDb().staff.find((s) => s.id === v.id)
      if (!target) throw new Error('대상 계정을 찾을 수 없습니다.')
      if (!canManageStaff(user, target)) throw new Error('이 계정을 변경할 권한이 없습니다.')
      mutateDb((db) => {
        const s = db.staff.find((x) => x.id === v.id)
        if (!s) return
        s.is_active = v.active
        db.logs.push(adminLog(user?.id ?? null, v.active ? 'staff.activate' : 'staff.deactivate', 'staff', v.id, { name: s.name }))
      })
      return v.id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: staffKeys.all }),
  })
}

/** 권한 매트릭스 저장 → 사이드바/가드가 즉시 반영(§8). 맵은 깊은 복제해 참조 공유를 막는다. */
export function useSaveNavAccess() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (map: NavAccessMap) => {
      if (dataSource === 'supabase') return supa.saveNavAccess(map, user?.id ?? null)
      const next: NavAccessMap = {}
      for (const [k, v] of Object.entries(map)) next[k] = [...v]
      mutateDb((db) => {
        db.nav_access = next
        db.logs.push(adminLog(user?.id ?? null, 'roles.update', 'nav_access', null, { modules: Object.keys(next).length }))
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: navAccessKeys.all }),
  })
}

// ── 통화녹음 자동업로드 미매칭 보관함(현장 피드백 7/3·7/6) ──────────────────────────
// Android 동반 앱이 전화번호로 회원을 못 찾은 녹음 → 여기서 검색해 수동으로 연결.
export interface UnmatchedRecording {
  id: string
  raw_phone: string
  normalized_phone: string
  recorded_at: string | null
  file_path: string
  file_name: string
  uploaded_by: string | null
  created_at: string
}

/** mock 모드는 Android 앱 자체가 없어 미매칭 데이터가 생기지 않는다(라이브 전용 기능). */
export function useUnmatchedRecordings() {
  return useQuery({
    queryKey: ['unmatched-call-recordings'],
    queryFn: async (): Promise<UnmatchedRecording[]> =>
      dataSource === 'supabase' ? supa.fetchUnmatchedRecordings() : [],
  })
}

export function useUnmatchedRecordingUrl() {
  return useMutation({
    mutationFn: async (filePath: string) => supa.signUnmatchedRecordingUrl(filePath),
  })
}

/** 검색어로 회원 후보 조회(이름/전화/로그인ID) — '회원에게 연결' 드롭다운용, 최대 8건. */
export interface MemberLite {
  id: string
  name: string
  phone: string
  user_id: string
}
export function useSearchMembersLite(q: string) {
  return useQuery({
    queryKey: ['members-lite-search', q],
    queryFn: async (): Promise<MemberLite[]> => {
      const needle = q.trim()
      if (!needle) return []
      if (dataSource === 'supabase') return supa.searchMembersLite(needle)
      const lower = needle.toLowerCase()
      return readDb()
        .members.filter(
          (m) => m.name.toLowerCase().includes(lower) || m.phone.includes(needle) || m.user_id.toLowerCase().includes(lower),
        )
        .slice(0, 8)
        .map((m) => ({ id: m.id, name: m.name, phone: m.phone, user_id: m.user_id }))
    },
    enabled: q.trim().length > 0,
  })
}

/** 미매칭 녹음을 회원에 연결 — 그 회원 meta.call_recordings 에 append + 미매칭 목록에서 제거. */
export function useResolveUnmatchedRecording() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { rec: UnmatchedRecording; memberId: string }) => {
      if (dataSource !== 'supabase') throw new Error('라이브(Supabase) 모드에서만 지원됩니다.')
      await supa.resolveUnmatchedRecording(v.rec, v.memberId, user?.id ?? null)
      return v.memberId
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['unmatched-call-recordings'] }),
  })
}
