/** 추천번호 발급은 서버의 회원·회차 선점을 통해서만 처리한다. 네트워크 오류를 재시도하지 않는다. */
export interface RecoRequestInput {
  memberId: string
  setCount?: number
  alsoSms: boolean
}

interface RecoResult {
  member_id?: string
  status?: string
  code?: string
  round_no?: number
  sets?: number[][]
  sms_outcome?: string
}

interface RecoResponse {
  ok?: boolean
  code?: string
  error?: string
  results?: RecoResult[]
  smsSent?: number
  smsFail?: number
  reviewRequired?: number
}

const REVIEW_MESSAGE = '발급 또는 문자 접수 여부를 확인해야 합니다. 같은 작업을 다시 실행하지 말고 발급 내역과 문자업체 전송내역을 확인해 주세요.'

function failureMessage(code: string | undefined): string {
  if (code === 'AUTH' || code === 'UNAUTHORIZED') return '로그인이 만료되었습니다. 다시 로그인해 주세요.'
  if (code === 'HELD' || code?.includes('HOLD') || code?.includes('PAUSED')) return '발송 보류 중인 회원입니다. 검수와 전환 확인 후 처리해 주세요.'
  if (code === 'COUNT_ZERO' || code === 'COUNT-ZERO') return '조합 수가 0으로 설정된 회원입니다. 발급하지 않았습니다.'
  if (code === 'ALREADY' || code === 'ALREADY_ISSUED' || code === 'ALREADY_CLAIMED') return '이번 회차는 이미 처리한 기록이 있어 다시 발급·발송하지 않았습니다. 기존 발급 및 문자 접수 내역을 확인해 주세요.'
  if (code?.includes('SCOPE') || code?.includes('FORBIDDEN')) return '이 회원의 조합을 발급할 권한이 없습니다.'
  if (code?.includes('EXPIRED')) return '이용기간이 만료된 회원입니다.'
  if (code?.includes('DELETED') || code?.includes('WITHDRAWN') || code?.includes('SUSPENDED') || code?.includes('INACTIVE')) return '삭제·탈퇴·정지 상태인 회원은 발급할 수 없습니다.'
  if (code?.includes('DISABLED') || code?.includes('SENDER')) return '문자 발송 설정 또는 사이트 발신번호를 확인해 주세요. 자동 재발송하지 않습니다.'
  if (code?.includes('STALE') || code?.includes('CHANGED')) return '회원정보가 변경되어 처리하지 않았습니다. 새로고침 후 최신 상태를 확인해 주세요.'
  return REVIEW_MESSAGE
}

/** 인증 401도 자동 재호출하지 않는다. 기존 탭·동시 실행·응답 유실은 서버 선점으로 방어한다. */
export async function requestRecommendation(
  input: RecoRequestInput,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<{ round_no: number; sets: number[][] }> {
  if (!accessToken) throw new Error('다시 로그인해 주세요.')
  if (!input.memberId || (input.setCount !== undefined && (!Number.isInteger(input.setCount) || input.setCount < 1 || input.setCount > 100))) {
    throw new Error('회원과 조합 수를 확인해 주세요.')
  }
  let response: Response
  let data: RecoResponse
  try {
    response = await fetcher('/api/weekly-reco', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ memberIds: [input.memberId], mode: 'manual', dryRun: false, alsoSms: input.alsoSms, ...(input.setCount === undefined ? {} : { setCount: input.setCount }) }),
    })
    data = await response.json() as RecoResponse
  } catch {
    throw new Error(REVIEW_MESSAGE)
  }
  if (!response.ok || !data.ok) throw new Error(failureMessage(response.status === 401 ? 'AUTH' : data.code))
  const result = data.results?.[0]
  if (data.results?.length !== 1 || result?.member_id !== input.memberId || result.status !== 'issued') {
    throw new Error(failureMessage(result?.code))
  }
  if (input.alsoSms && (data.smsSent !== 1 || (data.smsFail ?? 0) > 0 || (data.reviewRequired ?? 0) > 0 || result.sms_outcome !== 'accepted')) {
    throw new Error(REVIEW_MESSAGE)
  }
  if (!Number.isInteger(result.round_no) || !Array.isArray(result.sets) || !result.sets.length
    || result.sets.some((set) => !Array.isArray(set) || set.length !== 6 || new Set(set).size !== 6 || set.some((n) => !Number.isInteger(n) || n < 1 || n > 45))) {
    throw new Error(REVIEW_MESSAGE)
  }
  return { round_no: result.round_no as number, sets: result.sets }
}
