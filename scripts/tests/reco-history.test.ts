import assert from 'node:assert/strict'
import test from 'node:test'
import { hasAutomaticRecoTombstone, recordedManualIssue, roundRecoSets, replaceRoundWinRecords } from '../../src/lib/recoHistory.ts'
import type { MockManualRecoOperation } from '../../src/lib/manualRecoIntent.ts'
import type { WeeklyRecoIssue } from '../../src/types/db.ts'
import type { ResetRecoArchive } from '../../src/lib/memberReset.ts'

const manual = { round_no: 1245, issued_at: '2026-10-06T03:00:00Z', sets: [[1,2,3,4,5,6]], manual_request_id: '00000000-0000-4000-8000-000000000001' }
const operation: MockManualRecoOperation = { operationId: manual.manual_request_id, actorId: 'staff-a', memberId: 'member-a',
  setCount: 1, alsoSms: false, roundNo: 1245, status: 'not_requested', sets: manual.sets }
const legacy: WeeklyRecoIssue = { round_no: 1245, issued_at: '2026-10-06T01:00:00Z', sets: [[7,8,9,10,11,12]] }
const archive = (issues: Record<string, unknown>[]): ResetRecoArchive[] => [{ operation_id: 'reset', member_id: 'member-a',
  issues, reset_at: '2026-10-06T04:00:00Z', reset_by: 'admin' }]

test('only a persisted exact member/round/sets operation makes a manual issue independent from automatic', () => {
  assert.equal(recordedManualIssue(manual, 'member-a', [operation]), true)
  assert.equal(recordedManualIssue(manual, 'member-b', [operation]), false)
  assert.equal(recordedManualIssue(manual, 'member-a'), false)
  assert.equal(recordedManualIssue({ ...manual, sets: [[1,2,3,4,5,7]] }, 'member-a', [operation]), false)
  assert.equal(hasAutomaticRecoTombstone('member-a', 1245, [manual], [], [operation]), false)
  assert.equal(hasAutomaticRecoTombstone('member-a', 1245, [manual]), true)
})

test('a new manual issue cannot remove an existing automatic or legacy tombstone', () => {
  assert.equal(hasAutomaticRecoTombstone('member-a', 1245, [manual, legacy], [], [operation]), true)
  assert.equal(hasAutomaticRecoTombstone('member-a', 1245, [manual], archive([legacy as unknown as Record<string, unknown>]), [operation]), true)
  assert.equal(hasAutomaticRecoTombstone('member-a', 1245, [], archive([manual]), [operation]), false)
})

test('unresolved or rejected manual delivery blocks automatic regardless of new request identifiers', () => {
  for (const status of ['claimed', 'unknown', 'rejected'] as const) {
    assert.equal(hasAutomaticRecoTombstone('member-a', 1245, [], [], [{ ...operation, status }]), true)
  }
  assert.equal(hasAutomaticRecoTombstone('member-b', 1245, [], [], [{ ...operation, status: 'unknown' }]), false)
})

test('aggregation includes every distinct same-round issue and each local combination', () => {
  const extra = { ...manual, manual_request_id: '00000000-0000-4000-8000-000000000002', sets: [[1,2,3,4,5,7], [1,2,3,4,8,9]] }
  assert.deepEqual(roundRecoSets([manual, extra, legacy, { ...legacy, round_no: 1244 }], 1245), [
    { numbers: manual.sets[0], comboIndex: 1 }, { numbers: extra.sets[0], comboIndex: 2 },
    { numbers: extra.sets[1], comboIndex: 3 }, { numbers: legacy.sets[0], comboIndex: 4 },
  ])
  assert.equal(roundRecoSets([manual, manual, legacy, legacy], 1245).length, 2)
})

test('recount removes previous round indexes and losing issues while preserving other rounds', () => {
  const win = { round_no: 1245, draw_date: null, rank: 5, prize: 5000, combo_index: 1, source: 'reco' as const }
  const older = { ...win, round_no: 1244 }
  const shifted = { ...win, combo_index: 2 }
  assert.deepEqual(replaceRoundWinRecords([win, older], [shifted], 1245), [shifted, older])
  assert.deepEqual(replaceRoundWinRecords([win, older], [], 1245), [older])
})
