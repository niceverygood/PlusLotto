// 사이드바 실시간 뱃지 (CLAUDE §8 — 하드코딩 금지). '처리 필요' 신호만 노출한다:
// 결제대기(역할 스코프) · 미답변 문의(공유 큐). 사이드바는 상주(remount 없음)하므로
// refetchOnMount 대신 operationalKeys invalidate와 60초 안전 폴링으로 갱신한다.
// 결제 승인·문의 답변 시 즉시 갱신되고, 다른 운영자의 변경도 최대 1분 내 반영된다(§8).
import { useQuery } from '@tanstack/react-query'
import type { Member } from '@/types/db'
import { readDb, type DbShape } from './db/store'
import { dataSource } from './supabase'
import { sb } from './db/remote'
import { useCurrentUser, type CurrentUser } from './auth'
import { operationalKeys } from './queryKeys'
import type { NavKey } from './permissions'

// 결제대기 건수 — 매출과 달리 rep 도 본인 담당분을 본다(개인 처리대기 신호).
function scopedWaitCount(user: CurrentUser, db: Pick<DbShape, 'members' | 'payments'>): number {
  const wait = db.payments.filter((p) => p.status === 'wait')
  if (user.role === 'admin' || user.role === 'manager' || user.role === 'leader') return wait.length
  const byId: Record<string, Member> = {}
  for (const m of db.members) byId[m.id] = m
  return wait.filter((p) => byId[p.member_id]?.assigned_staff_id === user.id).length
}

function openInquiryCount(db: Pick<DbShape, 'inquiries'>): number {
  return db.inquiries.filter((i) => i.status === 'open').length
}

/** 사이드바 모듈별 뱃지 카운트(0/로딩은 생략). admins·logs 는 뱃지 대신 '관' 칩 유지 → 제외. */
export function useNavBadges(): Partial<Record<NavKey, number>> {
  const user = useCurrentUser()
  const scope = `nav:${user?.role ?? 'none'}:${user?.id ?? 'anon'}`

  const badges = useQuery({
    queryKey: operationalKeys.navBadges(scope),
    queryFn: async () => {
      if (!user) return { payments: 0, support: 0 }
      if (dataSource === 'supabase') {
        const { data, error } = await sb().rpc('admin_nav_badges')
        if (error) throw error
        const result = data as { payments?: number; support?: number } | null
        return { payments: Number(result?.payments ?? 0), support: Number(result?.support ?? 0) }
      }
      const db = readDb()
      return { payments: scopedWaitCount(user, db), support: openInquiryCount(db) }
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const out: Partial<Record<NavKey, number>> = {}
  if (badges.data?.payments) out.payments = badges.data.payments
  if (badges.data?.support) out.support = badges.data.support
  return out
}
