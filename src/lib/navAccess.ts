// 권한 매트릭스(메뉴 노출) 읽기 훅. DB(nav_access)에 영속된 역할별 모듈 접근 맵을
// TanStack Query 로 노출 → 권한관리 화면에서 저장 시 사이드바가 즉시 반영(§8).
import { useQuery } from '@tanstack/react-query'
import { readDb } from './db/store'
import { dataSource } from './supabase'
import { fetchNavAccess } from './db/remote'
import { DEFAULT_NAV_ACCESS, type NavAccessMap } from './permissions'

export const navAccessKeys = { all: ['nav-access'] as const }

/** DB 의 권한 매트릭스(없으면 기본값). mock 동기 읽기 — 라우트 가드 정적 폴백에도 사용. */
export function readNavAccess(): NavAccessMap {
  return readDb().nav_access ?? DEFAULT_NAV_ACCESS
}

export function useNavAccess() {
  return useQuery({
    queryKey: navAccessKeys.all,
    queryFn: async () => (dataSource === 'supabase' ? await fetchNavAccess() : readNavAccess()),
  })
}
