// 월 발신 통화량 근사 집계(현장 피드백 7/3, 김형준 이사) — 전산엔 실제 발신 통화를 세는 데이터가
// 없어, 상담원이 통화 후 남기는 '상담상태 변경'(member.update 로그의 patch.consult_status) 건수를
// 그 달의 통화량으로 근사한다. 순수 함수라 mock(lib/db)·live(supabase) 양쪽에서 공유한다.
export const CALL_VOLUME_ALERT_DEFAULT = 1000

export interface CallVolumeStatus {
  count: number
  threshold: number
  over: boolean
}

function isThisMonth(iso: string): boolean {
  const d = new Date(iso)
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()
}

/** member.update 로그 중 이번 달 + consult_status 변경분만 카운트. */
export function tallyCallVolume(
  logs: readonly { action: string; created_at: string; meta?: Record<string, unknown> }[],
): number {
  return logs.filter((l) => {
    if (l.action !== 'member.update' || !isThisMonth(l.created_at)) return false
    const patch = l.meta?.patch as Record<string, unknown> | undefined
    return !!patch && 'consult_status' in patch
  }).length
}
