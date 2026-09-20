// 조합발송 누락 점검 데이터 훅 (CLAUDE §10 — fetch 는 features/*/api.ts 계열에서만).
//
// api/weekly-reco.ts?audit=1 이 발송 직후 자동으로 돌면서 "받아야 했는데 못 받은 회원"을
// logs(action='reco.weekly_audit') 1건으로 남긴다. 이 화면은 그 기록을 읽기만 한다
// (현장 요청 9/12, 정의현 차장 — "추후 누락회원 발생치 않도록 부탁드리겠습니다").
import { useQuery } from '@tanstack/react-query'
import { readDb } from '@/lib/db/store'
import { dataSource, supabase } from '@/lib/supabase'

/** api/weekly-reco.ts 의 RecoMissReason 과 같은 값(서버는 src import 불가라 각자 정의). */
export type RecoMissReason = 'not_issued' | 'sms_missing' | 'sms_failed'

export interface RecoMissRow {
  member_id: string
  name: string | null
  phone: string | null
  grade: string
  reason: RecoMissReason
}

export interface RecoAuditRecord {
  id: string
  created_at: string
  round_no: number | null
  /** 대조 기준 시각(이 시각 이후 가입자는 대상이 아니라 제외). */
  since: string | null
  checked: number
  expected: number
  miss_count: number
  misses: RecoMissRow[]
  /** 로그 1건 크기 상한으로 목록이 잘렸는지. 잘려도 miss_count 는 실제 총계. */
  truncated: boolean
  excluded: {
    day: number
    paused: number
    expired: number
    count_zero: number
    registered_after: number
    no_phone: number
  }
}

const REASON_ORDER: RecoMissReason[] = ['not_issued', 'sms_missing', 'sms_failed']

export const MISS_REASON_LABEL: Record<RecoMissReason, string> = {
  not_issued: '조합 미발급',
  sms_missing: '문자 기록 없음',
  sms_failed: '문자 발송실패',
}

export const MISS_REASON_HELP: Record<RecoMissReason, string> = {
  not_issued: '조합 자체가 만들어지지 않았습니다. 재발송(강제 실행)이 필요합니다.',
  sms_missing: '조합은 만들어졌는데 문자 발송 기록이 없습니다. 발송 도중 끊긴 경우입니다.',
  sms_failed: '문자업체가 실패로 응답했습니다. 번호 오류·수신거부 여부를 함께 확인해 주세요.',
}

function toNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function toRecord(log: { id: string; created_at: string; meta: Record<string, unknown> | null }): RecoAuditRecord {
  const meta = log.meta ?? {}
  const rawMisses = Array.isArray(meta.misses) ? (meta.misses as Record<string, unknown>[]) : []
  const misses: RecoMissRow[] = rawMisses
    .map((m) => ({
      member_id: String(m.member_id ?? ''),
      name: typeof m.name === 'string' ? m.name : null,
      phone: typeof m.phone === 'string' ? m.phone : null,
      grade: String(m.grade ?? ''),
      reason: (REASON_ORDER.includes(m.reason as RecoMissReason) ? m.reason : 'not_issued') as RecoMissReason,
    }))
    .filter((m) => m.member_id)
  // 사유별로 묶어 보여준다 — 조치 방법이 사유마다 다르다.
  misses.sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason))
  const excluded = (meta.excluded ?? {}) as Record<string, unknown>
  return {
    id: log.id,
    created_at: log.created_at,
    round_no: typeof meta.round_no === 'number' ? meta.round_no : null,
    since: typeof meta.since === 'string' ? meta.since : null,
    checked: toNum(meta.checked),
    expected: toNum(meta.expected),
    miss_count: toNum(meta.miss_count, misses.length),
    misses,
    truncated: meta.truncated === true,
    excluded: {
      day: toNum(excluded.day),
      paused: toNum(excluded.paused),
      expired: toNum(excluded.expired),
      count_zero: toNum(excluded.count_zero),
      registered_after: toNum(excluded.registered_after),
      no_phone: toNum(excluded.no_phone),
    },
  }
}

export const sendAuditKeys = {
  all: ['reco-send-audit'] as const,
}

/** 최근 점검 기록(최신순). 감사 화면이므로 진입 시 항상 최신을 다시 읽는다. */
export function useRecoSendAudits(limit = 30) {
  return useQuery({
    queryKey: [...sendAuditKeys.all, limit],
    queryFn: async (): Promise<RecoAuditRecord[]> => {
      if (dataSource === 'supabase' && supabase) {
        const { data, error } = await supabase
          .from('logs')
          .select('id, created_at, meta')
          .eq('action', 'reco.weekly_audit')
          .order('created_at', { ascending: false })
          .limit(limit)
        if (error) throw error
        return ((data ?? []) as Parameters<typeof toRecord>[0][]).map(toRecord)
      }
      return readDb()
        .logs.filter((l) => l.action === 'reco.weekly_audit')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map((l) => toRecord({ id: l.id, created_at: l.created_at, meta: l.meta ?? null }))
    },
    staleTime: 0,
    refetchOnMount: 'always',
  })
}
