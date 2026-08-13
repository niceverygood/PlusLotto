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
import { useBackfillEndDates } from './api'

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
