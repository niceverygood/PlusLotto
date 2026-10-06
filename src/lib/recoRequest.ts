/** 추천번호 발급은 서버의 회원·회차 선점을 통해서만 처리한다. 네트워크 오류를 재시도하지 않는다. */
export interface RecoRequestInput {
  memberId: string
  setCount?: number
  alsoSms: boolean
  /** 명시적으로 확인한 수동 추가 발급만 사용. 생략한 기존 경로는 회차당 1회 규칙 유지. */
  operationId?: string
}

export interface ManualRecoOperation {
  id: string
  status: 'not_found' | 'claimed' | 'accepted' | 'rejected' | 'unknown' | 'not_requested' | 'blocked'
  set_count: number
  also_sms: boolean
  round_no?: number
  canStartNew: boolean
  code?: string
  confirmedNotIssued?: boolean
}

export interface RecommendationResult {
  round_no: number
  sets: number[][]
  operation?: ManualRecoOperation
}

export class RecommendationRequestError extends Error {
  constructor(message: string, readonly confirmedNotIssued = false, readonly canStartNew = confirmedNotIssued) { super(message); this.name = 'RecommendationRequestError' }
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
  operation?: unknown
  operationId?: string
  confirmedNotIssued?: boolean
}

const REVIEW_MESSAGE = '발급 또는 문자 접수 여부를 확인해야 합니다. 같은 작업을 다시 실행하지 말고 발급 내역과 문자업체 전송내역을 확인해 주세요.'

function failureMessage(code: string | undefined): string {
  if (code === 'OPERATION_CONFLICT') return '같은 요청 번호의 수량 또는 문자 발송 조건이 달라 처리하지 않았습니다. 이전 요청 결과를 확인해 주세요.'
  if (code === 'MANUAL_PENDING' || code === 'MANUAL_UNRESOLVED') return '이 회원의 미확인 수동 발급 요청이 있습니다. 접수 결과를 확인하기 전에는 추가 발급하지 않습니다.'
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
): Promise<RecommendationResult> {
  if (!accessToken) throw new RecommendationRequestError('다시 로그인해 주세요.', true)
  if (!input.memberId || (input.setCount !== undefined && (!Number.isInteger(input.setCount) || input.setCount < 1 || input.setCount > 100))) {
    throw new RecommendationRequestError('회원과 조합 수를 확인해 주세요.', true)
  }
  if (input.operationId && (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId) || input.setCount === undefined)) {
    throw new RecommendationRequestError('수동 발급 요청 번호와 추가 조합 수를 확인해 주세요.', true)
  }
  let response: Response
  let data: RecoResponse
  try {
    response = await fetcher('/api/weekly-reco', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ memberIds: [input.memberId], mode: 'manual', dryRun: false, alsoSms: input.alsoSms, ...(input.setCount === undefined ? {} : { setCount: input.setCount }), ...(input.operationId ? { operationId: input.operationId } : {}) }),
    })
    data = await response.json() as RecoResponse
  } catch {
    throw new Error(REVIEW_MESSAGE)
  }
  const nonIssuanceConfirmed = Boolean(input.operationId && data.operationId === input.operationId && data.confirmedNotIssued === true)
  let canStartNew = false
  if (nonIssuanceConfirmed) {
    try { const op = parseManualRecoOperation(data.operation, input); canStartNew = op.status === 'blocked' && op.confirmedNotIssued === true && op.canStartNew } catch { /* 확인되지 않은 원장으로는 잠금을 풀지 않는다. */ }
  }
  if (!response.ok || !data.ok) throw new RecommendationRequestError(failureMessage(response.status === 401 ? 'AUTH' : data.code), nonIssuanceConfirmed, canStartNew)
  if (input.operationId && data.operation && typeof data.operation === 'object' && (data.operation as Partial<ManualRecoOperation>).status === 'blocked') {
    const operation = parseManualRecoOperation(data.operation, input)
    throw new RecommendationRequestError(failureMessage(operation.code), operation.confirmedNotIssued === true, operation.canStartNew)
  }
  const result = data.results?.[0]
  if (data.results?.length !== 1 || result?.member_id !== input.memberId || result.status !== 'issued') {
    throw new RecommendationRequestError(failureMessage(result?.code), nonIssuanceConfirmed, canStartNew)
  }
  if (input.alsoSms && (data.smsSent !== 1 || (data.smsFail ?? 0) > 0 || (data.reviewRequired ?? 0) > 0 || result.sms_outcome !== 'accepted')) {
    throw new Error(REVIEW_MESSAGE)
  }
  if (!Number.isInteger(result.round_no) || !Array.isArray(result.sets) || !result.sets.length
    || result.sets.some((set) => !Array.isArray(set) || set.length !== 6 || new Set(set).size !== 6 || set.some((n) => !Number.isInteger(n) || n < 1 || n > 45))) {
    throw new Error(REVIEW_MESSAGE)
  }
  if (input.operationId) {
    const operation = parseManualRecoOperation(data.operation, input)
    if (operation.status !== (input.alsoSms ? 'accepted' : 'not_requested') || result.sets.length !== input.setCount || (operation.round_no !== undefined && operation.round_no !== result.round_no)) throw new Error(REVIEW_MESSAGE)
    return { round_no: result.round_no as number, sets: result.sets, operation }
  }
  return { round_no: result.round_no as number, sets: result.sets }
}

