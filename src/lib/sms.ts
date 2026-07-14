// 문자 발송 도메인 로직 (CLAUDE §2 — feature 간 공유는 lib 경유).
// 템플릿 변수 치환 + 템플릿키→발송유형 매핑. 이용자/나의고객 모듈이 함께 사용.
import type { Member, SmsType } from '@/types/db'
import { BRAND } from '@/lib/brand'

// 템플릿 본문 변수: $name $id $pw $num $contents (CLAUDE §4 sms_templates)
// TODO(live-verify): $pw(임시비밀번호)·$num(회차 추천번호)은 실 연동 시 실제 값 주입.
export function renderSms(body: string, m: Member): string {
  const vars: Record<string, string> = {
    name: m.name,
    id: m.user_id,
    pw: '****',
    num: '— 회차 추천번호 —',
    contents: m.win_history ?? '',
  }
  return body.replace(/\$(name|id|pw|num|contents)/g, (_, k: string) => vars[k] ?? '')
}

/**
 * 추천 조합 SMS 본문 — 회원정보창 조합발송·템플릿 '추천번호' 발송·수동발급이 모두 같은 포맷을 쓰도록
 * 통일(현장 피드백 6/22: "추천번호 발송 내용 = 회원정보창 번호 문자발송 내용 동일").
 */
export function recoSmsBody(roundNo: number, sets: number[][]): string {
  const lines = sets.map((s, i) => `${i + 1}) ${s.join(' ')}`)
  return `[${BRAND.name}] ${roundNo}회 추천번호 ${sets.length}조합\n${lines.join('\n')}`
}

/** 템플릿 key → 발송유형(가입·추천·당첨·마케팅). 미지정 템플릿은 마케팅으로 분류. */
export function smsTypeForTemplate(key: string | null): SmsType {
  switch (key) {
    case 'join':
      return 'join'
    case 'win':
      return 'win'
    case 'recommend':
      return 'recommend'
    default:
      return 'marketing'
  }
}
