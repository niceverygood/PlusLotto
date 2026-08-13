import type { Grade, MemberStatus, PaymentStatus, PaymentMethod, SmsType } from '@/types/db'

/** 등급 한글 라벨. 고객화면 명칭 변경(D95, 7/21) — goldp=실버·vip=골드·royal=다이아.
 *  gold 는 구 내부 등급(하위호환 유지, 신규 부여 없음)이라 "미정"으로 표시한다. */
export const GRADE_LABEL: Record<Grade, string> = {
  simple: '간편가입',
  free: '무료',
  gold: '미정',
  goldp: '실버',
  vip: '골드',
  royal: '다이아',
  ovr: '인반언스', // TODO(live-verify): 명칭 미확인 (ASSUMPTIONS)
  toss: '토스DB',
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'gray' | 'info' | 'stop'

/** 회원/결제 상태 → 톤 + 라벨. (StatusChip 자동 매핑) */
// 'expired'(만료)는 DB 상태값이 아니라 종료일에서 계산하는 표시 전용 상태다(lib/memberExpiry,
// 현장 8/13). 색·라벨을 다른 상태와 똑같이 쓰기 위해 여기 함께 둔다.
export type StatusKey = MemberStatus | PaymentStatus | 'expired'

export const STATUS_META: Record<StatusKey, { label: string; tone: StatusTone }> = {
  // 회원
  active: { label: '정상', tone: 'success' },
  suspended: { label: '정지', tone: 'stop' },
  deleted: { label: '삭제', tone: 'gray' },
  withdrawn: { label: '탈퇴', tone: 'gray' },
  expired: { label: '만료', tone: 'warning' }, // 종료일 경과(계산값, 현장 8/13)
  // 결제
  wait: { label: '대기', tone: 'warning' },
  approved: { label: '승인', tone: 'success' },
  failed: { label: '실패', tone: 'danger' },
  cancelled: { label: '취소', tone: 'gray' },
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  bank: '무통장',
  manual: '수기',
  pg: 'PG',
}

export const SMS_TYPE_LABEL: Record<SmsType, string> = {
  join: '가입',
  recommend: '추천',
  win: '당첨',
  terms: '약관',
  marketing: '마케팅',
  direct: '직접입력',
}
