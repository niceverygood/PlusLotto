// 결제차수 라벨(현장 피드백 8/7, 정의현 차장 — "1차결제, 2차결제, 3차결제, 2차미수, 3차미수로
// 구분하여 결제요청을 할때, 선택할수 있도록").
//
// 기존에는 차수를 저장하지 않고 '회원의 첫 승인 결제인가'로만 자동 판정했다(매출 전환 집계).
// 현장에서는 그 자동 판정으로 표현되지 않는 구분(미수)이 필요해, 요청 시 운영자가 직접 고르고
// payments.round_label 에 그대로 저장한다. 자동 판정(conversionIds)은 매출 집계용으로 그대로 둔다.
//
// ★ 차수의 뜻(현장 8/25, 정의현 차장 정정) — "1차,2차,3차가 나눠져 있는 이유는 결제회차가 아닌
//   1차상품:실버 / 2차상품:골드 / 3차상품:다이아 등급을 구분하기 위해서입니다."
//   즉 **몇 번째 결제인가가 아니라 어느 등급 상품을 파는가**다. 도입 때 이것을 결제 순번으로
//   오해해 승인 이력 건수로 기본값을 제안했고(구 suggestPaymentRound), 회원 상세의 결제내역은
//   저장된 라벨을 무시하고 순번을 그려서 "골드인데 4차결제"처럼 표시됐다. 둘 다 바로잡는다.
import type { Grade } from '@/types/db'

export const PAYMENT_ROUNDS = ['1차결제', '2차결제', '3차결제', '2차미수', '3차미수'] as const
export type PaymentRound = (typeof PAYMENT_ROUNDS)[number]

/** 상품 등급 → 차수. 실버=1차 · 골드=2차 · 다이아=3차 (현장 8/25). */
const ROUND_BY_GRADE: Partial<Record<Grade, PaymentRound>> = {
  goldp: '1차결제', // 실버
  vip: '2차결제', // 골드
  royal: '3차결제', // 다이아
}

/**
 * 상품 등급으로 차수를 정한다. 대응 등급이 아니면(무료·간편 등) null —
 * 호출부에서 '1차결제' 로 떨어뜨리거나 운영자 선택에 맡긴다.
 * 미수(2차미수·3차미수)는 등급만으로 알 수 없어 운영자가 직접 고른다.
 */
export function roundForGrade(grade: Grade | null | undefined): PaymentRound | null {
  return (grade && ROUND_BY_GRADE[grade]) ?? null
}
