// 실패한 문자의 재발송 판정 — 현장 9/7 정의현 차장 통화("9시 자동 조합발송이 문자 충전금이
// 떨어져서 완료가 안 됐다. 9시 반 이전에 보낸 그 발송 문자 그대로 실패한 것만 다시 보내달라").
//
// 배경: 조합 자동발송 크론(api/weekly-reco)은 회원별로 ① 조합 발급(members.meta) → ② 문자 발송
// 순서로 처리하고, 발급은 회차 기준 멱등이라 크론을 다시 돌려도 '이미 발급된' 회원은 통째로
// 건너뛴다. 즉 발송만 실패한 회원은 크론 재실행으로는 절대 복구되지 않는다 — 그래서 sms_sends 에
// 남은 실패 기록을 근거로 '그 문자 그대로' 다시 보내는 별도 경로가 필요하다.
//
// 또한 원샷(OneShot) API 모드는 충전 후 밀린 건을 자동으로 이어 보내주지 않는다(9/7 통화에서
// 벤더 확인). 우리 쪽에서 재발송하지 않으면 그 회차 문자는 영영 안 나간다.

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

// 재발송해도 같은 결과가 뻔한 '영구 실패' 코드 — 번호 자체가 잘못됐거나 내용이 규격을 넘은 건들.
// 이런 건까지 다시 밀어넣으면 충전금만 깎이고 현장에는 같은 실패가 다시 쌓인다.
const PERMANENT_CODES = new Set([
  '100', // 허용되지 않은 형식
  '200', // 필수 요청 값 누락
  '301', // 잘못된 메시지 타입
  '305', // 잘못된 휴대전화번호
  '402', // 내용 길이 초과
  '7', // 결번
  '316', // 발신번호 미등록
  '317', // 발신번호 변작 등록
])

/** 재발송을 시도할 가치가 있는 실패인지(일시적 사유). 코드를 모르면 시도한다. */
export function isRetriableFailure(status: string | null | undefined): boolean {
  if (!isFailedSmsStatus(status)) return false
  const code = failureCodeOf(status)
  if (!code) return true // 코드 미상(NET/EXCEPTION 등) — 네트워크성으로 보고 재시도
  return !PERMANENT_CODES.has(code)
}

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
