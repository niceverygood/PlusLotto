/** 수동 추가 발급의 한 번의 확인 의도를 저장한다. 전화번호·문자 본문은 저장하지 않는다. */
export interface ManualRecoIntent {
  operationId: string
  actorId: string
  memberId: string
  setCount: number
  alsoSms: boolean
}

/** 로컬 데모 원장. 실운영의 업체 접수 증거로 사용하지 않는다. */
export interface MockManualRecoOperation extends ManualRecoIntent {
  roundNo: number
  status: 'claimed' | 'accepted' | 'not_requested' | 'rejected' | 'unknown'
  sets: number[][]
}

interface IntentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const PREFIX = 'pluslotto:manual-reco-intent:v1:'
export const MANUAL_INTENT_CHANGED = 'manual-reco-intent-changed'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const PENDING_MANUAL_MESSAGE = '이 회원의 이전 수동 발급 요청이 아직 확인되지 않았습니다. 새로 발급하지 말고 처리 결과를 확인해 주세요.'

function key(actorId: string, memberId: string): string {
  if (!actorId || !memberId) throw new Error('다시 로그인한 뒤 회원을 확인해 주세요.')
  return `${PREFIX}${encodeURIComponent(actorId)}:${encodeURIComponent(memberId)}`
}

export function readManualRecoIntent(actorId: string, memberId: string, storage: IntentStorage = localStorage): ManualRecoIntent | null {
  const raw = storage.getItem(key(actorId, memberId))
  if (raw === null) return null
  let value: Partial<ManualRecoIntent>
  try { value = JSON.parse(raw) as Partial<ManualRecoIntent> } catch { throw new Error('이전 수동 발급 요청 기록을 읽을 수 없습니다. 새로 발급하지 말고 관리자에게 접수 내역 확인을 요청해 주세요.') }
  if (!value || typeof value !== 'object' || value.actorId !== actorId || value.memberId !== memberId
    || typeof value.operationId !== 'string' || !UUID.test(value.operationId)
    || !Number.isInteger(value.setCount) || Number(value.setCount) < 1 || Number(value.setCount) > 100 || typeof value.alsoSms !== 'boolean') {
    throw new Error('이전 수동 발급 요청 기록이 올바르지 않습니다. 새로 발급하지 말고 관리자에게 접수 내역 확인을 요청해 주세요.')
  }
  return value as ManualRecoIntent
}

/** lock 콜백 안에서만 호출. 저장과 재확인이 끝나기 전에는 서버 요청을 보내지 않는다. */
export function persistManualRecoIntent(intent: ManualRecoIntent, storage: IntentStorage = localStorage): void {
  if (readManualRecoIntent(intent.actorId, intent.memberId, storage)) throw new Error(PENDING_MANUAL_MESSAGE)
  storage.setItem(key(intent.actorId, intent.memberId), JSON.stringify(intent))
  const saved = readManualRecoIntent(intent.actorId, intent.memberId, storage)
  if (saved?.operationId !== intent.operationId) throw new Error(PENDING_MANUAL_MESSAGE)
}

export async function reserveManualRecoIntent(input: Omit<ManualRecoIntent, 'operationId'>): Promise<ManualRecoIntent> {
  // 같은 운영자의 여러 창이 동시에 확인해도 하나의 미확인 요청만 만든다.
  if (!navigator.locks || !crypto.randomUUID) throw new Error('이 브라우저에서는 안전한 수동 발급을 시작할 수 없습니다. 최신 Chrome에서 다시 열어 주세요.')
  return navigator.locks.request(key(input.actorId, input.memberId), async () => {
    if (readManualRecoIntent(input.actorId, input.memberId)) throw new Error(PENDING_MANUAL_MESSAGE)
    const intent = { ...input, operationId: crypto.randomUUID() }
    persistManualRecoIntent(intent)
    window.dispatchEvent(new Event(MANUAL_INTENT_CHANGED))
    return intent
  })
}

/** 서버가 최종 처리 결과를 확인했거나 전송 자체가 시작되지 않은 경우에만 호출한다. */
export function clearManualRecoIntent(intent: ManualRecoIntent, storage: IntentStorage = localStorage): void {
  const current = readManualRecoIntent(intent.actorId, intent.memberId, storage)
  if (!current) return // 다른 창에서 같은 최종 영수증을 확인했으면 이미 정리됐을 수 있다.
  if (current.operationId !== intent.operationId) throw new Error(PENDING_MANUAL_MESSAGE)
  storage.removeItem(key(intent.actorId, intent.memberId))
  if (storage.getItem(key(intent.actorId, intent.memberId)) !== null) throw new Error('확인된 요청 기록을 정리하지 못했습니다. 처리 결과를 다시 확인해 주세요.')
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MANUAL_INTENT_CHANGED))
}
