import type { WeeklyRecoIssue } from '@/types/db'
import type { WinRecord } from './winHistory'
import type { ResetRecoArchive } from './memberReset'
import type { MockManualRecoOperation } from './manualRecoIntent'

/** Mock mirrors the production ledger test; a metadata UUID alone never bypasses the automatic guard. */
export function recordedManualIssue(issue: WeeklyRecoIssue, memberId: string, operations: readonly MockManualRecoOperation[] = []): boolean {
  const operationId = (issue as WeeklyRecoIssue & { manual_request_id?: unknown }).manual_request_id
  return typeof operationId === 'string' && operations.some(op => op.operationId === operationId
    && op.memberId === memberId && op.roundNo === issue.round_no && op.setCount === issue.sets.length
    && JSON.stringify(op.sets) === JSON.stringify(issue.sets))
}

export function hasAutomaticRecoTombstone(memberId: string, round: number, issues: readonly WeeklyRecoIssue[],
  archives: readonly ResetRecoArchive[] = [], operations: readonly MockManualRecoOperation[] = []): boolean {
  if (operations.some(op => op.memberId === memberId && op.roundNo === round
    && ['claimed', 'unknown', 'rejected'].includes(op.status))) return true
  if (issues.some(issue => issue.round_no === round && !recordedManualIssue(issue, memberId, operations))) return true
  return archives.some(archive => archive.member_id === memberId && archive.issues.some(raw =>
    raw.round_no === round && !recordedManualIssue(raw as unknown as WeeklyRecoIssue, memberId, operations)))
}

/** All explicit issues contribute; retain their local indexes while deriving a unique global display index. */
export function roundRecoSets(issues: readonly WeeklyRecoIssue[], round: number): { numbers: number[]; comboIndex: number }[] {
  const seen = new Set<string>()
  const result: { numbers: number[]; comboIndex: number }[] = []
  for (const issue of issues) {
    if (issue.round_no !== round) continue
    const id = (issue as WeeklyRecoIssue & { manual_request_id?: string }).manual_request_id ?? JSON.stringify(issue)
    if (seen.has(id)) continue
    seen.add(id)
    for (const numbers of issue.sets) result.push({ numbers, comboIndex: result.length + 1 })
  }
  return result
}

/** Recount replaces the entire round so moved combo indexes or newly losing sets cannot retain stale wins. */
export function replaceRoundWinRecords(existing: readonly WinRecord[], fresh: readonly WinRecord[], round: number): WinRecord[] {
  return [...existing.filter(win => win.round_no !== round), ...fresh.filter(win => win.round_no === round)]
    .sort((a, b) => b.round_no - a.round_no || a.combo_index - b.combo_index)
}
