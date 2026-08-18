// 조합 자동발송 대상 판정 — 크론(api/weekly-reco.ts)의 대상 규칙을 그대로 옮긴 것 (현장 8/18).
//
// 왜 만들었나: "이 회원 자동 조합발송이 안 됐습니다"라는 신고가 반복되는데, 그때마다 크론 코드를
// 읽어 회원별 조건(요일·일시정지·갯수·등급·전역 스위치)을 손으로 대조해야 했다. 라이브 DB 를 볼 수
// 없는 상태에서는 추측이 될 수밖에 없어 8/14·8/18 두 번 모두 원인 특정이 늦어졌다.
// 같은 규칙을 화면에서 바로 보여주면 현장이 회원정보창을 열어 30초 만에 원인을 읽을 수 있다.
//
// ⚠️ api/weekly-reco.ts 는 Vercel 함수 런타임 제약으로 src/ 를 import 하지 못하는 자급자족 파일이라
//    규칙이 두 곳에 있다. **크론 조건을 바꾸면 이 파일도 같이 바꿔야 한다.**
import type { Member, SiteSettings } from '@/types/db'
import { DEFAULT_RECO_DAY, PAID_RECO_GRADES } from './recoSchedule'

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토']

export interface RecoEligibility {
  /** 발급(조합 생성) 대상인가 */
  willIssue: boolean
  /** 조합문자까지 자동 발송되는가 (유료회원 + 전역 스위치 3종) */
  willSend: boolean
  /** 발송 요일 라벨. 대상이 아니면 null */
  dayLabel: string | null
  /** 사람이 읽는 사유 — 안 나가는 이유 또는 나가는 조건 요약 */
  reasons: string[]
}

function metaNum(meta: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = meta?.[key]
  return typeof v === 'number' ? v : null
}

export function recoEligibility(
  member: Pick<Member, 'grade' | 'meta' | 'phone' | 'is_suspended' | 'is_deleted' | 'is_withdrawn'>,
  settings: Pick<SiteSettings, 'weekly_free_reco' | 'sms'> | null | undefined,
): RecoEligibility {
  const reasons: string[] = []
  const meta = member.meta ?? {}
  const isPaid = PAID_RECO_GRADES.has(member.grade)

  // ① 크론의 회원 조회 필터
  if (member.is_suspended || member.is_deleted || member.is_withdrawn) {
    reasons.push('정지·삭제·탈퇴 회원은 자동발송 대상이 아닙니다.')
    return { willIssue: false, willSend: false, dayLabel: null, reasons }
  }

  // ② 발송요일 — 무료는 미설정 시 기본 금요일, 유료는 설정된 회원만
  const day = metaNum(meta, 'weekly_reco_day') ?? (member.grade === 'free' ? DEFAULT_RECO_DAY : null)
  if (day === null) {
    reasons.push('조합발송요일이 지정되지 않았습니다. 유료회원은 요일을 지정해야 자동발송됩니다.')
    return { willIssue: false, willSend: false, dayLabel: null, reasons }
  }
  const dayLabel = `${WEEKDAY[day] ?? '?'}요일`

  // ③ 일시정지 / 갯수 0
  if (meta.reco_paused === true) {
    reasons.push('‘조합발송 일시정지’가 켜져 있습니다.')
    return { willIssue: false, willSend: false, dayLabel, reasons }
  }
  if (metaNum(meta, 'weekly_reco_count') === 0) {
    reasons.push('조합발송갯수가 0이라 발급·발송이 중단됩니다.')
    return { willIssue: false, willSend: false, dayLabel, reasons }
  }

  // ④ 전역 스위치 — 무료 자동발급(enabled) / 유료 조합문자(paid_sms + 실발송 + 발신번호)
  const cfg = settings?.weekly_free_reco
  const sms = settings?.sms
  const paidSmsOn = !!sms?.oneshot_enabled && !!sms?.sender_no && !!cfg?.paid_sms
  const freeIssueOn = cfg?.enabled !== false

  const willIssue = freeIssueOn || (paidSmsOn && isPaid)
  if (!willIssue) {
    reasons.push('설정에서 주간 자동발급이 꺼져 있습니다(추천번호 설정 화면).')
    return { willIssue: false, willSend: false, dayLabel, reasons }
  }

  // ⑤ 문자 발송 조건 — 유료등급만, 그리고 전역 3종이 모두 켜져 있어야 한다
  let willSend = false
  if (!isPaid) {
    reasons.push('무료 등급은 조합이 발급만 되고 문자는 나가지 않습니다(홈페이지에서 조회).')
  } else if (!member.phone) {
    reasons.push('휴대폰 번호가 없어 문자를 보낼 수 없습니다.')
  } else if (!cfg?.paid_sms) {
    reasons.push('설정에서 ‘유료회원 조합문자 자동발송’이 꺼져 있습니다 — 이 스위치가 꺼져 있으면 유료회원 전원에게 문자가 나가지 않습니다.')
  } else if (!sms?.oneshot_enabled) {
    reasons.push('문자 실발송(OneShot 연동)이 꺼져 있어 실제 문자가 나가지 않습니다.')
  } else if (!sms?.sender_no) {
    reasons.push('발신번호가 설정되지 않아 문자가 나가지 않습니다.')
  } else {
    willSend = true
    reasons.push(`매주 ${dayLabel}에 조합 발급 + 조합문자가 자동 발송됩니다.`)
  }

  if (!willSend && willIssue && isPaid) {
    reasons.unshift(`매주 ${dayLabel}에 조합은 발급되지만, 아래 이유로 문자는 나가지 않습니다.`)
  }
  return { willIssue, willSend, dayLabel, reasons }
}
