import type { Member } from '../types/db'

/** Mock storage only. Production originals live in the private reset archive table. */
export interface ResetRecoArchive {
  operation_id: string
  member_id: string
  issues: Record<string, unknown>[]
  reset_at: string
  reset_by: string
}
export interface MemberResetReceipt { operation_id: string; member_ids: string[]; actor_id: string }

export function resetMemberIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 ||
    ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 256) || new Set(ids).size !== ids.length) {
    throw new Error('초기화할 회원을 중복 없이 1~500명 선택해 주세요.')
  }
  return [...ids].sort()
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function arrayField(meta: Record<string, unknown>, key: string): unknown[] {
  if (!(key in meta)) return []
  if (!Array.isArray(meta[key])) throw new Error('회원 이력 형식을 확인한 뒤 초기화해 주세요.')
  return meta[key]
}

/** Validate the whole selected scope before a mutation; preserve original raw issue snapshots. */
export function planMemberReset(member: Member, actor: string, operationId: string, timestamp: string): {
  member: Member; archive: ResetRecoArchive
} {
  if (!object(member.meta)) throw new Error('회원 이력 형식을 확인한 뒤 초기화해 주세요.')
  const issues = arrayField(member.meta, 'weekly_recos')
  if (!issues.every(issue => object(issue) && /^[1-9][0-9]{0,9}$/.test(String(issue.round_no ?? '')) && Number(issue.round_no) <= 2147483647)) {
    throw new Error('발급번호 이력을 확인한 뒤 초기화해 주세요.')
  }
  const memos = arrayField(member.meta, 'memos')
  const memoArchive = [...arrayField(member.meta, 'reset_memos')]
  if (memos.length) {
    for (const memo of memos) {
      if (!object(memo) || typeof memo.body !== 'string') throw new Error('콜메모 이력을 확인한 뒤 초기화해 주세요.')
      memoArchive.push({ body: memo.body, archived_at: timestamp, reset_by: actor,
        author: memo.author ?? null, consult_status: memo.consult_status ?? null })
    }
  } else if (member.memo?.trim()) {
    memoArchive.push({ body: member.memo, archived_at: timestamp, reset_by: actor })
  }
  return {
    archive: { operation_id: operationId, member_id: member.id,
      issues: structuredClone(issues as Record<string, unknown>[]), reset_at: timestamp, reset_by: actor },
    member: { ...member, memo: null, grade: 'free', status: 'active', assigned_staff_id: null, team_id: null,
      outcall_done: false, tendency: null, consult_status: '신규', last_active_at: null, registered_at: timestamp,
      is_suspended: false, is_deleted: false, is_withdrawn: false, win_history: null,
      meta: { ...member.meta, memos: [], reset_memos: memoArchive, win_records: [], weekly_recos: [], last_reset_at: timestamp } },
  }
}
export function hasResetRecoRound(archive: readonly ResetRecoArchive[] | undefined, memberId: string, round: number): boolean {
  return !!archive?.some(row => row.member_id === memberId && row.issues.some(issue => String(issue.round_no) === String(round)))
}
export function assertNoResetRecoRound(archive: readonly ResetRecoArchive[] | undefined, ids: readonly string[], round: number): void {
  if (ids.some(id => hasResetRecoRound(archive, id, round))) {
    throw new Error('이미 발급 후 초기화한 회차입니다. 같은 회차는 다시 발급하거나 발송할 수 없습니다.')
  }
}
export function parseMemberResetResult(value: unknown, expectedIds: readonly string[]): string[] {
  if (!object(value) || !Array.isArray(value.member_ids) || typeof value.repeated !== 'boolean' ||
    value.member_ids.some(id => typeof id !== 'string') ||
    JSON.stringify(resetMemberIds(value.member_ids as string[])) !== JSON.stringify(resetMemberIds(expectedIds))) {
    throw new Error('초기화 응답을 확인하지 못했습니다. 같은 대상 그대로 다시 확인해 주세요.')
  }
  return value.member_ids as string[]
}
export function memberResetError(error: unknown): Error {
  const message = object(error) && typeof error.message === 'string' ? error.message : ''
  if (message.includes('RESET_DELIVERY_UNRESOLVED')) return new Error('발송 중이거나 접수 확인이 필요한 문자가 있습니다. 접수 결과 확인 후 초기화해 주세요.')
  if (message.includes('ACTIVE_ADMIN_REQUIRED')) return new Error('활성 최고관리자 계정만 DB 초기화를 할 수 있습니다.')
  if (message.includes('INVALID_RECO_HISTORY') || message.includes('INVALID_MEMO_HISTORY')) return new Error('회원의 발급번호 또는 콜메모 이력을 확인한 뒤 초기화해 주세요.')
  if (message.includes('MEMBER_SCOPE_CHANGED') || message.includes('RESET_OPERATION_SCOPE_CHANGED')) return new Error('회원 또는 초기화 대상이 변경되었습니다. 새로고침 후 확인해 주세요.')
  return new Error('초기화 결과를 확인하지 못했습니다. 같은 대상을 유지하고 다시 시도해 주세요. 계속되면 관리자에게 문의해 주세요.')
}
