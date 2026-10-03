// Plus-only compatibility check: 88 intentionally has no generic smsRetry module.
import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetriableFailure } from '../../src/lib/smsRetry.ts'

test('durable winner receipts never enter the existing automatic failed-SMS retry path', () => {
  for (const status of ['접수확인필요(요청중)', '접수확인필요(당첨알림:NET)', '접수확인필요(당첨알림:EXCEPTION)',
    '접수확인필요(당첨알림:D179)', '발송보류(당첨알림)', '발송완료']) {
    assert.equal(isRetriableFailure(status), false, status)
  }
  // A real distinction from legacy recommendation retry, which intentionally retries credit failures.
  assert.equal(isRetriableFailure('실패(D179)'), true)
})
