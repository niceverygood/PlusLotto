// 로그 5종 데이터 훅 (CLAUDE §9). logs 테이블을 kind 로 필터해 최신순 반환.
// 감사 화면이므로 항상 최신을 보장(staleTime 0 + refetchOnMount) — §8 액션이 적재한 레코드를
// 다른 모듈에서 별도 무효화 없이도 진입 시 즉시 보여준다.
import { useQuery } from '@tanstack/react-query'
import type { LogEntry, LogKind } from '@/types/db'
import { readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchTables } from '@/lib/db/remote'

export const logKeys = {
  all: ['logs'] as const,
  byKind: (kind: LogKind) => ['logs', kind] as const,
}

export function useLogs(kind: LogKind) {
  return useQuery({
    queryKey: logKeys.byKind(kind),
    queryFn: async (): Promise<LogEntry[]> => {
      const db = dataSource === 'supabase' ? await fetchTables(['logs']) : readDb()
      return db.logs
        .filter((l) => l.kind === kind)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
    },
    staleTime: 0,
    refetchOnMount: 'always',
  })
}
