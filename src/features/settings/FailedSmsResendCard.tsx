// 실패 문자 재발송 카드 (현장 9/7 정의현 차장 통화).
//
// "아침 9시에 (문자 충전)돈이 떨어져서 조합 자동 발송이 완료가 안 됐다. 9시 반 이전에 보낸
//  그 발송 문자 그대로, 실패한 것만 그대로 다시 보내달라."
//
// 조합 자동발송 크론은 회차 기준 멱등이라 다시 돌려도 '발급은 됐고 문자만 실패한' 회원은
// 건너뛴다. 원샷 API 모드도 충전 후 밀린 건을 이어 보내주지 않는다(9/7 벤더 확인). 그래서
// 현장이 충전 직후 직접 누를 수 있는 입구가 필요하다 — 다음에 또 떨어져도 개발자 없이 복구된다.
import { useState } from 'react'
import { RotateCcw, Send } from 'lucide-react'
import type { SmsSend } from '@/types/db'
import { Button, ConfirmModal } from '@/design-system/components'
import { useRole } from '@/lib/auth'
import { todayKst } from '@/lib/smsRetry'
import { SectionCard, hintCls } from './ui'
import { useFailedSms, useResendFailedSms } from './api'
import type { ResendResult } from './smsResend'

const TYPE_LABEL: Record<string, string> = {
  all: '전체',
  recommend: '조합(추천번호)',
  join: '가입환영',
  win: '당첨안내',
  terms: '약관',
  marketing: '마케팅',
  direct: '직접발송',
}

// 원샷 결과코드 → 현장이 읽을 수 있는 사유. 잔액 부족(906)이 이번 사고의 원인이다.
const CODE_LABEL: Record<string, string> = {
  '906': '보유 금액 부족(충전 필요)',
  '904': '월 제한건수 초과',
  '905': '일 제한건수 초과',
  '901': '발송 가능시간 아님',
  '305': '잘못된 휴대전화번호',
  '402': '내용 길이 초과',
  '316': '발신번호 미등록',
  '101': '서버 IP 미등록',
  '999': '시스템 오류',
  NET: '네트워크 오류',
  EXCEPTION: '발송 서버 오류',
  사유미상: '사유 미상',
}

