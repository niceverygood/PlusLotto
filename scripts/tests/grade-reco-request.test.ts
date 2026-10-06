import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestGradeRecoBatch } from '../../src/lib/gradeRecoRequest'

const reply = () => ({ ok: true, round_no: 1245, issued: 1, smsSent: 0, smsFail: 0, errors: 0,
  reviewRequired: 0, remaining: 0, results: [
    { member_id: 'a', status: 'issued', sms_outcome: 'not_requested', round_no: 1245 },
    { member_id: 'b', status: 'skipped', code: 'ALREADY', round_no: 1245 },
  ] })
test('grade batch keeps old once-only, no-SMS protocol and validates every receipt', async () => {
  let calls = 0
  const result = await requestGradeRecoBatch(['a', 'b'], 'synthetic-token', async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body, { memberIds: ['a', 'b'], mode: 'manual', alsoSms: false, dryRun: false })
    assert.equal('operationId' in body, false)
    return new Response(JSON.stringify(reply()))
  })
  assert.deepEqual(result, { issued: 1, skipped: 1, round_no: 1245 })
  assert.equal(calls, 1)
})
test('partial, duplicate, missing and unknown batch receipts stop without retry', async () => {
  const variants = [
    { ...reply(), remaining: 1 }, { ...reply(), smsSent: 1 }, { ...reply(), reviewRequired: 1 },
    { ...reply(), results: reply().results.slice(0, 1) },
    { ...reply(), results: [reply().results[0], reply().results[0]] },
    { ...reply(), results: [reply().results[0], { ...reply().results[1], status: 'review_required' }] },
  ]
  for (const response of variants) {
    let calls = 0
    await assert.rejects(requestGradeRecoBatch(['a','b'], 'synthetic-token', async () => {
      calls++; return new Response(JSON.stringify(response))
    }))
    assert.equal(calls, 1)
  }
})
test('network loss and authentication failure are not retried', async () => {
  let calls = 0
  await assert.rejects(requestGradeRecoBatch(['a'], 'synthetic-token', async () => { calls++; throw new Error('offline') }))
  assert.equal(calls, 1)
  await assert.rejects(requestGradeRecoBatch(['a'], 'synthetic-token', async () => { calls++; return new Response('{}', { status: 401 }) }))
  assert.equal(calls, 2)
})
test('oversized or duplicate targets fail before network', async () => {
  const unreachable = async (): Promise<Response> => { throw new Error('must not call') }
  await assert.rejects(requestGradeRecoBatch(Array.from({length: 51}, (_, n) => String(n)), 'synthetic-token', unreachable), /명단/)
  await assert.rejects(requestGradeRecoBatch(['a','a'], 'synthetic-token', unreachable), /명단/)
})
