import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/design-system/components'
import { useCurrentUser } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { datetime, num } from '@/lib/format'
import { dataSource } from '@/lib/supabase'
import { useLottoHealth } from './api'
import { latestHealthJob, lottoHealthSummary, type HealthTone, type LottoHealth } from './health'

const toneClasses: Record<HealthTone, string> = {
  healthy: 'border-success-bd bg-success-bg text-success',
  pending: 'border-info-bd bg-info-bg text-info',
  attention: 'border-danger-bd bg-danger-bg text-danger',
  unknown: 'border-warning-bd bg-warning-bg text-warning',
}
const jobLabels = { pending: '대기', running: '집계 중', blocked: '확인 필요', complete: '완료' } as const

export interface LottoHealthViewProps {
  health?: LottoHealth | null
  loading?: boolean
  failed?: boolean
  refreshing?: boolean
  compact?: boolean
  showSms?: boolean
  onRefresh: () => void
}

/** Presentational view: production data comes only from the hook; QA can inject explicitly labelled fixtures. */
export function LottoHealthView({ health, loading, failed, refreshing, compact, showSms = true, onRefresh }: LottoHealthViewProps) {
  const summary = lottoHealthSummary(health, failed)
  const job = health ? latestHealthJob(health) : undefined
  if (compact && !loading && !failed && summary.tone === 'healthy') return null
  const tone: HealthTone = loading ? 'pending' : summary.tone
  const Icon = loading || tone === 'pending' ? Clock3 : tone === 'healthy' ? CheckCircle2 : AlertTriangle

  return (
    <section className={cn('mb-4 rounded-lg border p-4', toneClasses[tone])} aria-label="회차 수집·당첨 집계 상태">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div aria-live="polite">
            <h2 className="text-sm font-bold">{loading ? '자동 집계 상태 확인 중' : summary.title}</h2>
            <p className="mt-1 text-sm text-gray-700">{loading ? '운영 서버의 최근 점검 결과를 조회하고 있습니다.' : summary.description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {compact && <Link to="/admin/lotto/results" className="text-sm font-bold underline underline-offset-2">집계 현황</Link>}
          <Button variant="sec" size="sm" disabled={Boolean(loading || refreshing)} onClick={onRefresh} icon={<RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />}>
            상태 새로고침
          </Button>
        </div>
      </div>
      {!compact && !loading && (
        <>
          {failed ? (
            <p className="mt-3 text-sm text-gray-700">이전에 표시된 집계 수치는 최신 확인 결과가 아닐 수 있어 숨겼습니다.</p>
          ) : health ? (
            <div className="mt-4 space-y-4 text-gray-700">
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div><dt className="text-xs text-gray-500">예상 최신 회차</dt><dd className="mt-1 font-mono text-lg font-bold tabular-nums text-ink-900">{num(health.expected_round)}회</dd></div>
                <div><dt className="text-xs text-gray-500">등록 / 집계 완료 회차</dt><dd className="mt-1 font-mono text-lg font-bold tabular-nums text-ink-900">{num(health.max_round)}회 / {num(health.max_confirmed_round)}회</dd></div>
                <div><dt className="text-xs text-gray-500">마지막 자동 점검</dt><dd className="mt-1 font-mono text-sm tabular-nums">{datetime(health.last_attempt_at)}</dd></div>
              </dl>
              {health.jobs.some((item) => item.status !== 'complete') && (
                <p className="text-sm"><b>미완료 집계:</b> {health.jobs.filter((item) => item.status !== 'complete').map((item) => `${num(item.round_no)}회 · ${jobLabels[item.status]} (${num(item.done)}/${num(item.total)}건)`).join(' / ')}</p>
              )}
              {job ? (
                <div className="rounded-md border border-gray-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <h3 className="font-bold text-ink-900">{num(job.round_no)}회차 추천조합 당첨 집계 · {jobLabels[job.status]}</h3>
                    <span className="font-mono tabular-nums">처리 항목 {num(job.done)} / {num(job.total)}건</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                    <span>추천 당첨회원 <b className="font-mono tabular-nums">{num(job.winners)}명</b>{job.status !== 'complete' && ' (집계 중)'}</span>
                    <span className="font-mono tabular-nums">{[1, 2, 3, 4, 5].map((rank) => `${rank}등 ${num(job.rank_counts[String(rank) as '1' | '2' | '3' | '4' | '5'] ?? 0)}건`).join(' · ')}</span>
                    <Link to={`/admin/members?wr=${job.round_no}`} className="font-bold text-primary-700 underline underline-offset-2">당첨회원 조회</Link>
                  </div>
                  <p className="mt-2 text-xs text-gray-500">처리 항목에는 회원 추천과 베팅이 포함됩니다. 등수별 건수는 추천조합 수이며 한 회원이 여러 건 당첨될 수 있습니다. 아래 표의 베팅 당첨 건수와는 집계 대상이 다릅니다.</p>
                </div>
              ) : (
                <p className="text-sm">상세 집계 진행 기록이 없습니다. 당첨회원은 이용자 메뉴에서 회차별로 확인해 주세요.</p>
              )}
              {showSms && (
                <div className="border-t border-gray-200 pt-3 text-sm">
                  <h3 className="font-bold text-ink-900">당첨 안내문자 처리 현황</h3>
                  <p className="mt-1 font-mono tabular-nums">대기 {num(health.sms.pending)} · 접수 확인 중 {num(health.sms.claimed)} · 업체 접수 {num(health.sms.accepted)} · 실패 {num(health.sms.failed)} · 응답 불명 {num(health.sms.unknown)} · 제외 {num(health.sms.skipped)}</p>
                  <p className="mt-1 text-xs text-gray-500">업체 접수와 실제 수신은 별도입니다. 실패·응답 불명 건은 업체 접수 내역을 확인한 후 처리합니다.</p>
                </div>
              )}
              <p className="text-xs text-gray-500">조회 기준 {datetime(health.checked_at)} · 마지막 정상 점검 {datetime(health.last_success_at)} · 1분마다 자동 새로고침</p>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

export function LottoHealthPanel({ compact = false }: { compact?: boolean }) {
  const user = useCurrentUser()
  const query = useLottoHealth()
  if (dataSource !== 'supabase' || (user?.role !== 'admin' && user?.role !== 'manager')) return null
  const offline = query.fetchStatus === 'paused'
  return <LottoHealthView health={query.data} loading={query.isLoading && !offline} failed={query.isError || offline} refreshing={query.isFetching} compact={compact} onRefresh={() => void query.refetch()} />
}
