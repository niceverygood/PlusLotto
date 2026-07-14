// 매출 귀속/인식 규칙 — 원본(일행로또) 정산 스펙 미확인(스샷 없음).
// CLAUDE §9 · BUILD_PROMPTS Phase 5: 가정을 한 곳에 상수화해 라이브 확인 후 한 줄로 교체.
// TODO(live-verify): 실제 매출 인식 시점·귀속 대상·전환 정의·환불 차감 규칙 확인.
import type { Payment } from '@/types/db'

export const REVENUE_RULES = {
  /** 매출 인식 시점: 결제 승인일(paid_at). 대안: 'period_start'(이용기간 시작), 'created_at'. */
  recognitionDate: 'paid_at' as 'paid_at' | 'period_start' | 'created_at',
  /** 매출 귀속 대상: 결제 시점 담당자(payment.staff_id). 대안: 'current_assignee'(현재 회원 담당). */
  attribution: 'payment_staff' as 'payment_staff' | 'current_assignee',
  /** 전환(무료→유료) 정의: 회원의 첫 승인 유료결제를 전환으로 본다. */
  conversion: 'first_approved_paid' as const,
} as const

/** REVENUE_RULES.recognitionDate 에 따른 매출 인식 시점(ISO). 없으면 생성일로 폴백. */
export function recognitionIso(p: Payment): string {
  const v =
    REVENUE_RULES.recognitionDate === 'period_start'
      ? p.period_start
      : REVENUE_RULES.recognitionDate === 'created_at'
        ? p.created_at
        : p.paid_at
  return v ?? p.created_at
}
