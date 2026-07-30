// 통화예약 알림(현장 피드백 7/23) — 회원상세 <통화예약> 일시가 도래하면 AppShell 벨 알림에 노출.
// lib/todayDb.ts 와 동일한 mock/supabase 분기 패턴(§2, lib 경유 공유)을 재사용한다.
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Member } from '@/types/db'
import { readDb } from './db/store'
import { dataSource } from './supabase'
import { sb } from './db/remote'
import { useCurrentUser, type CurrentUser } from './auth'

// 우측하단 고정 팝업 켜기/끄기(현장 피드백 7/30) — 실무자마다 선호가 달라 브라우저별 로컬 설정으로
// 둔다(site_settings 전역 설정이 아님). 상단바 벨 배지/드롭다운은 이 설정과 무관하게 항상 동작한다.
const POPUP_PREF_KEY = 'call-reservation-popup-enabled'

export function useCallPopupEnabled(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabledState] = useState(() => localStorage.getItem(POPUP_PREF_KEY) !== '0')
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === POPUP_PREF_KEY) setEnabledState(e.newValue !== '0')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const setEnabled = (v: boolean) => {
    localStorage.setItem(POPUP_PREF_KEY, v ? '1' : '0')
    setEnabledState(v)
  }
  return [enabled, setEnabled]
}

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

/** call-reservation-alerts 쿼리 캐시 키(§8 — 예약 저장/삭제 시 이 키로 즉시 무효화). */
export const callReservationAlertsKey = ['call-reservation-alerts'] as const

/**
 * 통화예약 시각이 도래한 회원 목록 — AppShell 알림 벨(§8). 30초 폴링으로 갱신.
 * 현장 피드백(7/24) "예약 설정해도 알람이 안 울린다" 원인: 전역 QueryClient 기본값이
 * refetchOnWindowFocus:false 라 다른 탭/창을 보다 돌아와도 재확인하지 않았고, TanStack Query
 * 는 탭이 백그라운드면 refetchInterval 도 기본적으로 멈춘다 — 두 옵션을 이 쿼리에서만 켜서
 * 탭 전환 후 복귀·백그라운드 상태에서도 계속 확인하도록 한다.
 */
export function useCallReservationAlerts() {
  const user = useCurrentUser()
  return useQuery({
    queryKey: [...callReservationAlertsKey, user?.id ?? 'anon', user?.role ?? 'none'],
    queryFn: async (): Promise<CallReservationAlert[]> => {
      if (!user) return []
      if (dataSource === 'supabase') return fetchDueReservationsRemote(user)
      return dueReservations(readDb().members, user)
    },
    enabled: !!user,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  })
}
