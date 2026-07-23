// 통화예약 알림(현장 피드백 7/23) — 회원상세 <통화예약> 일시가 도래하면 AppShell 벨 알림에 노출.
// lib/todayDb.ts 와 동일한 mock/supabase 분기 패턴(§2, lib 경유 공유)을 재사용한다.
import { useQuery } from '@tanstack/react-query'
import type { Member } from '@/types/db'
import { readDb } from './db/store'
import { dataSource } from './supabase'
import { sb } from './db/remote'
import { useCurrentUser, type CurrentUser } from './auth'

export interface CallReservationAlert {
  member_id: string
  member_name: string
  phone: string
  reserved_at: string // ISO
}

type ReservationRow = Pick<Member, 'id' | 'name' | 'phone' | 'assigned_staff_id' | 'meta'>

/** 예약시각이 이미 지난(도래한) 건만 골라 이른 예약순으로 정렬. rep 는 본인 담당만. */
function dueReservations(members: readonly ReservationRow[], user: CurrentUser): CallReservationAlert[] {
  const nowMs = Date.now()
  const scoped = user.role === 'rep' ? members.filter((m) => m.assigned_staff_id === user.id) : members
  const out: CallReservationAlert[] = []
  for (const m of scoped) {
    const raw = m.meta?.call_reservation_at
    if (typeof raw !== 'string') continue
    const t = Date.parse(raw)
    if (!Number.isNaN(t) && t <= nowMs) out.push({ member_id: m.id, member_name: m.name, phone: m.phone, reserved_at: raw })
  }
  return out.sort((a, b) => Date.parse(a.reserved_at) - Date.parse(b.reserved_at))
}

async function fetchDueReservationsRemote(user: CurrentUser): Promise<CallReservationAlert[]> {
  let q = sb()
    .from('members')
    .select('id, name, phone, assigned_staff_id, meta')
    .not('meta->>call_reservation_at', 'is', null)
  if (user.role === 'rep') q = q.eq('assigned_staff_id', user.id)
  const { data, error } = await q
  if (error) throw error
  return dueReservations((data ?? []) as ReservationRow[], user)
}

/** 통화예약 시각이 도래한 회원 목록 — AppShell 알림 벨(§8). 60초 폴링으로 갱신. */
export function useCallReservationAlerts() {
  const user = useCurrentUser()
  return useQuery({
    queryKey: ['call-reservation-alerts', user?.id ?? 'anon', user?.role ?? 'none'],
    queryFn: async (): Promise<CallReservationAlert[]> => {
      if (!user) return []
      if (dataSource === 'supabase') return fetchDueReservationsRemote(user)
      return dueReservations(readDb().members, user)
    },
    enabled: !!user,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}
