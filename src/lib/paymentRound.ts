// 결제차수 라벨(현장 피드백 8/7, 정의현 차장 — "1차결제, 2차결제, 3차결제, 2차미수, 3차미수로
// 구분하여 결제요청을 할때, 선택할수 있도록").
//
// 기존에는 차수를 저장하지 않고 '회원의 첫 승인 결제인가'로만 자동 판정했다(매출 전환 집계).
// 현장에서는 그 자동 판정으로 표현되지 않는 구분(미수)이 필요해, 요청 시 운영자가 직접 고르고
// payments.round_label 에 그대로 저장한다. 자동 판정(conversionIds)은 매출 집계용으로 그대로 둔다.
export const PAYMENT_ROUNDS = ['1차결제', '2차결제', '3차결제', '2차미수', '3차미수'] as const
export type PaymentRound = (typeof PAYMENT_ROUNDS)[number]

/** 승인 이력 건수로 기본 차수 제안 — 운영자가 바꿀 수 있는 '초기값'일 뿐 강제하지 않는다. */
export function suggestPaymentRound(approvedCount: number): PaymentRound {
  if (approvedCount <= 0) return '1차결제'
  if (approvedCount === 1) return '2차결제'
  return '3차결제'
}
