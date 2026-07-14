// 운영자(staff)·팀 참조 데이터 — 여러 모듈이 담당자명/역할/팀을 해석할 때 공유.
// 컴포넌트는 useStaff/useTeams 훅, api 내부 로직은 동기 헬퍼를 쓴다.
import { useQuery } from '@tanstack/react-query'
import type { Role, Staff } from '@/types/db'
import { readDb } from './db/store'
import { dataSource } from './supabase'
import { fetchTables } from './db/remote'

export const staffKeys = {
  all: ['staff'] as const,
  teams: ['teams'] as const,
}

// staff/teams 는 RLS 상 전원 읽기 허용(0002_rls.sql staff_read/teams_read using(true)) —
// 담당자명·팀명 표시와 배정 드롭다운에 필요하므로 supabase 모드에서 라이브 조회로 분기한다.
export function useStaff() {
  return useQuery({
    queryKey: staffKeys.all,
    queryFn: async () =>
      dataSource === 'supabase' ? (await fetchTables(['staff'])).staff : readDb().staff,
  })
}

export function useTeams() {
  return useQuery({
    queryKey: staffKeys.teams,
    queryFn: async () =>
      dataSource === 'supabase' ? (await fetchTables(['teams'])).teams : readDb().teams,
  })
}

// ── 동기 헬퍼 (api 계층/필터 ctx 용 — 훅 아님) ───────────────────────────
export function staffById(): Record<string, Staff> {
  const out: Record<string, Staff> = {}
  for (const s of readDb().staff) out[s.id] = s
  return out
}

export function staffNameById(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of readDb().staff) out[s.id] = s.name
  return out
}

export function staffRoleById(): Record<string, Role> {
  const out: Record<string, Role> = {}
  for (const s of readDb().staff) out[s.id] = s.role
  return out
}

export function teamNameById(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of readDb().teams) out[t.id] = t.name
  return out
}

/** 배정 가능한 활성 운영자(담당 후보). */
export function activeStaff(): Staff[] {
  return readDb().staff.filter((s) => s.is_active)
}

/** 자동배분 후보(활성 rep 전체) — 실행 모달에서 풀을 그때그때 가감할 때 보여줄 목록(§V2-1). */
export function autoAssignCandidates(): Staff[] {
  return readDb().staff.filter((s) => s.is_active && s.role === 'rep')
}

/** 자동배분 기본 풀 — 활성 rep 중 '자동배분 대상' 플래그가 켜진 담당자만 라운드로빈(§V2-1). */
export function assignableReps(): Staff[] {
  return readDb().staff.filter((s) => s.is_active && s.role === 'rep' && s.auto_assign_enabled)
}
