// OneShot / SMTNT(msgagent) 문자 발송 클라이언트 어댑터 (§V2-6).
// 실제 전송은 서버(Vercel 함수 /api/send-sms)가 '고정 IP 프록시' 경유로 수행한다 — OneShot 은
// 요청 IP 화이트리스트 인증이라 브라우저/서버리스 가변 IP 로 직접 호출할 수 없다(키도 없음).
// 여기서는 그 함수를 호출하고 결과 코드를 해석만 한다.
import { supabase } from './supabase'

/** 한국 문자 바이트 길이(비ASCII=2바이트). SMS=90byte 기준. */
export function koByteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0x7f ? 2 : 1
  return n
}

/** 본문 길이로 SMS(≤90byte) / LMS 자동 분류. */
export function classifyMsgType(body: string): 'SMS' | 'LMS' {
  return koByteLength(body) <= 90 ? 'SMS' : 'LMS'
}

export interface OneShotResult {
  ok: boolean
  code: string
  cmid?: string | null
  message?: string
  msgType?: 'SMS' | 'LMS' | 'MMS'
}

export interface OneShotSendInput {
  dest_phone: string
  msg_body: string
  send_phone: string
  subject?: string
  msgType?: 'SMS' | 'LMS'
  send_time?: string // YYYYMMDDHHMISS, 없으면 즉시
  tran_id?: string
}

/** Vercel 함수 '/api/send-sms'(고정 IP 프록시 경유) 호출. 본문 길이로 SMS/LMS 자동 분류. */
export async function sendOneShot(input: OneShotSendInput): Promise<OneShotResult> {
  const msgType = input.msgType ?? classifyMsgType(input.msg_body)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    // 로그인 운영자 세션 토큰 첨부 — 서버가 staff 인증 후에만 실발송(보안 D68). mock 모드는 세션 없음.
    const token = (await supabase?.auth.getSession())?.data.session?.access_token
    if (token) headers.authorization = `Bearer ${token}`
    const r = await fetch('/api/send-sms', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...input, msgType }),
    })
    return (await r.json()) as OneShotResult
  } catch (e) {
    return { ok: false, code: 'NET_ERR', message: e instanceof Error ? e.message : '네트워크 오류' }
  }
}

// 결과 코드(요청 검증) — 매뉴얼 '결과코드' 시트 발췌(운영에서 자주 보는 것 위주).
const RESULT_CODES: Record<string, string> = {
  '0': '성공',
  '100': '허용되지 않은 형식',
  '101': '허용되지 않은 IP(서버 IP 미등록)',
  '103': '허용되지 않은 사용자 아이디',
  '110': '식별코드 누락',
  '200': '필수 요청 값 누락',
  '301': '잘못된 메시지 타입',
  '305': '잘못된 휴대전화번호',
  '402': '내용 길이 초과(SMS 90byte/LMS 2000byte)',
  '801': 'https 가 아닌 접근',
  '999': '시스템 오류',
}

// 전송 결과(통신사 단계) — 매뉴얼 '전송결과' 시트 발췌.
const SEND_RESULTS: Record<string, string> = {
  '0': '성공',
  '2': '인증실패',
  '7': '결번',
  '8': '단말기 전원 꺼짐',
  '316': '발신번호 미등록',
  '317': '발신번호 변작 등록',
  '320': '중복발송',
  '904': '월 제한건수 초과',
  '905': '일 제한건수 초과',
  '906': '보유 금액 부족',
  '901': '발송 가능시간 아님',
}

/** 결과 코드 → 사람이 읽는 메시지. 클라이언트 자체 코드(NO_CLIENT 등)도 흡수. */
export function formatOneShotResult(r: OneShotResult): string {
  if (r.ok) return '발송 성공'
  if (r.message) return r.message
  return RESULT_CODES[r.code] ?? SEND_RESULTS[r.code] ?? `발송 실패(코드 ${r.code})`
}