export function FailedSmsResendCard() {
  const role = useRole()
  const [day, setDay] = useState(todayKst())
  const [type, setType] = useState<SmsSend['type'] | 'all'>('recommend')
  const [confirming, setConfirming] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<ResendResult | null>(null)

  const failed = useFailedSms(day, type)
  const resend = useResendFailedSms()

  // 실발송 사고 복구는 되돌릴 수 없는 대외 발송이라 실장 이상만 연다.
  if (role !== 'admin' && role !== 'manager') return null

  const summary = failed.data
  const retriable = summary?.retriable ?? 0

  function run(): void {
    setProgress(null)
    setResult(null)
    resend.mutate(
      { day, type, onProgress: (done, total) => setProgress({ done, total }) },
      {
        onSuccess: (r) => {
          setResult(r)
          setConfirming(false)
        },
        onError: (e) => {
          window.alert(e instanceof Error ? e.message : '재발송에 실패했습니다.')
          setConfirming(false)
        },
      },
    )
  }

  return (
    <SectionCard
      title="못 나간 문자 재발송"
      desc="충전금 부족·통신 오류로 실패한 문자를, 같은 번호에 같은 내용 그대로 다시 보냅니다. 문자를 충전한 뒤에 눌러주세요."
    >
      <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-gray-600">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink-800">
          <RotateCcw className="h-4 w-4 text-gray-500" /> 이렇게 동작합니다
        </div>
        · 조합 자동발송은 <b>다시 돌려도 이미 발급된 회원은 건너뜁니다</b>. 그래서 문자만 실패한 회원은 이 화면에서만 복구할 수
        있습니다.
        <br />· <b>이미 문자를 받은 회원에게는 다시 가지 않습니다</b> — 같은 날 같은 내용이 발송완료로 남아 있으면 건너뜁니다.
        <br />· 번호가 틀렸거나 결번인 건은 다시 보내도 똑같이 실패하므로 <b>시도하지 않습니다</b>(충전금만 깎입니다).
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-gray-600">
          발송 날짜
          <input
            type="date"
            value={day}
            max={todayKst()}
            onChange={(e) => {
              setDay(e.target.value)
              setResult(null)
            }}
            className="h-9 rounded-md border border-gray-300 px-2.5 text-[13px] font-normal text-gray-800"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-gray-600">
          문자 종류
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value as SmsSend['type'] | 'all')
              setResult(null)
            }}
            className="h-9 rounded-md border border-gray-300 px-2.5 text-[13px] font-normal text-gray-800"
          >
            {Object.entries(TYPE_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="sec" size="sm" disabled={failed.isFetching} onClick={() => failed.refetch()}>
          {failed.isFetching ? '확인 중…' : '실패 건 다시 세기'}
        </Button>
      </div>

      {failed.isError && (
        <div className="mb-3 rounded-lg border border-danger-bd bg-danger-bg px-3 py-2.5 text-[12.5px] text-gray-700">
          실패 건을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </div>
      )}

      {summary && (
        <div className="mb-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-[12.5px] leading-relaxed text-gray-700">
          {summary.rows.length === 0 ? (
            <>
              <b className="text-success">실패한 문자가 없습니다.</b> 이 날짜의 {TYPE_LABEL[type]} 문자는 모두 정상 발송됐습니다.
            </>
          ) : (
            <>
              <b className="text-ink-800">
                실패 {summary.rows.length.toLocaleString('ko-KR')}건
              </b>{' '}
              — 이 중 <b className="text-primary-600">{retriable.toLocaleString('ko-KR')}건</b>을 다시 보낼 수 있습니다.
              {summary.permanent > 0 && (
                <> 번호 오류 등 {summary.permanent.toLocaleString('ko-KR')}건은 다시 보내도 같은 결과라 제외합니다.</>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {summary.byCode.map((c) => (
                  <span
                    key={c.code}
                    className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11.5px] text-gray-600"
                  >
                    {CODE_LABEL[c.code] ?? `코드 ${c.code}`} {c.count.toLocaleString('ko-KR')}건
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <Button
        variant="pri"
        size="sm"
        icon={<Send className="h-3.5 w-3.5" />}
        disabled={resend.isPending || failed.isFetching || retriable === 0}
        onClick={() => setConfirming(true)}
      >
        {resend.isPending
          ? progress
            ? `발송 중… ${progress.done.toLocaleString('ko-KR')}/${progress.total.toLocaleString('ko-KR')}`
            : '준비 중…'
          : `실패한 ${retriable.toLocaleString('ko-KR')}건 다시 보내기`}
      </Button>
      <p className={hintCls}>
        건수가 많으면 몇 분 걸릴 수 있습니다. 끝날 때까지 이 화면을 닫지 마세요. 문자 충전이 안 돼 있으면 다시 실패합니다.
      </p>

      {result && (
        <div className="mt-3 rounded-lg border border-success-bd bg-success-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-gray-700">
          <b className="text-success">재발송 완료</b> — {result.attempted.toLocaleString('ko-KR')}건을 시도해{' '}
          <b>{result.sent.toLocaleString('ko-KR')}건</b>이 나갔습니다.
          {result.skippedAlreadySent > 0 && (
            <> 이미 받으신 {result.skippedAlreadySent.toLocaleString('ko-KR')}건은 보내지 않았습니다.</>
          )}
          {result.skippedPermanent > 0 && (
            <> 번호 오류 등 {result.skippedPermanent.toLocaleString('ko-KR')}건은 제외했습니다.</>
          )}
          {result.failed > 0 && (
            <span className="font-semibold text-danger">
              {' '}
              {result.failed.toLocaleString('ko-KR')}건은 이번에도 실패했습니다 — 충전 잔액을 확인한 뒤 다시 눌러주세요.
            </span>
          )}
        </div>
      )}

      <ConfirmModal
        open={confirming}
        title="실패한 문자를 다시 보낼까요?"
        description={`${day} ${TYPE_LABEL[type]} 문자 중 실패한 ${retriable.toLocaleString('ko-KR')}건을 같은 내용 그대로 다시 발송합니다. 실제로 고객에게 문자가 나가며 취소할 수 없습니다.`}
        confirmText="다시 보내기"
        tone="danger"
        loading={resend.isPending}
        onConfirm={run}
        onClose={() => setConfirming(false)}
      />
    </SectionCard>
  )
}
