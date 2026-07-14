// 상담상태 상수 — members(필터·회원정보창)와 stats(상담 리포트, 현장 7/10)가 함께 참조해
// lib 로 공유(§2 feature 간 직접 import 금지). members/views.ts 는 하위호환을 위해 재수출한다.
export const CONSULT_STATUSES = [
  '신규',
  '결번',
  '부재',
  '가망',
  '승인',
  '통화예약',
  '도입거절',
  '일반거절',
  '기타',
] as const
export type ConsultStatus = (typeof CONSULT_STATUSES)[number]
