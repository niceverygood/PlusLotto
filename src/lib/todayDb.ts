// 금일 배분 디비 수량(전체/수동/자동) — 관리자 화면 + 자동할당 모달 양쪽에서 공유(현장 피드백:
// "자동할당시 리스트에도 표현, 지금은 관리자 리스트에만 있음"). lib/ 경유로 두 feature 가 함께 쓴다(§2).
import { useQuery } from '@tanstack/react-query'
import { readDb } from './db/store'
import { dataSource } from './supabase'
import { sb } from './db/remote'

export interface TodayDbCount {
  total: number
  manual: number
  auto: number
}

function isToday(iso: string): boolean {
  const d = new Date(iso)
  const n = new Date()
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  )
}

/** 오늘 배정 이력을 staff_id 별 {전체/수동/자동} 으로 집계. */
export function tallyTodayDb(
  assignments: readonly { staff_id: string | null; type: 'manual' | 'auto'; created_at: string }[],
): Record<string, TodayDbCount> {
  const out: Record<string, TodayDbCount> = {}
  for (const a of assignments) {
    if (!a.staff_id || !isToday(a.created_at)) continue
    const cur = out[a.staff_id] ?? { total: 0, manual: 0, auto: 0 }
    cur.total += 1
    if (a.type === 'auto') cur.auto += 1
    else cur.manual += 1
    out[a.staff_id] = cur
  }
  return out
}

async function fetchTodayDbCountsRemote(): Promise<Record<string, TodayDbCount>> {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const { data, error } = await sb()
    .from('assignments')
    .select('staff_id, type, created_at')
    .gte('created_at', start.toISOString())
  if (error) throw error
  return tallyTodayDb(
    (data ?? []) as { staff_id: string | null; type: 'manual' | 'auto'; created_at: string }[],
  )
}

/** 관리자별 금일 디비 수량(전체/수동/자동). 관리자 화면·자동할당 모달 표시용. */
export function useTodayDbCounts() {
  return useQuery({
    queryKey: ['today-db-counts'],
    queryFn: async (): Promise<Record<string, TodayDbCount>> => {
      if (dataSource === 'supabase') return fetchTodayDbCountsRemote()
      return tallyTodayDb(readDb().assignments)
    },
  })
}
