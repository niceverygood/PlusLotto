// 당첨 안내문자 자동발송 규칙 (현장 피드백 7/28, 정의현 차장)
// "당첨안내 문자발송은 자동으로 설정가능하도록 / 각 등수별(1,2,3,4,5) · 유료회원 · 무료회원 체크란을
//  만들어 선택한 분류만 당첨문자가 나가도록"
//
// 판정 규칙 한 곳(이 파일)만 보면 되도록 설정 기본값·대상 판정·본문 선택을 모두 여기 모은다.
// 발송 트리거는 두 군데다(§8 회차 등록/당첨 확정):
//   1) 수기 '당첨 확정'  — features/lotto/{api,supa}.ts confirmRound
//   2) 크론 자동적재     — api/weekly-lotto-sync.ts (서버 함수라 규칙을 자급자족 복제, 아래 상수와 동기화)
// 중복발송 방지는 member.meta.win_sms_rounds(발송한 회차 목록)로 한다 — 당첨 확정은 멱등(재확정 가능)이라
// 재확정할 때마다 같은 회원에게 문자가 다시 나가면 안 된다.
import type { Grade, Member, SiteSettings, WinMessage, WinSmsSettings } from '@/types/db'
import { renderSms } from '@/lib/sms'

/** 유료회원 등급 (매출·통계 모듈과 동일 기준). 그 외(simple/free/ovr/toss)는 무료로 본다. */
export const PAID_GRADES: readonly Grade[] = ['gold', 'goldp', 'vip', 'royal']

export function isPaidGrade(g: Grade): boolean {
  return PAID_GRADES.includes(g)
}

/** 기본값 — '꺼짐'. 실제 고객에게 나가는 문자라 운영자가 설정에서 직접 켠 뒤부터 발송한다. */
export const DEFAULT_WIN_SMS: WinSmsSettings = {
  enabled: false,
  ranks: [1, 2, 3, 4, 5],
  paid: true,
  free: false,
}

export function readWinSms(s: Pick<SiteSettings, 'win_sms'> | null | undefined): WinSmsSettings {
  const w = s?.win_sms
  if (!w) return DEFAULT_WIN_SMS
  return {
    enabled: !!w.enabled,
    ranks: Array.isArray(w.ranks) ? w.ranks.filter((r) => r >= 1 && r <= 5) : [],
    paid: !!w.paid,
    free: !!w.free,
  }
}

/** 이 등수·이 등급의 회원에게 당첨문자를 자동발송할지. 등수·회원분류 둘 다 선택돼 있어야 발송. */
export function shouldSendWinSms(cfg: WinSmsSettings, rank: number, grade: Grade): boolean {
  if (!cfg.enabled) return false
  if (!cfg.ranks.includes(rank)) return false
  return isPaidGrade(grade) ? cfg.paid : cfg.free
}

/** 이미 이 회차 당첨문자를 받은 회원인지(재확정 시 중복발송 방지). */
export function winSmsSentRounds(meta: Record<string, unknown> | null | undefined): number[] {
  const list = meta?.win_sms_rounds
  return Array.isArray(list) ? (list.filter((n) => typeof n === 'number') as number[]) : []
}

export function markWinSmsSent(meta: Record<string, unknown> | null | undefined, roundNo: number): number[] {
  const sent = winSmsSentRounds(meta)
  return sent.includes(roundNo) ? sent : [...sent, roundNo].slice(-40)
}

/**
 * 등수별 당첨문자 본문. 설정(설정 > 당첨 안내문자)의 해당 등수 문구를 회원 변수로 치환한다.
 * $contents 는 회원의 최신 당첨내역 문자열이라, 확정 직후 갱신된 win_history 를 넘겨 쓴다.
 */
export function winSmsBody(
  messages: readonly WinMessage[],
  rank: number,
  member: Member,
  winHistory?: string,
): string | null {
  const tpl = messages.find((w) => w.rank === rank)
  if (!tpl || !tpl.body.trim()) return null
  return renderSms(tpl.body, member, winHistory ? { contents: winHistory } : undefined)
}