/** 상태 조회는 번호 생성·업체 호출 없이 같은 의도의 원장만 읽는다. not_found로 새 의도를 열지 않는다. */
export async function readRecommendationOperation(
  input: RecoRequestInput & { operationId: string; setCount: number },
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<ManualRecoOperation> {
  if (!accessToken) throw new Error('다시 로그인한 뒤 처리 결과를 확인해 주세요.')
  let response: Response
  let data: RecoResponse
  try {
    response = await fetcher('/api/weekly-reco', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ memberIds: [input.memberId], mode: 'manual', dryRun: true, operationId: input.operationId, setCount: input.setCount, alsoSms: input.alsoSms }),
    })
    data = await response.json() as RecoResponse
  } catch { throw new Error(REVIEW_MESSAGE) }
  if (!response.ok || !data.ok) throw new Error(failureMessage(response.status === 401 ? 'AUTH' : data.code))
  return parseManualRecoOperation(data.operation, input)
}

function parseManualRecoOperation(value: unknown, input: RecoRequestInput): ManualRecoOperation {
  if (!value || typeof value !== 'object') throw new Error(REVIEW_MESSAGE)
  const op = value as Partial<ManualRecoOperation>
  if (op.id !== input.operationId || op.set_count !== input.setCount || op.also_sms !== input.alsoSms
    || !['not_found', 'claimed', 'accepted', 'rejected', 'unknown', 'not_requested', 'blocked'].includes(String(op.status))
    || typeof op.canStartNew !== 'boolean'
    || (op.round_no !== undefined && (!Number.isInteger(op.round_no) || op.round_no < 1))) throw new Error(REVIEW_MESSAGE)
  if (op.status === 'blocked' && op.confirmedNotIssued !== true) throw new Error(REVIEW_MESSAGE)
  if (op.canStartNew && op.status !== 'accepted' && op.status !== 'not_requested' && op.status !== 'blocked') throw new Error(REVIEW_MESSAGE)
  if (op.status === 'accepted' && !input.alsoSms) throw new Error(REVIEW_MESSAGE)
  if (op.status === 'not_requested' && input.alsoSms) throw new Error(REVIEW_MESSAGE)
  return op as ManualRecoOperation
}

export function manualRecoOperationMessage(operation: ManualRecoOperation): string {
  if (operation.status === 'blocked') return `이 요청은 발급하지 않은 것으로 확인됐습니다. ${failureMessage(operation.code)}${operation.canStartNew ? '' : ' 다른 미확인 요청이 있어 추가 발급은 계속 보류합니다.'}`
  const round = operation.round_no ? `${operation.round_no}회차 ` : ''
  if (operation.status === 'accepted') return `${round}${operation.set_count}세트의 발급과 문자업체 접수가 확인됐습니다. 실제 수신 여부는 별도로 확인해 주세요.${operation.canStartNew ? '' : ' 다른 미확인 요청이 있어 추가 발급은 보류합니다.'}`
  if (operation.status === 'not_requested') return `${round}${operation.set_count}세트의 발급이 확인됐습니다. 문자 발송은 요청하지 않았습니다.${operation.canStartNew ? '' : ' 다른 미확인 요청이 있어 추가 발급은 보류합니다.'}`
  if (operation.status === 'rejected') return '문자업체 거절 기록이 있습니다. 번호 발급·업체 접수 내역을 대조하기 전에는 다시 발급하거나 발송하지 마세요.'
  if (operation.status === 'not_found') return '아직 이 요청의 처리 기록을 찾지 못했습니다. 요청이 늦게 도착할 수 있으므로 새로 발급하지 말고 처리 결과를 다시 확인해 주세요.'
  return '이 요청은 처리 중이거나 문자업체 접수 결과가 확인되지 않았습니다. 새로 발급하지 말고 처리 결과를 다시 확인해 주세요.'
}
