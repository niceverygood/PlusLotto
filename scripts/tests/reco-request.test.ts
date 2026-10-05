import assert from 'node:assert/strict'
import test from 'node:test'
import { requestRecommendation } from '../../src/lib/recoRequest.ts'

const input = { memberId: 'synthetic-member', setCount: 1, alsoSms: true }
const good = {
  ok: true, smsSent: 1, smsFail: 0, reviewRequired: 0,
  results: [{ member_id: input.memberId, status: 'issued', round_no: 1245, sets: [[1, 2, 3, 4, 5, 6]], sms_outcome: 'accepted' }],
}
const reply = (data: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(data), { status })

test('single exact member POST does not send browser-generated numbers or mutate member data', async () => {
  let calls = 0
  const result = await requestRecommendation(input, 'synthetic-token', async (url, options) => {
    calls++
    assert.equal(url, '/api/weekly-reco')
    assert.equal(options?.method, 'POST')
    assert.deepEqual(JSON.parse(String(options?.body)), { memberIds: [input.memberId], mode: 'manual', dryRun: false, alsoSms: true, setCount: 1 })
    return new Response(JSON.stringify(good))
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { round_no: 1245, sets: [[1, 2, 3, 4, 5, 6]] })
})

test('unknown network result is not automatically repeated', async () => {
  let calls = 0
  await assert.rejects(requestRecommendation(input, 'token', async () => { calls++; throw new Error('lost reply') }), /다시 실행하지 말고/)
  assert.equal(calls, 1)
})

test('expired authentication does not repeat the action', async () => {
  let calls = 0
  await assert.rejects(requestRecommendation(input, 'token', async () => { calls++; return new Response('{}', { status: 401 }) }), /로그인이 만료/)
  assert.equal(calls, 1)
})

test('accepted provider result with receipt-record error is not presented as complete', async () => {
  await assert.rejects(requestRecommendation(input, 'token', reply({ ...good, reviewRequired: 1 })), /접수 여부/)
})

test('existing claim cannot look like a new successful issue or delivery', async () => {
  await assert.rejects(requestRecommendation(input, 'token', reply({ ...good, results: [{ ...good.results[0], status: 'review_required' }] })), /접수 여부/)
})

test('disabled SMS cannot look like successful requested delivery', async () => {
  await assert.rejects(requestRecommendation(input, 'token', reply({ ...good, smsSent: 0, results: [{ ...good.results[0], sms_outcome: 'not_requested' }] })), /접수 여부/)
})

test('issue-only result can return without a provider request', async () => {
  assert.deepEqual(await requestRecommendation({ ...input, alsoSms: false }, 'token', reply({ ...good, smsSent: 0, results: [{ ...good.results[0], sms_outcome: 'not_requested' }] })), { round_no: 1245, sets: [[1, 2, 3, 4, 5, 6]] })
})

test('wrong member or malformed result cannot be accepted', async () => {
  for (const altered of [
    { ...good.results[0], member_id: 'different-member' },
    { ...good.results[0], sets: [[1, 1, 2, 3, 4, 5]] },
    { ...good.results[0], sets: [] },
  ]) await assert.rejects(requestRecommendation(input, 'token', reply({ ...good, results: [altered] })), /접수 여부/)
})

test('invalid requested count or absent auth makes no request', async () => {
  const unexpected: typeof fetch = async () => { assert.fail('must not fetch') }
  await assert.rejects(requestRecommendation({ ...input, setCount: 0 }, 'token', unexpected), /조합 수/)
  await assert.rejects(requestRecommendation(input, '', unexpected), /로그인/)
})
