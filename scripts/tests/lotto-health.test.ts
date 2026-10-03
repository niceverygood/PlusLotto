import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { latestHealthJob, lottoHealthSchema, lottoHealthSummary, type LottoHealth } from '../../src/features/lotto/health.ts'

function ready(): LottoHealth {
  return {
    checked_at: '2026-10-03T13:40:00+00:00', expected_round: 1244, max_round: 1244, max_confirmed_round: 1244,
    jobs: [{ round_no: 1244, status: 'complete', total: 100, done: 100, winners: 20, rank_counts: { '1': 0, '2': 0, '3': 1, '4': 2, '5': 25 }, last_error: null, updated_at: '2026-10-03T13:39:00+00:00', completed_at: '2026-10-03T13:39:00+00:00' }],
    sms: { pending: 0, claimed: 0, accepted: 20, failed: 0, unknown: 0, skipped: 0 },
    last_attempt_at: '2026-10-03T13:39:00+00:00', last_success_at: '2026-10-03T13:39:00+00:00', last_error: null,
  }
}

test('complete recent round and provider acceptance are healthy, without claiming delivery', () => {
  const result = lottoHealthSummary(lottoHealthSchema.parse(ready()))
  assert.equal(result.tone, 'healthy')
  assert.doesNotMatch(result.description, /수신 완료|발송 완료/)
})
test('actual migration RPC output validates for both running and complete fixture jobs', () => {
  // Captured from the migration's isolated PGlite fixture, not production data or a hand-built mock.
  for (const state of ['running', 'complete']) {
    const raw: unknown = JSON.parse(readFileSync(new URL(`./fixtures/lotto-health-${state}.json`, import.meta.url), 'utf8'))
    const health = lottoHealthSchema.parse(raw)
    assert.equal(health.jobs[0].status, state)
    assert.equal(health.jobs[0].total, 2)
    assert.equal(health.jobs[0].done, state === 'complete' ? 2 : 1)
  }
})
test('fetch failure overrides a cached healthy result', () => {
  assert.equal(lottoHealthSummary(ready(), true).tone, 'unknown')
  assert.equal(lottoHealthSummary(undefined).tone, 'unknown')
})
test('missing telemetry is not silently treated as zero', () => {
  const { sms: _, ...missingSms } = ready()
  assert.equal(lottoHealthSchema.safeParse(missingSms).success, false)
  const missingRank = ready()
  delete (missingRank.jobs[0].rank_counts as Partial<typeof missingRank.jobs[0]['rank_counts']>)['3']
  assert.equal(lottoHealthSchema.safeParse(missingRank).success, false)
})
test('invalid counters and unknown job statuses cannot produce healthy results', () => {
  const health = ready()
  health.jobs[0].done = 101
  assert.equal(lottoHealthSchema.safeParse(health).success, false)
  assert.equal(lottoHealthSchema.safeParse({ ...ready(), jobs: [{ ...ready().jobs[0], status: 'unexpected' }] }).success, false)
})
test('a saved round with unfinished aggregation remains pending', () => {
  const health = ready()
  health.max_confirmed_round = 1243
  health.jobs[0] = { ...health.jobs[0], done: 50, status: 'running', completed_at: null }
  assert.equal(lottoHealthSummary(health).tone, 'pending')
})
test('stalled or blocked aggregation remains visible even if another round has completed', () => {
  const health = ready()
  health.jobs.push({ ...health.jobs[0], round_no: 1243, status: 'blocked', done: 40, completed_at: null })
  assert.equal(lottoHealthSummary(health).tone, 'attention')
  health.jobs[1].status = 'running'
  health.jobs[1].updated_at = '2026-10-03T13:00:00+00:00'
  assert.equal(lottoHealthSummary(health).tone, 'attention')
  assert.equal(latestHealthJob(health)?.round_no, 1244)
})
test('publication window distinguishes initial waiting from an overdue missing draw', () => {
  const health = ready()
  health.max_round = 1243
  health.max_confirmed_round = 1243
  health.jobs = []
  health.checked_at = '2026-10-03T12:05:00+00:00' // 21:05 KST
  assert.equal(lottoHealthSummary(health).tone, 'pending')
  health.checked_at = '2026-10-03T12:16:00+00:00'
  assert.equal(lottoHealthSummary(health).tone, 'attention')
})
test('missing and stale scheduled checks do not inherit a healthy round', () => {
  const health = ready()
  health.last_attempt_at = null
  assert.equal(lottoHealthSummary(health).tone, 'unknown')
  health.last_attempt_at = '2026-10-01T13:39:00+00:00'
  assert.equal(lottoHealthSummary(health).tone, 'unknown')
  health.last_attempt_at = '2026-10-03T13:24:00+00:00'
  assert.equal(lottoHealthSummary(health).tone, 'unknown')
})
test('provider ambiguous and failed outcomes require verification, with no resend advice', () => {
  for (const key of ['unknown', 'failed'] as const) {
    const health = ready()
    health.sms[key] = 1
    const summary = lottoHealthSummary(health)
    assert.equal(summary.tone, 'attention')
    assert.doesNotMatch(summary.description, /재전송|재발송/)
  }
})
test('pending SMS is distinct from completed aggregation and upstream errors stay visible', () => {
  const health = ready()
  health.sms.pending = 2
  assert.equal(lottoHealthSummary(health).tone, 'pending')
  health.sms.pending = 0
  health.sms.claimed = 1
  assert.equal(lottoHealthSummary(health).tone, 'pending')
  health.last_error = 'FETCH_FAILED'
  assert.equal(lottoHealthSummary(health).tone, 'attention')
})
test('bounded continuation is pending but SMS receipt-write errors override active claims', () => {
  const health = ready()
  health.last_error = 'IN_PROGRESS'
  assert.equal(lottoHealthSummary(health).tone, 'pending')
  health.sms.claimed = 1
  for (const code of ['SMS_RECORD', 'SMS_REVIEW_REQUIRED']) {
    health.last_error = code
    assert.equal(lottoHealthSummary(health).tone, 'attention')
  }
})
test('official publication delay is pending only inside its publication window', () => {
  const health = ready()
  health.max_round = health.max_confirmed_round = 1243
  health.checked_at = '2026-10-03T12:05:00+00:00'
  health.last_error = 'UPSTREAM_NOT_READY'
  assert.equal(lottoHealthSummary(health).tone, 'pending')
  health.checked_at = '2026-10-03T12:16:00+00:00'
  assert.equal(lottoHealthSummary(health).tone, 'attention')
})
