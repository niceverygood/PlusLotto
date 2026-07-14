// 사이드바 실시간 뱃지 (CLAUDE §8 — 하드코딩 금지). '처리 필요' 신호만 노출한다:
// 결제대기(역할 스코프) · 미답변 문의(공유 큐). 사이드바는 상주(remount 없음)하므로
// refetchOnMount 가 아니라 invalidate 로 갱신된다 → 기존 §8 무효화(paymentKeys/supportKeys)에
// 얹히도록 같은 키 프리픽스 아래(다른 scope)에 둔다. 결제 승인·문의 답변 시 즉시 갱신(§8).
import { useQuery } from '@tanstack/react-query'
import type { Member } from '@/types/db'
import { readDb, type DbShape } from './db/store'
import { dataSource } from './supabase'
import { fetchTables } from './db/remote'
import { useCurrentUser, type CurrentUser } from './auth'
import { paymentKeys, supportKeys } from './queryKeys'
import type { NavKey } from './permissions'

// 결제대기 건수 — 매출과 달리 rep 도 본인 담당분을 본다(개인 처리대기 신호).
function scopedWaitCount(user: CurrentUser, db: Pick<DbShape, 'members' | 'payments'>): number {
  const wait = db.payments.filter((p) => p.status === 'wait')
  if (user.role === 'admin' || user.role === 'manager') return wait.length
  const byId: Record<string, Member> = {}
  for (const m of db.members) byId[m.id] = m
  if (user.role === 'leader')
    return wait.filter((p) => byId[p.member_id]?.team_id === user.teamId).length
  return wait.filter((p) => byId[p.member_id]?.assigned_staff_id === user.id).length
}

function openInquiryCount(db: Pick<DbShape, 'inquiries'>): number {
  return db.inquiries.filter((i) => i.status === 'open').length
}

/** 사이드바 모듈별 뱃지 카운트(0/로딩은 생략). admins·logs 는 뱃지 대신 '관' 칩 유지 → 제외. */
export function useNavBadges(): Partial<Record<NavKey, number>> {
  const user = useCurrentUser()
  const scope = `nav:${user?.role ?? 'none'}:${user?.id ?? 'anon'}`

  const payments = useQuery({
    queryKey: paymentKeys.counts(scope),
    queryFn: async () => {
      if (!user) return 0
      const db = dataSource === 'supabase' ? await fetchTables(['members', 'payments']) : readDb()
      return scopedWaitCount(user, db)
    },
  })
  const support = useQuery({
    queryKey: supportKeys.inquiries({ nav: scope }),
    queryFn: async () =>
      openInquiryCount(dataSource === 'supabase' ? await fetchTables(['inquiries']) : readDb()),
  })

  const out: Partial<Record<NavKey, number>> = {}
  if (payments.data) out.payments = payments.data
  if (support.data) out.support = support.data
  return out
}
