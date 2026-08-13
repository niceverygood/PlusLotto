// 등급별 이용 종료일 기본 기간 (현장 8/13, 정의현 차장 — "실버등급은 결제이후 종료일이 1년
// 기본세팅으로 설정되어 있습니다. 골드, 다이아 등급은 결제가 이루어지면 종료일이 3년 기본세팅으로
// 변경 부탁드립니다").
//
// ★ '이용 종료일'과 '결제 이용기간(payments.period_end)'은 다른 값이다.
//   · payments.period_start/period_end = 그 결제 건이 커버하는 기간(상품 duration_months 기준.
//     예: 실버 상품 1개월 → 결제 목록의 '기간'에 1개월로 표시).
//   · members.meta.end_date = 회원의 서비스 이용 종료일. 현장 기준은 결제일 + 등급별 연수다.
//   둘을 같은 값으로 쓰면 실버 회원이 한 달 뒤 만료로 뜬다(D155 에서 실제로 그렇게 잘못 넣었다).
//
// 값이 바뀔 수 있는 운영 규칙이라 여기 한 곳에만 둔다(CLAUDE §9-5). 설정 화면으로 빼는 것은
// 현장에서 등급 체계가 확정된 뒤에 하는 편이 낫다.
import type { Grade } from '@/types/db'
import { addYears } from 'date-fns'

/** 등급 → 결제 후 이용 연수. 표에 없는 등급은 기본 1년. */
const TERM_YEARS_BY_GRADE: Partial<Record<Grade, number>> = {
  goldp: 1, // 실버
  vip: 3, // 골드
  royal: 3, // 다이아
}

export const DEFAULT_TERM_YEARS = 1

export function termYearsForGrade(grade: Grade | null | undefined): number {
  return (grade && TERM_YEARS_BY_GRADE[grade]) || DEFAULT_TERM_YEARS
}

/** 결제일(기준일) + 등급별 연수 = 이용 종료일(ISO). */
export function endDateForGrade(from: string | Date, grade: Grade | null | undefined): string {
  const base = typeof from === 'string' ? new Date(from) : from
  if (Number.isNaN(base.getTime())) return ''
  return addYears(base, termYearsForGrade(grade)).toISOString()
}
