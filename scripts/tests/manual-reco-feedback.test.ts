import assert from 'node:assert/strict'
import test from 'node:test'
import { manualRecoCount, manualRecoSuccessMessage } from '../../src/lib/manualRecoFeedback.ts'

test('blank follows the displayed configured quantity without treating zero as missing', () => {
  assert.equal(manualRecoCount('', 20), 20)
  assert.equal(manualRecoCount('  ', null), 30)
  assert.throws(() => manualRecoCount('', 0), /1~100/)
})

test('explicit bounded quantity is honored, while zero and malformed quantities are rejected', () => {
  assert.equal(manualRecoCount('1', 0), 1)
  assert.equal(manualRecoCount('100', 20), 100)
  for (const draft of ['0', '000', '101', '-1', '1.5', 'Infinity', '999999999999999999']) {
    assert.throws(() => manualRecoCount(draft, 20), /1~100/)
  }
  assert.throws(() => manualRecoCount('', 101), /1~100/)
})

test('success copy separates provider acceptance, number-only issuance, and mock data', () => {
  const result = { round_no: 1245, sets: [[1, 2, 3, 4, 5, 6]] }
  assert.match(manualRecoSuccessMessage(result, true, true), /문자업체 접수를 확인/)
  assert.match(manualRecoSuccessMessage(result, true, true), /실제 수신 여부는 별도/)
  assert.match(manualRecoSuccessMessage(result, false, true), /문자 발송은 요청하지/)
  assert.doesNotMatch(manualRecoSuccessMessage(result, false, true), /문자업체 접수를 확인/)
  assert.match(manualRecoSuccessMessage(result, true, false), /시험 데이터/)
  assert.doesNotMatch(manualRecoSuccessMessage(result, true, false), /문자업체 접수를 확인/)
})
