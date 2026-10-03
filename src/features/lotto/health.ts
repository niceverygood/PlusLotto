import { z } from 'zod'

const count = z.number().int().nonnegative()
const timestamp = z.string().datetime({ offset: true }).nullable()
const jobSchema = z.object({
  round_no: z.number().int().positive(),
  status: z.enum(['pending', 'running', 'blocked', 'complete']),
  total: count,
  done: count,
  winners: count,
  rank_counts: z.object({ '1': count, '2': count, '3': count, '4': count, '5': count }),
  last_error: z.string().nullable(),
  updated_at: timestamp,
  completed_at: timestamp,
}).refine((job) => job.done <= job.total && job.winners <= job.done, 'Invalid aggregation counts')

/** The RPC contains aggregate counts only. Unexpected/missing fields must not become a healthy zero. */
export const lottoHealthSchema = z.object({
  checked_at: z.string().datetime({ offset: true }),
  expected_round: z.number().int().positive(),
  max_round: count,
  max_confirmed_round: count,
  jobs: z.array(jobSchema),
  sms: z.object({ pending: count, claimed: count, accepted: count, failed: count, unknown: count, skipped: count }),
  last_attempt_at: timestamp,
  last_success_at: timestamp,
  last_error: z.string().nullable(),
})

export type LottoHealth = z.infer<typeof lottoHealthSchema>
export type LottoHealthJob = LottoHealth['jobs'][number]
export type HealthTone = 'healthy' | 'pending' | 'attention' | 'unknown'
export interface LottoHealthSummary { tone: HealthTone; title: string; description: string }

const HOUR = 60 * 60 * 1000
const FIRST_DRAW = Date.parse('2002-12-07T20:45:00+09:00')
const WEEK = 7 * 24 * HOUR
// The cron checks every five minutes. Distinguish the initial publication window from an overdue result.
const PUBLICATION_GRACE = 30 * 60 * 1000

export function latestHealthJob(health: LottoHealth): LottoHealthJob | undefined {
  return [...health.jobs].sort((a, b) => b.round_no - a.round_no)[0]
}

export function lottoHealthSummary(health: LottoHealth | null | undefined, failed = false): LottoHealthSummary {
  if (failed || !health) {
    return { tone: 'unknown', title: '자동 집계 상태 확인 불가', description: '점검 결과를 불러오지 못했습니다. 회차와 당첨 집계가 정상인지 확인이 필요합니다.' }
  }
  if (health.jobs.some((job) => job.status === 'blocked' || (job.status === 'complete' && job.done < job.total))) {
    return { tone: 'attention', title: '당첨 집계 확인 필요', description: '완료되지 않은 집계가 있습니다. 담당자가 오류를 확인해야 합니다.' }
  }
  if (health.sms.unknown > 0) {
    return { tone: 'attention', title: '당첨 안내문자 접수 확인 필요', description: '접수 여부를 확정하지 못한 문자가 있습니다. 문자업체 접수 내역을 먼저 확인해 주세요.' }
  }
  const now = Date.parse(health.checked_at)
  const overdue = now > FIRST_DRAW + (health.expected_round - 1) * WEEK + PUBLICATION_GRACE
  const waitingForPublication = health.last_error === 'UPSTREAM_NOT_READY' && !overdue && health.max_round < health.expected_round
  if (health.last_error && health.last_error !== 'IN_PROGRESS' && !waitingForPublication) {
    return { tone: 'attention', title: '자동 수집·집계 점검 필요', description: '최근 자동 점검에서 오류가 확인됐습니다. 마지막 완료 회차와 집계 진행 상태를 확인해 주세요.' }
  }
  if (health.max_round < health.expected_round) {
    return overdue
      ? { tone: 'attention', title: `${health.expected_round}회차 결과 수집 지연`, description: '예상 회차의 당첨번호가 아직 등록되지 않았습니다. 자동 수집 상태를 확인해 주세요.' }
      : { tone: 'pending', title: `${health.expected_round}회차 결과 수집 대기`, description: '추첨 직후 결과를 수집하는 시간입니다. 등록과 당첨 집계 완료 여부를 자동으로 재확인합니다.' }
  }
  const unfinished = health.jobs.filter((job) => job.status !== 'complete')
  if (unfinished.some((job) => !job.updated_at || now - Date.parse(job.updated_at) > 15 * 60 * 1000)) {
    return { tone: 'attention', title: '당첨 집계 진행 확인 필요', description: '집계가 완료되지 않은 채 진행 기록이 갱신되지 않았습니다. 담당자 확인이 필요합니다.' }
  }
  if (health.max_confirmed_round < health.expected_round || unfinished.length > 0) {
    return { tone: 'pending', title: '당첨자 집계 진행 중', description: '당첨번호 등록 후 회원별 당첨 이력을 집계하고 있습니다. 완료 회차와 처리 현황을 확인해 주세요.' }
  }
  if (!health.last_attempt_at || now - Date.parse(health.last_attempt_at) > 15 * 60 * 1000) {
    return { tone: 'unknown', title: '최근 자동 점검 기록 확인 필요', description: '최신 회차는 등록되어 있지만 최근 자동 점검이 확인되지 않습니다.' }
  }
  if (health.sms.failed > 0) {
    return { tone: 'attention', title: '당첨 안내문자 실패 확인 필요', description: '실패한 당첨 안내문자가 있습니다. 실패 사유와 문자업체 접수 여부를 확인해 주세요.' }
  }
  if (health.sms.pending > 0 || health.sms.claimed > 0) {
    return { tone: 'pending', title: '당첨 안내문자 처리 대기', description: '당첨 집계는 완료됐으며 안내문자 처리가 남아 있습니다.' }
  }
  if (health.last_error === 'IN_PROGRESS') {
    return { tone: 'pending', title: '자동 점검 진행 중', description: '다음 자동 점검에서 집계와 안내문자 처리 완료 여부를 확인합니다.' }
  }
  return { tone: 'healthy', title: `${health.expected_round}회차 당첨 집계 완료`, description: '예상 회차까지 등록과 집계가 완료됐습니다. 문자 접수 결과는 아래 현황에서 확인할 수 있습니다.' }
}
