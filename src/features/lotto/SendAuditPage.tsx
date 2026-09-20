// 조합발송 점검 (/lotto/send-audit) — "받아야 했는데 못 받은 회원"만 보여준다.
//
// 현장 요청(9/12, 정의현 차장 — "추후 누락회원 발생치 않도록 부탁드리겠습니다. 조합발송 누락시,
// 민원발생으로 취소요청건에 대한 방어가 어렵습니다").
//
// 이 화면의 생명은 **허위가 없는 것**이다. 신규 가입자·종료회원·일시정지·발송갯수 0 처럼 애초에
// 대상이 아니었던 회원이 목록에 섞이면 현장이 목록 자체를 믿지 않게 되고, 그러면 진짜 누락을
// 놓친다. 제외 판정은 서버(api/weekly-reco.ts)가 발송 때와 **같은 함수**로 하고, 이 화면은
// 그 결과를 읽어 보여주기만 한다(계산·재판정 없음).
import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, ShieldCheck } from 'lucide-react'
import { Button, EmptyState, KpiCard, PageHeader, SkeletonRows, QueryErrorCard } from '@/design-system/components'
import { usePageMeta } from '@/app/uiStore'
import { GRADE_LABEL } from '@/design-system/labels'
import { datetime, num, phone } from '@/lib/format'
import { downloadCsv } from '@/lib/csv'
import type { Grade } from '@/types/db'
import {
  MISS_REASON_HELP,
  MISS_REASON_LABEL,
  useRecoSendAudits,
  type RecoAuditRecord,
  type RecoMissReason,
} from './sendAudit'

const REASON_TONE: Record<RecoMissReason, string> = {
  not_issued: 'bg-danger/10 text-danger',
  sms_missing: 'bg-warning/10 text-warning',
  sms_failed: 'bg-warning/10 text-warning',
}

function gradeLabel(grade: string): string {
  return GRADE_LABEL[grade as Grade] ?? grade ?? '—'
}

/** 점검 1건 헤더 — 회차와 점검 시각. */
function auditTitle(a: RecoAuditRecord): string {
  return `${a.round_no !== null ? `${a.round_no}회차` : '회차 미상'} · ${datetime(a.created_at)}`
}

