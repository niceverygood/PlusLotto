// 문자 발송 도메인 로직 (CLAUDE §2 — feature 간 공유는 lib 경유).
// 템플릿 변수 치환 + 템플릿키→발송유형 매핑. 이용자/나의고객 모듈이 함께 사용.
import type { Member, SmsType } from '@/types/db'
import { homepageId, homepagePw } from '@/lib/homepage'

// 템플릿 본문 변수: $name $id $pw $num $contents $link (CLAUDE §4 sms_templates)
// TODO(live-verify): $num(회차 추천번호)은 실 연동 시 실제 값 주입.
// overrides: 템플릿별 특수 발송(예: 약관)이 $contents 등을 회원 기본값 대신 채울 때 사용(현장 7/22).
export function renderSms(
  body: string,
  m: Member,
  overrides?: Partial<Record<'name' | 'id' | 'pw' | 'num' | 'contents' | 'link', string>>,
): string {
  // 가입환영 문자의 $id/$pw는 실제 고객 홈페이지 로그인 자격증명이어야 한다(전화번호 / 기본 뒷4자리).
  // 예전엔 $id=관리자용 로그인ID(m.user_id)·$pw='****' 리터럴 문자열이 그대로 나가 회원이 안내받은
  // 값으로 로그인할 수 없었다(현장 피드백 7/28, 정의현 차장 — "Test님... 아이디: pl1001... ****").
  const vars: Record<string, string> = {
    name: m.name,
    id: homepageId(m.phone),
    pw: (m.meta?.homepage_pw as string | undefined) || homepagePw(m.phone),
    num: '— 회차 추천번호 —',
    contents: m.win_history ?? '',
    link: '',
    ...overrides,
  }
  return body.replace(/\$(name|id|pw|num|contents|link)/g, (_, k: string) => vars[k] ?? '')
}

/**
 * 추천 조합 SMS 본문 — 회원정보창 조합발송·템플릿 '추천번호' 발송·수동발급이 모두 같은 포맷을 쓰도록
 * 통일(현장 피드백 6/22: "추천번호 발송 내용 = 회원정보창 번호 문자발송 내용 동일").
 * 포맷 확정(현장 피드백 7/22, 정의현 차장): 회차 숫자는 통신사 스팸 필터 회피를 위해
 * 1233 → 12.33처럼 마지막 두 자리 앞에 점을 넣는다.
 * 최상단 문구도 통신사 스팸 필터 회피를 위해 "plus No. <회차>" 로 표기한다(현장 피드백 7/30,
 * 정의현 차장 — 기존 "[플러스]\n번째" 2줄을 이 한 줄로 교체. "회원님" 줄과 조합 리스트는 그대로).
 */
export function spamSafeRound(roundNo: number): string {
  const digits = String(Math.max(0, Math.trunc(roundNo)))
  return digits.length > 2 ? `${digits.slice(0, -2)}.${digits.slice(-2)}` : digits
}

export function recoSmsBody(name: string, roundNo: number, sets: number[][]): string {
  const lines = sets.map((s, i) => `[${i + 1}] ${s.join(',')}`)
  return `plus No. ${spamSafeRound(roundNo)}\n${name || '회원'}님\n${lines.join('\n')}`
}

/** 템플릿 key → 발송유형(가입·추천·당첨·약관·마케팅). 미지정 템플릿은 마케팅으로 분류. */
export function smsTypeForTemplate(key: string | null): SmsType {
  switch (key) {
    case 'join':
      return 'join'
    case 'win':
      return 'win'
    case 'recommend':
      return 'recommend'
    case 'terms':
      return 'terms'
    default:
      return 'marketing'
  }
}
