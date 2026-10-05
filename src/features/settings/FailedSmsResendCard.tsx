// 실패 문자 현황 및 접수 대조 안내. 자동·일괄 재발송은 D207에 따라 중지.
import { useState } from 'react'
import { ClipboardCheck } from 'lucide-react'
import type { SmsSend } from '@/types/db'
import { Button } from '@/design-system/components'
import { useRole } from '@/lib/auth'
import { todayKst } from '@/lib/smsRetry'
import { SectionCard, hintCls } from './ui'
import { useFailedSms } from './api'

const TYPE_LABEL: Record<string, string> = {
  all: '전체',
  recommend: '조합(추천번호)',
  join: '가입환영',
  win: '당첨안내',
  terms: '약관',
  marketing: '마케팅',
  direct: '직접발송',
}

// 결과코드는 참고 사유이며 업체 미접수 증명을 대신하지 않는다.
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
  NET: '네트워크 오류·접수 확인 필요',
  NET_ERR: '네트워크 오류·접수 확인 필요',
  D179: '충전 상태 및 접수 확인 필요',
  EXCEPTION: '발송 서버 오류',
  사유미상: '사유 미상',
}

export function FailedSmsResendCard() {
  const role = useRole()
  const [day, setDay] = useState(todayKst())
  const [type, setType] = useState<SmsSend['type'] | 'all'>('recommend')
  // 실패 내역 역시 실장 이상에게만 보인다. UI를 숨기는 것과 별개로 재발송 함수도 차단한다.
  const canReview = role === 'admin' || role === 'manager'
  const failed = useFailedSms(day, type, canReview)
  if (!canReview) return null
  const summary = failed.data

  return (
    <SectionCard
      title="실패 문자 접수 확인"
      desc="실패로 표시되어도 업체에는 접수됐을 수 있습니다. 다시 보내기 전에 업체 전송내역을 확인해 주세요."
    >
      <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-gray-600">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink-800">
          <ClipboardCheck className="h-4 w-4 text-gray-500" /> 재발송 전 확인해 주세요
        </div>
        자동·일괄 재발송은 중지되어 있습니다. <b>충전 후에도 자동 재발송하지 않습니다.</b>
        <br />· 업체 전송내역에서 회원·발신번호·본문·시각과 접수 결과를 확인해 주세요.
        <br />· 미접수가 확인된 회원만 같은 내용으로 개별 1회 처리하고 실제 수신을 확인해 주세요.
        <br />· 응답이 없거나 접수 여부가 불명확하면 다시 보내지 말고 확인될 때까지 보류해 주세요.
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
              <b className="text-ink-800">조회된 실패 기록이 없습니다.</b> 업체 접수와 실제 수신 완료 여부는 별도로 확인해 주세요.
            </>
          ) : (
            <>
              <b className="text-ink-800">
                실패 {summary.rows.length.toLocaleString('ko-KR')}건
              </b>{' '}
              — 업체 접수 여부를 확인해 주세요. 실패 기록만으로 재발송 가능 여부를 판단하지 않습니다.
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

      <p className={hintCls}>
        조합을 다시 발급하면 다른 번호가 생성될 수 있습니다. 이미 발급된 조합과 당일 업체 전송내역을 먼저 대조해 주세요.
      </p>
    </SectionCard>
  )
}
