// 이용 만료 판정 (현장 8/13, 정의현 차장 — "저희가 종료일을 지정할수 있게 되어있는데, 종료일이
// 지난 회원은 상태를 만료로 자동으로 변경될수 있도록").
//
// 왜 DB 상태값을 늘리지 않았나: members.status 는 DB enum 이라 값을 추가하려면 마이그레이션이
// 필요한데, 라이브 반영이 밀려 미적용 마이그레이션이 이미 여러 건 쌓여 있다(D153·D154). 더 중요한
// 이유는 정확성이다 — 상태를 저장해 두면 "종료일이 지난 순간"에 누군가(크론)가 바꿔줘야 하고 그
// 사이에는 틀린 값이 보인다. **종료일에서 그때그때 계산하면 항상 맞는다.**
//
// 판정 기준은 `meta.end_date`(회원정보창에서 지정하는 종료일) 하나다. 결제 승인 시에도 이용기간
// 종료일이 여기 함께 기록되므로(members/supa·api 의 승인 경로), 지정하지 않은 유료회원도 승인
// 이후로는 자동으로 판정된다. 종료일이 없는 회원은 만료로 보지 않는다.
import type { Member } from '@/types/db'

/** 회원에게 지정/기록된 이용 종료일(ISO). 없으면 null. */
export function memberEndDate(member: Pick<Member, 'meta'>): string | null {
  const v = member.meta?.['end_date']
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * 이용 만료 여부 — 종료일이 오늘(한국 날짜) 이전이면 만료.
 * 종료일 당일까지는 이용 가능으로 본다(종료일 == 오늘 이면 만료 아님).
 *
 * 정지·삭제·탈퇴처럼 이미 다른 상태가 잡힌 회원은 그 상태가 우선이라 만료로 표시하지 않는다.
 */
export function isMemberExpired(member: Pick<Member, 'meta' | 'status'>): boolean {
  return member.status === 'active' && isEndDatePast(memberEndDate(member))
}

/**
 * 종료일 경과 여부. 회원정보창처럼 결제내역까지 있는 화면은 결제 기준으로 계산한 종료일을 넘겨
 * `meta.end_date` 가 없는 회원도 판정할 수 있다.
 */
export function isEndDatePast(end: string | null): boolean {
  if (!end) return false
  const endDay = seoulDay(new Date(end))
  if (!endDay) return false
  return endDay < seoulDay(new Date())!
}

/** Date → 한국 기준 'YYYY-MM-DD'. 날짜 비교만 하므로 문자열 비교로 충분하다. */
function seoulDay(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}
