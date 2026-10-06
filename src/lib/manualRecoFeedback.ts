/** Blank uses the displayed member default; zero must never silently become a new issue. */
export function manualRecoCount(draft: string, configuredCount: number | null): number {
  const text = draft.trim()
  const count = text === '' ? configuredCount ?? 30 : /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error('발급할 조합 수를 1~100 사이의 정수로 입력해 주세요. 0으로 설정된 회원은 수량을 직접 확인해 주세요.')
  }
  return count
}

/** Live SMS success is reached only after requestRecommendation verifies the provider receipt. */
export function manualRecoSuccessMessage(
  result: { round_no: number; sets: number[][] },
  alsoSms: boolean,
  live: boolean,
): string {
  const issued = `${result.round_no}회차 ${result.sets.length}세트를 발급했습니다.`
  if (!live) return `시험 데이터에 ${result.round_no}회차 ${result.sets.length}세트를 반영했습니다. 실제 문자 접수·수신 결과는 확인되지 않았습니다.`
  return `${issued} ${alsoSms
    ? '문자업체 접수를 확인했습니다. 실제 수신 여부는 별도로 확인해 주세요.'
    : '문자 발송은 요청하지 않았습니다.'}`
}
