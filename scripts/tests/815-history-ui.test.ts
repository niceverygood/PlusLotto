import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLegacyHistoryPage } from '../../src/features/members/legacyHistory'

const memo = { legacy_idx: '1', source_insert_datetime: '2026-08-31 15:55:54', body: '상담 내용' }
const page = (rows: unknown[]) => ({ rows, has_more: false, next_cursor: null })
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
