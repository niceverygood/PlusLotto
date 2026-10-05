// 실패한 문자의 재발송 판정 — 현장 9/7 정의현 차장 통화("9시 자동 조합발송이 문자 충전금이
// 떨어져서 완료가 안 됐다. 9시 반 이전에 보낸 그 발송 문자 그대로 실패한 것만 다시 보내달라").
//
// 배경: 조합 자동발송 크론(api/weekly-reco)은 회원별로 ① 조합 발급(members.meta) → ② 문자 발송
// 순서로 처리하고, 발급은 회차 기준 멱등이라 크론을 다시 돌려도 '이미 발급된' 회원은 통째로
// 건너뛴다. 즉 발송만 실패한 회원은 크론 재실행으로는 절대 복구되지 않는다 — 그래서 sms_sends 에
// 남은 실패 기록을 근거로 '그 문자 그대로' 다시 보내는 별도 경로가 필요하다.
//
// 원샷 API의 충전 후 자동 회수 부재는 별도 운영 대조가 필요하다. 10/5부터는 실패 기록만으로
// 자동·일괄 재발송하지 않는다. 업체 미접수 확인 후 개별 1회 처리한다(D207).

/** 재발송 대상으로 볼 실패 상태 문자열인지. 크론·수동발송 모두 '실패(코드)' 형태로 기록한다. */
export function isFailedSmsStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.startsWith('실패')
}

/** '실패(906)' → '906'. 코드가 없으면 null. */
export function failureCodeOf(status: string | null | undefined): string | null {
  const m = /^실패\(([^)]*)\)/.exec(status ?? '')
  const code = m?.[1]?.trim()
  return code && code !== '?' ? code : null
}

/** 실패 상태만으로 업체 미접수가 확인되지 않으므로 자동 재시도는 모두 보류한다.
 * D179/906 잔액 부족도 이전 요청의 접수 여부까지 증명하지 않는다(D207).
 * 접수 대조·원자 claim이 구현되기 전에는 어떤 상태도 자동 허용하지 않는다. */
export function isRetriableFailure(_status: string | null | undefined): boolean {
  return false
}

export const SMS_RETRY_RECEIPT_REQUIRED = 'RECEIPT_CONFIRMATION_REQUIRED'
export const SMS_RETRY_REVIEW_MESSAGE =
  '업체 접수 여부 확인 전 자동·일괄 재발송을 중지했습니다. 충전 후에도 자동 재발송하지 않습니다. 미접수 확인 후 해당 회원에게 개별 1회 처리해 주세요.'

/** 재발송 성공 시 기록할 상태값. 원래 발송분과 구분되게 남긴다. */
export const RESENT_STATUS = '발송완료(재발송)'

/** KST 기준 하루(YYYY-MM-DD)의 UTC ISO 경계 [gte, lt). sent_at 은 ISO UTC 로 저장된다. */
export function kstDayRangeUtc(dayKst: string): { gte: string; lt: string } {
  const [y, m, d] = dayKst.split('-').map(Number)
  const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - 9 * 3600_000
  return {
    gte: new Date(startUtcMs).toISOString(),
    lt: new Date(startUtcMs + 24 * 3600_000).toISOString(),
  }
}

/** 지금(또는 주어진 시각)의 한국 날짜 YYYY-MM-DD. */
export function todayKst(nowMs: number = Date.now()): string {
  const d = new Date(nowMs + 9 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
