import assert from 'node:assert/strict'
import test from 'node:test'
import { formatLegacySourceDatetime, parseLegacyHistoryPage } from '../../src/features/members/legacyHistory'

const memo = { legacy_idx: '1', source_insert_datetime: '2026-08-31 15:55:54', body: '상담 내용' }
const page = (rows: unknown[]) => ({ rows, has_more: false, next_cursor: null })
test('invalid legacy dates retain the original text instead of rolling into a different date', () => {
  for (const value of ['2025-02-29 18:01:02', '2025-01-01 24:00:00', '1900-02-29 18:01:02', '2025-04-31 18:01:02', '2025-01-01 23:59:60', '0000-00-00 00:00:00', '2025-01-01T18:01:02']) {
    assert.equal(formatLegacySourceDatetime(value), `${value} (시각 확인 필요)`)
  }
})
test('valid legacy wall times keep the standard display and leap years are exact', () => {
  for (const value of ['2024-02-29 18:01:02', '2000-02-29 18:01:02', '2026-08-31 15:55:54', '2025-01-01 23:59:59']) {
    assert.equal(formatLegacySourceDatetime(value), value.slice(0, 16))
  }
  assert.equal(formatLegacySourceDatetime(null), '-')
  assert.equal(formatLegacySourceDatetime(undefined), '-')
  assert.equal(formatLegacySourceDatetime(''), '-')
})
test('a browser DST gap cannot change a valid legacy wall time', () => {
  const previousTimezone = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    assert.equal(formatLegacySourceDatetime('2026-03-08 02:30:00'), '2026-03-08 02:30')
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})
test('missing next cursor cannot silently end or repeat a page', () => {
  assert.throws(() => parseLegacyHistoryPage('memo', { rows: [memo], has_more: true, next_cursor: null }))
  assert.throws(() => parseLegacyHistoryPage('memo', { rows: [], has_more: true, next_cursor: { at: '-infinity', idx: '1', round: 0 } }))
})
test('cursor integers are never rounded by JavaScript', () => {
  assert.throws(() => parseLegacyHistoryPage('memo', { rows: [memo], has_more: true, next_cursor: { at: '-infinity', idx: '9007199254740993', round: 0 } }))
})
test('memo duplicate keys are rejected', () => assert.throws(() => parseLegacyHistoryPage('memo', page([memo, memo]))))
test('winning source key includes the round and preserves exact money', () => {
  const win = { legacy_idx: '1', source_insert_datetime: null, round_no: 1000, rank: 5, numbers: [1, 2, 3, 4, 5, 6], prize: '5000' }
  assert.equal(parseLegacyHistoryPage('win', page([win, { ...win, round_no: 1001 }])).rows.length, 2)
  assert.throws(() => parseLegacyHistoryPage('win', page([{ ...win, prize: '9007199254740993' }])))
  assert.throws(() => parseLegacyHistoryPage('win', page([{ ...win, numbers: [1, 1, 2, 3, 4, 5] }])))
})
test('withheld SMS body remains distinct from preserved text', () => {
  const row = { ...memo, body: null, subject: null, contents_type: 'admin', body_policy: 'unreviewed_type_omitted' }
  const result = parseLegacyHistoryPage('sms', page([row])).rows[0]
  assert.equal(result.kind, 'sms')
  assert.throws(() => parseLegacyHistoryPage('sms', page([{ ...row, body_policy: 'send_now' }])))
})
test('wrong record kind and wrong round cursor are rejected', () => {
  assert.throws(() => parseLegacyHistoryPage('win', page([memo])))
  assert.throws(() => parseLegacyHistoryPage('memo', { rows: [memo], has_more: true, next_cursor: { at: '-infinity', idx: '1', round: 1000 } }))
})
