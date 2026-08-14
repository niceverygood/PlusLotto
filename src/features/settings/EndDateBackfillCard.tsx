// 회원 종료일 결제기록 기준 일괄 반영 (현장 8/13, 정의현 차장 — "종료일은 결제기록 기준으로
// 일괄적으로 넣어주시는걸로 부탁드리겠습니다").
//
// 8/13 배포분부터는 결제 승인 시 종료일이 자동으로 기록되지만(D156), 그 이전 결제만 있는 기존
// 유료회원은 종료일이 비어 있어 목록에서 만료 판정이 안 된다. 이 카드가 그 과거분을 한 번 채운다.
// 되돌릴 수 없는 일괄 쓰기라 확인 모달 필수(§10), 최고관리자 전용.
import { useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { Button, ConfirmModal } from '@/design-system/components'
import { useRole } from '@/lib/auth'
import { SectionCard, hintCls } from './ui'
import { useBackfillEndDates, useBackfillRecoDays } from './api'

export function EndDateBackfillCard() {
  const role = useRole()
  const backfill = useBackfillEndDates()
  const [confirming, setConfirming] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<{ scanned: number; filled: number; skipped: number; failed: number } | null>(
    null,
  )

  if (role !== 'admin') return null

  function run(): void {
    setProgress(null)
    setResult(null)
    backfill.mutate(
      { onProgress: (done, total) => setProgress({ done, total }) },
      {
        onSuccess: (r) => {
          setResult(r)
          setConfirming(false)
        },
        onError: (e) => {
          window.alert(e instanceof Error ? e.message : '일괄 반영에 실패했습니다.')
          setConfirming(false)
        },
      },
    )
  }

  return (
    <SectionCard
      title="회원 종료일 일괄 반영"
      desc="결제기록이 있는 기존 회원의 이용 종료일을 한 번에 채웁니다. 앞으로 들어오는 결제는 승인 시 자동으로 기록되므로, 이 작업은 과거분을 맞추기 위한 1회성입니다."
    >
      <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-gray-600">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink-800">
          <CalendarClock className="h-4 w-4 text-gray-500" /> 반영 규칙
        </div>
        · 대상은 <b>승인된 결제가 있는 회원</b>입니다. 기준일은 가장 최근 승인 결제의 결제일입니다.
        <br />· 종료일 = 기준일 + 등급별 기간(<b>실버 1년 / 골드·다이아 3년</b>).
        <br />· <b>이미 종료일이 지정된 회원은 건드리지 않습니다</b> — 직접 넣으신 날짜는 그대로 둡니다.
        <br />· 종료일이 채워지면 그 날짜가 지난 회원은 목록에서 <b>만료</b>로 표시됩니다.
      </div>

      <Button variant="pri" size="sm" disabled={backfill.isPending} onClick={() => setConfirming(true)}>
        {backfill.isPending
          ? progress
            ? `반영 중… ${progress.done.toLocaleString('ko-KR')}/${progress.total.toLocaleString('ko-KR')}`
            : '대상 확인 중…'
          : '종료일 일괄 반영'}
      </Button>
      <p className={hintCls}>회원 수가 많으면 몇 분 걸릴 수 있습니다. 끝날 때까지 이 화면을 닫지 마세요.</p>

      {result && (
        <div className="mt-3 rounded-lg border border-success-bd bg-success-bg px-3 py-2.5 text-[12.5px] text-gray-700">
          <b className="text-success">반영 완료</b> — 결제기록이 있는 회원 {result.scanned.toLocaleString('ko-KR')}명 중{' '}
          <b>{result.filled.toLocaleString('ko-KR')}명</b>에게 종료일을 넣었습니다.
          {result.skipped > 0 && <> 이미 종료일이 있던 {result.skipped.toLocaleString('ko-KR')}명은 그대로 두었습니다.</>}
          {result.failed > 0 && (
            <span className="font-semibold text-danger">
              {' '}
              {result.failed.toLocaleString('ko-KR')}명은 실패했습니다 — 다시 실행하면 실패분만 재시도됩니다.
            </span>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={run}
        title="종료일 일괄 반영"
        description="결제기록이 있는 회원의 이용 종료일을 결제일 + 등급별 기간으로 채웁니다. 이미 종료일이 지정된 회원은 건드리지 않습니다. 되돌릴 수 없으니 확인 후 진행해 주세요."
        confirmText="반영"
        tone="danger"
        loading={backfill.isPending}
      />
    </SectionCard>
  )
}

/**
 * 유료회원 조합발송요일 일괄 복구 (현장 8/14, 정의현 차장 — "8/7, 8/14 자동발송 되었어야하나
 * 자동발송 안됨").
 *
 * 조합 자동발송 크론은 유료등급의 경우 **발송요일이 지정된 회원만** 대상으로 삼는다(무료회원만
 * 기본 금요일). 결제로 유료가 돼도 요일을 넣어주지 않으면 조합문자가 영영 나가지 않는다.
 * 8/14 배포분부터는 결제 승인 시 자동으로 들어가지만, 그 이전 결제 회원은 이 버튼으로 채운다.
 */
export function RecoDayBackfillCard() {
  const role = useRole()
  const backfill = useBackfillRecoDays()
  const [confirming, setConfirming] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<{ scanned: number; filled: number; skipped: number; failed: number } | null>(
    null,
  )

  if (role !== 'admin') return null

  function run(): void {
    setProgress(null)
    setResult(null)
    backfill.mutate(
      { onProgress: (done, total) => setProgress({ done, total }) },
      {
        onSuccess: (r) => {
          setResult(r)
          setConfirming(false)
        },
        onError: (e) => {
          window.alert(e instanceof Error ? e.message : '일괄 반영에 실패했습니다.')
          setConfirming(false)
        },
      },
    )
  }

  return (
    <SectionCard
      title="유료회원 조합발송요일 점검·복구"
      desc="조합문자가 자동으로 나가려면 유료회원에게 '조합발송요일'이 지정되어 있어야 합니다. 요일이 비어 있어 자동발송에서 빠져 있던 회원을 찾아 금요일로 채웁니다."
    >
      <div className="mb-3 rounded-lg border border-warning-bd bg-warning-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-gray-700">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink-800">
          <CalendarClock className="h-4 w-4 text-warning" /> 왜 필요한가요
        </div>
        무료회원은 요일을 지정하지 않아도 금요일에 자동으로 나가지만, <b>유료회원은 요일이 지정된
        경우에만</b> 나갑니다. 그래서 결제 후 요일을 넣지 않은 회원은 조합문자를 계속 못 받습니다.
        <br />앞으로 결제 승인되는 회원은 <b>금요일이 자동으로 지정</b>되므로, 이 버튼은 그 이전에
        결제한 기존 회원을 맞추기 위한 1회성입니다. 이미 요일이 지정된 회원은 건드리지 않습니다.
      </div>

      <Button variant="pri" size="sm" disabled={backfill.isPending} onClick={() => setConfirming(true)}>
        {backfill.isPending
          ? progress
            ? `복구 중… ${progress.done.toLocaleString('ko-KR')}/${progress.total.toLocaleString('ko-KR')}`
            : '대상 확인 중…'
          : '발송요일 일괄 복구'}
      </Button>
      <p className={hintCls}>복구된 회원은 다음 금요일 자동발송부터 조합문자를 받습니다.</p>

      {result && (
        <div className="mt-3 rounded-lg border border-success-bd bg-success-bg px-3 py-2.5 text-[12.5px] text-gray-700">
          <b className="text-success">복구 완료</b> — 유료회원 {result.scanned.toLocaleString('ko-KR')}명 중{' '}
          <b>{result.filled.toLocaleString('ko-KR')}명</b>에게 금요일을 지정했습니다.
          {result.skipped > 0 && <> 이미 요일이 있던 {result.skipped.toLocaleString('ko-KR')}명은 그대로 두었습니다.</>}
          {result.failed > 0 && (
            <span className="font-semibold text-danger">
              {' '}
              {result.failed.toLocaleString('ko-KR')}명은 실패했습니다 — 다시 실행하면 실패분만 재시도됩니다.
            </span>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={run}
        title="발송요일 일괄 복구"
        description="조합발송요일이 비어 있는 유료회원에게 금요일을 지정합니다. 이미 요일이 지정된 회원은 건드리지 않습니다. 복구된 회원은 다음 금요일부터 조합문자를 받게 됩니다."
        confirmText="복구"
        tone="danger"
        loading={backfill.isPending}
      />
    </SectionCard>
  )
}
