import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestGradeRecoBatch } from '../../src/lib/gradeRecoRequest'
import { parseRecoRequest } from '../../api/weekly-reco'

const reply = (id = 'a', skipped = false) => ({ ok: true, round_no: 1245, issued: skipped ? 0 : 1,
  smsSent: 0, smsFail: 0, errors: 0, reviewRequired: 0, remaining: 0,
  results: [{ member_id: id, status: skipped ? 'skipped' : 'issued', sms_outcome: 'not_requested', round_no: 1245 }] })

test('grade batch passes the real parser as sequential exact-one requests with no new UUID or SMS', async () => {
  const called: string[] = []
  const result = await requestGradeRecoBatch(['a', 'b'], 'synthetic-token', async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const parsed = parseRecoRequest({ method: 'POST', body })
    const id = body.memberIds[0] as string
    called.push(id)
    assert.deepEqual(body, { memberIds: [id], mode: 'manual', alsoSms: false, dryRun: false,
      ...(id === 'a' ? {} : { expectedRound: 1245 }) })
    assert.equal(parsed.operationId, undefined)
    assert.equal(parsed.alsoSms, false)
    assert.deepEqual(parsed.memberIds, [id])
    return new Response(JSON.stringify(reply(id, id === 'b')))
  })
  assert.deepEqual(result, { issued: 1, skipped: 1, round_no: 1245 })
  assert.deepEqual(called, ['a', 'b'])
})

test('partial, duplicate, wrong-member, missing and unknown receipts stop without retry or advancing', async () => {
  const variants = [
    { ...reply(), remaining: 1 }, { ...reply(), smsSent: 1 }, { ...reply(), reviewRequired: 1 },
    { ...reply(), results: [] }, { ...reply(), results: [reply().results[0], reply().results[0]] },
    { ...reply(), results: [{ ...reply().results[0], member_id: 'other' }] },
    { ...reply(), results: [{ ...reply().results[0], status: 'review_required' }] },
  ]
  for (const response of variants) {
    let calls = 0
    await assert.rejects(requestGradeRecoBatch(['a','b'], 'synthetic-token', async () => {
      calls++; return new Response(JSON.stringify(response))
    }))
    assert.equal(calls, 1)
  }
})

test('partial completion followed by response loss never retries earlier member or continues to later member', async () => {
  const called: string[] = []
  await assert.rejects(requestGradeRecoBatch(['a','b','c'], 'synthetic-token', async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    parseRecoRequest({ method: 'POST', body })
    called.push(body.memberIds[0])
    if (body.memberIds[0] === 'b') throw new Error('response lost')
    return new Response(JSON.stringify(reply(body.memberIds[0])))
  }))
  assert.deepEqual(called, ['a','b'])
})

test('subsequent requests pin the first round and a changed-round receipt stops processing', async () => {
  const called: string[] = []
  await assert.rejects(requestGradeRecoBatch(['a','b','c'], 'synthetic-token', async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const parsed = parseRecoRequest({ method: 'POST', body })
    called.push(body.memberIds[0])
    if (called.length === 1) return new Response(JSON.stringify(reply('a')))
    assert.equal(parsed.expectedRound, 1245)
    return new Response(JSON.stringify({ ...reply('b'), round_no: 1246 }))
  }))
  assert.deepEqual(called, ['a','b'])
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