export function SendAuditPage() {
  usePageMeta('조합발송 점검', '회차별 조합·문자를 받지 못한 회원 확인')
  const q = useRecoSendAudits()
  const audits = q.data ?? []
  const [pickedId, setPickedId] = useState<string | null>(null)
  const active = useMemo(
    () => audits.find((a) => a.id === pickedId) ?? audits[0] ?? null,
    [audits, pickedId],
  )

  const byReason = useMemo(() => {
    const map = new Map<RecoMissReason, number>()
    for (const m of active?.misses ?? []) map.set(m.reason, (map.get(m.reason) ?? 0) + 1)
    return map
  }, [active])

  function exportCsv(): void {
    if (!active) return
    downloadCsv(
      `조합발송_누락_${active.round_no ?? '회차미상'}.csv`,
      ['회원ID', '이름', '연락처', '등급', '누락사유'],
      active.misses.map((m) => [m.member_id, m.name ?? '', m.phone ?? '', gradeLabel(m.grade), MISS_REASON_LABEL[m.reason]]),
    )
  }

  if (q.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title="조합발송 점검" description="회차별 조합·문자를 받지 못한 회원 확인" />
        <QueryErrorCard
          title="점검 결과를 불러오지 못했습니다"
          description="조회가 실패한 상태이며 누락이 0건이라는 뜻이 아닙니다. 잠시 후 다시 시도해 주세요."
          error={q.error}
          isRetrying={q.isFetching}
          onRetry={() => void q.refetch()}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="조합발송 점검"
        description="발송이 끝나면 자동으로 대조해 '받아야 했는데 못 받은 회원'만 모아둡니다."
        actions={
          active && active.misses.length > 0 ? (
            <Button size="sm" variant="sec" onClick={exportCsv}>
              <Download className="h-4 w-4" /> 누락 목록 받기
            </Button>
          ) : undefined
        }
      />

      {q.isLoading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <SkeletonRows rows={6} cols={5} />
        </div>
      ) : !active ? (
        <EmptyState
          icon={<ShieldCheck className="h-6 w-6" />}
          title="아직 점검 기록이 없습니다"
          description="조합 자동발송이 한 번 끝나면 이 화면에 점검 결과가 쌓입니다."
        />
      ) : (
        <>
          {audits.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {audits.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setPickedId(a.id)}
                  className={
                    'rounded-full border px-3 py-1 text-[12px] font-semibold transition ' +
                    (a.id === active.id
                      ? 'border-primary-600 bg-primary-50 text-primary-700'
                      : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50')
                  }
                >
                  {auditTitle(a)}
                  {a.miss_count > 0 && (
                    <span className="ml-1.5 font-mono tnum text-danger">{num(a.miss_count)}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <KpiCard
              label="발송 대상"
              value={<span className="font-mono tnum">{num(active.expected)}명</span>}
              icon={<ShieldCheck className="h-4 w-4" />}
              iconClassName="bg-primary-50 text-primary-600"
              delta={`${auditTitle(active)} 기준`}
            />
            <KpiCard
              label="누락"
              value={
                <span className={'font-mono tnum ' + (active.miss_count > 0 ? 'text-danger' : 'text-success')}>
                  {num(active.miss_count)}명
                </span>
              }
              icon={active.miss_count > 0 ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              iconClassName={active.miss_count > 0 ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}
              delta={
                active.miss_count > 0
                  ? [...byReason].map(([r, n]) => `${MISS_REASON_LABEL[r]} ${n}`).join(' · ')
                  : '전원 발송 확인'
              }
            />
            <KpiCard
              label="대조한 회원"
              value={<span className="font-mono tnum">{num(active.checked)}명</span>}
              icon={<ShieldCheck className="h-4 w-4" />}
              iconClassName="bg-gray-100 text-gray-500"
              delta="정지·삭제·탈퇴 회원 제외"
            />
          </div>

          {/* 정상 제외분을 숨기지 않고 함께 보여준다 — "왜 대상이 이 숫자인지"가 보여야
              현장이 목록을 신뢰한다. */}
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="mb-2 text-[12px] font-bold text-ink-800">발송 대상에서 정상 제외된 회원</div>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-gray-600">
              {[
                ['발송 시작 이후 가입', active.excluded.registered_after],
                ['이용 종료일 경과', active.excluded.expired],
                ['발송 일시정지', active.excluded.paused],
                ['발송갯수 0', active.excluded.count_zero],
                ['오늘 발송요일 아님', active.excluded.day],
                ['연락처 없음(유료)', active.excluded.no_phone],
              ].map(([label, n]) => (
                <span key={String(label)}>
                  {label} <span className="font-mono tnum font-semibold text-gray-800">{num(Number(n))}</span>
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-gray-400">
              위 사유는 누락이 아닙니다. 발송 자체가 예정되지 않았던 회원입니다.
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
              <h2 className="text-[14px] font-bold text-ink-800">누락 회원</h2>
              <span className="font-mono tnum text-[12px] text-gray-400">{num(active.miss_count)}명</span>
            </div>
            {active.misses.length === 0 ? (
              <EmptyState
                icon={<CheckCircle2 className="h-6 w-6" />}
                title="누락된 회원이 없습니다"
                description="대상 회원 전원에게 조합과 문자가 나갔습니다."
              />
            ) : (
              <>
                <div className="max-h-[560px] overflow-y-auto">
                  <table className="w-full text-left text-[12.5px]">
                    <thead className="sticky top-0 bg-gray-50 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="w-36 px-4 py-2">이름</th>
                        <th className="w-40 px-2 py-2">연락처</th>
                        <th className="w-24 px-2 py-2">등급</th>
                        <th className="w-32 px-2 py-2">누락 사유</th>
                        <th className="px-2 py-2">조치</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.misses.map((m) => (
                        <tr key={m.member_id} className="border-t border-gray-100 hover:bg-gray-50/60">
                          <td className="px-4 py-2 font-semibold text-ink-800">{m.name || '—'}</td>
                          <td className="px-2 py-2 font-mono tnum text-gray-600">{phone(m.phone)}</td>
                          <td className="px-2 py-2 text-gray-600">{gradeLabel(m.grade)}</td>
                          <td className="px-2 py-2">
                            <span className={'rounded-full px-2 py-0.5 text-[11px] font-semibold ' + REASON_TONE[m.reason]}>
                              {MISS_REASON_LABEL[m.reason]}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-gray-500">{MISS_REASON_HELP[m.reason]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {active.truncated && (
                  <p className="border-t border-gray-100 px-4 py-2 text-[11.5px] text-warning">
                    누락이 많아 화면에는 일부만 표시했습니다. 전체 {num(active.miss_count)}명은 담당 개발자에게 요청해 주세요.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
