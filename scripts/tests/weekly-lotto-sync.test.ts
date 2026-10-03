import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createWeeklyLottoSyncHandler, latestCompletedRound, parseDrawResponse, syncPrizeForRank } from '../../api/weekly-lotto-sync.ts'

const handler = createWeeklyLottoSyncHandler({ winSms: true })
const noSmsHandler = createWeeklyLottoSyncHandler({ winSms: false })
const OFFICIAL = { ltEpsd: 1244, ltRflYmd: '20261003', tm1WnNo: 1, tm2WnNo: 13, tm3WnNo: 18,
  tm4WnNo: 26, tm5WnNo: 34, tm6WnNo: 38, bnsWnNo: 25, rnk1WnAmt: 1604686625,
  rnk2WnAmt: 60175749, rnk3WnAmt: 1290287, wholEpsdSumNtslAmt: 123436098000 }
const responseFor = (rows: unknown[] = [OFFICIAL]) => ({ data: { list: rows } })
type Round = ReturnType<typeof parseDrawResponse>[number]
const pending = (): Round => parseDrawResponse(responseFor(), 1244, 1244)[0]
const prior = (): Round => ({ ...pending(), round_no: 1243, draw_date: '2026-09-26T11:45:00.000Z', confirmed_at: '2026-09-26T12:00:00Z' })
type Member = { id: string; name: string; phone: string; grade: string; win_history: string | null;
  is_deleted: boolean; is_suspended: boolean; is_withdrawn: boolean; meta: Record<string, unknown> }
const member = (id = 'fixture-1'): Member => ({ id, name: 'fixture', phone: '01000000000', grade: 'vip',
  win_history: null, is_deleted: false, is_suspended: false, is_withdrawn: false,
  meta: { unrelated: 'keep', weekly_recos: [{ round_no: 1244, sets: [[1, 13, 18, 2, 3, 4], [1, 13, 18, 26, 2, 3]] }] } })
type Job = { round_no: number; status: 'pending' | 'running' | 'complete' | 'blocked'; total: number; done: number; winners: number; queueSms: boolean }
type Sms = { id: number; claim_token: string; round_no: number; member_id: string; rank: number; member: Member;
  status: 'pending' | 'claimed' | 'accepted' | 'failed' | 'unknown' | 'skipped' }
type Fixture = {
  rounds: Round[]; members: Member[]; jobs: Job[]; outbox: Sms[]; logs: Record<string, unknown>[]; smsRecords: { id: number; status: string }[]
  upstream: unknown; upstreamStatus: number; upstreamCalls: number; vendorCalls: number; vendorMode: 'accepted' | 'failed' | 'unknown' | 'throw'
  calls: string[]; failRpc: string | null; failBatchOnce: boolean; loseBatchResponse: boolean; loseFinishResponse: boolean; loseClaimResponse: boolean; finishCommitsBeforeLoss: boolean;
  failLogs: boolean; invalidHealth: boolean; advanceAtBatch: number; batchSize: number; smsEnabled: boolean; claimSkipLimit: number
}
async function fixture(t: TestContext, options: Partial<Fixture> = {}) {
  const NOW = Date.parse('2026-10-03T12:55:00Z')
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) })
  const state: Fixture = { rounds: [prior()], members: [member()], jobs: [], outbox: [], logs: [], smsRecords: [], upstream: responseFor(), upstreamStatus: 200,
    upstreamCalls: 0, vendorCalls: 0, vendorMode: 'accepted', calls: [], failRpc: null, failBatchOnce: false, loseBatchResponse: false,
    loseFinishResponse: false, loseClaimResponse: false, finishCommitsBeforeLoss: false, failLogs: false, invalidHealth: false, advanceAtBatch: 0, batchSize: 100, smsEnabled: true, claimSkipLimit: 500, ...options }
  const vars = { CRON_SECRET: 'synthetic-cron', SUPABASE_URL: 'https://lotto-sync-fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key', VERCEL_URL: 'sync-fixture.example' }
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  Object.assign(process.env, vars)
  const originalFetch = globalThis.fetch
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const failure = () => json({ message: 'synthetic error only', code: 'XX000' }, 500)
  const health = () => ({ schema_version: state.invalidHealth ? 999 : 1,
    max_round: Math.max(0, ...state.rounds.map((r) => r.round_no)), max_confirmed_round: Math.max(0, ...state.rounds.filter((r) => r.confirmed_at).map((r) => r.round_no)),
    jobs: structuredClone(state.jobs), sms: Object.fromEntries(['pending', 'claimed', 'accepted', 'failed', 'unknown', 'skipped'].map((status) => [status, state.outbox.filter((s) => s.status === status).length])) })
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    if (url.hostname === 'www.dhlottery.co.kr') { state.calls.push('official'); state.upstreamCalls++; return json(state.upstream, state.upstreamStatus) }
    if (url.hostname === 'sync-fixture.example') {
      state.calls.push('provider'); state.vendorCalls++
      assert.ok(state.outbox.some((s) => s.member_id === body.member_id && s.status === 'claimed'), 'provider is never called before durable claim')
      assert.ok(init?.signal, 'provider request is bounded by an abort timeout')
      if (state.vendorMode === 'throw') throw new TypeError('synthetic transport loss')
      if (state.vendorMode === 'failed') return json({ ok: false, code: 'D179' })
      if (state.vendorMode === 'unknown') return json({ ok: false, code: 'EXCEPTION' }, 500)
      return json({ ok: true, code: '0', cmid: 'synthetic-receipt' })
    }
    assert.equal(url.hostname, 'lotto-sync-fixture.supabase.co', 'tests must never use a real network destination')
    const name = url.pathname.split('/').at(-1) ?? ''
    state.calls.push(name)
    if (url.pathname.includes('/rpc/')) {
      if (state.failRpc === name) return failure()
      if (name === 'lotto_sync_health') return json(health())
      if (name === 'lotto_sync_record_tick') return json({ ok: true })
      if (name === 'lotto_sync_start') {
        const r = body.p_round as Round
        assert.equal(r.confirmed_at, null, 'API never confirms before transactional aggregation')
        if (state.rounds.some((old) => old.round_no === r.round_no)) return json({ ok: true, created: false, round_no: r.round_no, status: 'existing' })
        state.rounds.push(structuredClone(r))
        state.jobs.push({ round_no: r.round_no, status: 'pending', total: state.members.length, done: 0, winners: 0, queueSms: body.p_queue_sms })
        return json({ ok: true, created: true, round_no: r.round_no, status: 'pending' })
      }
      if (name === 'lotto_sync_batch') {
        if (state.failBatchOnce) { state.failBatchOnce = false; return failure() }
        const job = state.jobs.find((j) => j.status !== 'complete')
        if (!job) return json({ ok: true, status: 'idle' })
        if (job.status === 'blocked') return json({ ok: false, status: 'blocked', error: 'RECO_INVALID' })
        assert.equal(body.p_limit, 100)
        const processed = Math.min(job.total - job.done, state.batchSize, body.p_limit)
        for (const m of state.members.slice(job.done, job.done + processed)) {
          m.meta = { ...m.meta, win_records: [{ round_no: job.round_no, rank: 4, prize: 50000, combo_index: 1, source: 'reco' }] }
          m.win_history = `${job.round_no}회 4등`
          job.winners++
          if (job.queueSms && state.smsEnabled && !state.outbox.some((s) => s.round_no === job.round_no && s.member_id === m.id)) {
            state.outbox.push({ id: state.outbox.length + 1, claim_token: 'synthetic-claim', round_no: job.round_no, member_id: m.id,
              rank: 4, member: structuredClone(m), status: 'pending' })
          }
        }
        job.done += processed; job.status = job.done === job.total ? 'complete' : 'running'
        if (job.status === 'complete') state.rounds.find((r) => r.round_no === job.round_no)!.confirmed_at = new Date().toISOString()
        if (state.advanceAtBatch) { t.mock.timers.setTime(Date.now() + state.advanceAtBatch); state.advanceAtBatch = 0 }
        if (state.loseBatchResponse) { state.loseBatchResponse = false; return failure() }
        return json({ ok: true, round_no: job.round_no, status: job.status, processed, remaining: job.total - job.done, winners: job.winners })
      }
      if (name === 'lotto_sync_claim_sms') {
        assert.equal(body.p_limit, 1, 'claim one recipient at a time to bound abandoned claims')
        let skipped = 0
        for (const s of state.outbox.filter((s) => s.status === 'pending')) {
          const held = s.member.meta.reco_paused === true && s.member.meta.reco_pause_reason === 'legacy_import_review'
          if (!state.smsEnabled || held || s.member.is_suspended || s.member.is_withdrawn || s.member.is_deleted) { s.status = 'skipped'; skipped++; if (skipped >= state.claimSkipLimit) return json([]); continue }
          s.status = 'claimed'
          state.members.find((m) => m.id === s.member_id)!.meta.win_sms_rounds = [s.round_no]
          state.smsRecords.push({ id: s.id, status: '접수확인필요(요청중)' })
          if (state.loseClaimResponse) { state.loseClaimResponse = false; return failure() }
          return json([structuredClone(s)])
        }
        return json([])
      }
      if (name === 'lotto_sync_finish_sms') {
        const s = state.outbox.find((s) => s.id === body.p_id)
        assert.ok(s); assert.equal(s.status, 'claimed'); assert.equal(body.p_claim_token, s.claim_token)
        if (state.loseFinishResponse) {
          state.loseFinishResponse = false
          if (state.finishCommitsBeforeLoss) {
            s.status = body.p_status
            state.smsRecords.find((r) => r.id === s.id)!.status = '발송완료'
          }
          return failure()
        }
        s.status = body.p_status
        const record = state.smsRecords.find((r) => r.id === s.id)!
        record.status = s.status === 'accepted' ? '발송완료' : `접수확인필요(당첨알림:${body.p_provider_result.code})`
        return json({ ok: true })
      }
      throw new Error(`unhandled RPC ${name}`)
    }
    if (name === 'site_settings') return json([{ sms: { oneshot_enabled: state.smsEnabled, sender_no: '0200000000' }, win_sms: { enabled: state.smsEnabled, ranks: [4, 5], paid: true, free: false }, win_messages: [{ rank: 4, body: '$name $contents' }, { rank: 5, body: '$name $contents' }] }])
    if (name === 'logs') { if (state.failLogs) return failure(); state.logs.push(body); return json([], 201) }
    throw new Error(`API must not bypass durable RPC with direct member/round/SMS access: ${url.pathname}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    t.mock.timers.reset()
  })
  async function invoke(recover?: unknown, authorization = 'Bearer synthetic-cron', noSms = false) {
    let status = 200
    let result: Record<string, unknown> = {}
    const res = { status(value: number) { status = value; return this }, json(body: Record<string, unknown>) { result = body } }
    await (noSms ? noSmsHandler : handler)({ headers: { authorization }, query: recover === undefined ? {} : { recover_round: recover } }, res)
    return { status, body: result }
  }
  return { state, invoke }
}

test('completed round boundary is KST Saturday 20:45 and remains healthy next morning', () => {
  assert.equal(latestCompletedRound(Date.parse('2026-10-03T20:44:59+09:00')), 1243)
  assert.equal(latestCompletedRound(Date.parse('2026-10-03T20:45:00+09:00')), 1244)
  assert.equal(latestCompletedRound(Date.parse('2026-10-04T08:00:00+09:00')), 1244)
})
test('strict official parsing accepts numeric strings and preserves official total sales', () => {
  const [row] = parseDrawResponse(responseFor([{ ...OFFICIAL, ltEpsd: '1244', tm1WnNo: '1', rnk1WnAmt: '1604686625' }]), 1244, 1244)
  assert.equal(row.total_sales, 123436098000); assert.equal(syncPrizeForRank(row, 4), 50000); assert.equal(syncPrizeForRank(row, 5), 5000)
  for (const override of [{ ltEpsd: 1245 }, { ltEpsd: null }, { ltEpsd: 'bad' }, { tm2WnNo: 1 }, { bnsWnNo: 1 }, { ltRflYmd: '20260931' }, { rnk1WnAmt: null }, { wholEpsdSumNtslAmt: null }, { wholEpsdSumNtslAmt: 0 }]) {
    assert.throws(() => parseDrawResponse(responseFor([{ ...OFFICIAL, ...override }]), 1244, 1244))
  }
  assert.throws(() => parseDrawResponse(responseFor([OFFICIAL, OFFICIAL]), 1244, 1244))
})
test('auth failure does not call upstream, DB, or SMS', async (t) => {
  const { state, invoke } = await fixture(t)
  assert.equal((await invoke(undefined, 'wrong')).status, 401); assert.equal(state.calls.length, 0)
})
test('missing health RPC or incompatible schema fails closed before external access and persists low-PII stage code', async (t) => {
  const { state, invoke } = await fixture(t, { failRpc: 'lotto_sync_health' })
  assert.equal((await invoke()).body.code, 'HEALTH_READ')
  state.failRpc = null; state.invalidHealth = true
  assert.equal((await invoke()).body.code, 'RPC_CONTRACT')
  assert.equal(state.upstreamCalls + state.vendorCalls, 0)
  assert.equal(JSON.stringify(state.logs).includes('01000000000'), false)
  assert.deepEqual(state.logs.at(-1)?.meta, { code: 'RPC_CONTRACT', stage: 'health', expected_round: 1244 })
})
test('upstream no data, bad format, invalid balls, and HTTP errors are visible failures before job creation', async (t) => {
  const { state, invoke } = await fixture(t)
  for (const [upstream, upstreamStatus, code] of [[responseFor([]), 200, 'UPSTREAM_NOT_READY'], [{ changed: [] }, 200, 'UPSTREAM_FORMAT'], [responseFor([{ ...OFFICIAL, tm2WnNo: 1 }]), 200, 'UPSTREAM_INVALID'], [{}, 403, 'UPSTREAM_FETCH']] as const) {
    state.upstream = upstream; state.upstreamStatus = upstreamStatus
    const result = await invoke(); assert.ok(result.status >= 500); assert.equal(result.body.code, code)
    assert.equal(state.rounds.length, 1); assert.equal(state.jobs.length, 0)
  }
  assert.equal(state.vendorCalls, 0)
})
test('new round completes transactional batches and does not write members or confirmed_at directly', async (t) => {
  const { state, invoke } = await fixture(t, { smsEnabled: false, batchSize: 1, members: [member('a'), member('b')] })
  assert.equal((await invoke()).body.complete, true)
  assert.equal(state.jobs[0].done, 2); assert.ok(state.rounds[1].confirmed_at)
  assert.equal(state.members[0].meta.unrelated, 'keep'); assert.equal(state.vendorCalls, 0)
})
test('failure after round persistence resumes before maxRound no-op and requires no upstream response', async (t) => {
  const { state, invoke } = await fixture(t, { failBatchOnce: true, smsEnabled: false })
  assert.equal((await invoke()).body.code, 'AGGREGATION_RPC')
  assert.equal(state.rounds[1].confirmed_at, null); assert.equal(state.jobs[0].done, 0)
  state.upstreamStatus = 503
  const second = await invoke()
  assert.equal(second.status, 200); assert.equal(second.body.complete, true)
  assert.equal(state.upstreamCalls, 1); assert.equal(state.jobs[0].done, 1)
})
test('lost response after committed batch never tallies the same snapshot twice', async (t) => {
  const { state, invoke } = await fixture(t, { loseBatchResponse: true, smsEnabled: false, batchSize: 1, members: [member('a'), member('b')] })
  assert.equal((await invoke()).status, 503); assert.equal(state.jobs[0].done, 1)
  assert.equal((await invoke()).status, 200); assert.equal(state.jobs[0].done, 2); assert.equal(state.jobs[0].winners, 2)
})
test('blocked source data is visible and never followed by provider calls', async (t) => {
  const { state, invoke } = await fixture(t, { rounds: [prior(), pending()], jobs: [{ round_no: 1244, status: 'blocked', total: 1, done: 0, winners: 0, queueSms: true }] })
  assert.equal((await invoke()).body.code, 'AGGREGATION_BLOCKED'); assert.equal(state.vendorCalls + state.upstreamCalls, 0)
})
test('deadline returns 202 complete:false and next invocation resumes saved work', async (t) => {
  const { state, invoke } = await fixture(t, { advanceAtBatch: 181_000, smsEnabled: false, batchSize: 1, members: [member('a'), member('b')] })
  const first = await invoke(); assert.equal(first.status, 202); assert.equal(first.body.complete, false)
  assert.equal(state.rounds[1].confirmed_at, null); assert.equal(state.jobs[0].done, 1)
  assert.equal((await invoke()).status, 200); assert.equal(state.jobs[0].done, 2)
})
test('existing manually restored 1244 is a no-op: heartbeat only and never enqueues historical SMS', async (t) => {
  const restored = { ...pending(), confirmed_at: '2026-10-03T13:13:55Z' }
  const { state, invoke } = await fixture(t, { rounds: [prior(), restored] })
  assert.equal((await invoke()).status, 200)
  assert.equal(state.upstreamCalls + state.vendorCalls + state.jobs.length + state.logs.length, 0)
  assert.equal(state.calls.includes('lotto_sync_record_tick'), true)
  assert.equal(state.calls.includes('site_settings'), false)
})
test('recovery parameter cannot trigger historical reaggregation or SMS', async (t) => {
  const { state, invoke } = await fixture(t)
  for (const recover of ['1244', ['1244'], '1245']) assert.equal((await invoke(recover)).body.code, 'RECOVERY_UNSUPPORTED')
  assert.equal(state.upstreamCalls + state.vendorCalls + state.jobs.length, 0)
})
test('concurrent invocations create one job and claim at most one SMS per member and round', async (t) => {
  const { state, invoke } = await fixture(t)
  await Promise.all([invoke(), invoke()])
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].done, 1)
  assert.equal(state.vendorCalls, 1); assert.equal(state.smsRecords.length, 1); assert.equal(state.outbox[0].status, 'accepted')
  assert.equal((await invoke()).status, 200); assert.equal(state.vendorCalls, 1)
})
test('provider failure is held for review and excluded from the existing generic retry predicate', async (t) => {
  const { state, invoke } = await fixture(t, { vendorMode: 'failed' })
  assert.equal((await invoke()).body.code, 'SMS_REVIEW_REQUIRED')
  assert.equal(state.outbox[0].status, 'failed'); assert.equal(state.smsRecords[0].status.startsWith('실패'), false)
  assert.equal((await invoke()).body.code, 'SMS_REVIEW_REQUIRED'); assert.equal(state.vendorCalls, 1)
})
test('provider uncertainty remains unknown and never auto retries', async (t) => {
  const { state, invoke } = await fixture(t, { vendorMode: 'throw' })
  assert.equal((await invoke()).body.code, 'SMS_REVIEW_REQUIRED')
  assert.equal(state.outbox[0].status, 'unknown'); assert.equal(state.smsRecords[0].status.startsWith('실패'), false)
  await invoke(); assert.equal(state.vendorCalls, 1)
})
test('provider accepted but receipt write failed leaves durable claimed record and does not resend', async (t) => {
  const { state, invoke } = await fixture(t, { loseFinishResponse: true })
  assert.equal((await invoke()).body.code, 'SMS_RECORD')
  assert.equal(state.outbox[0].status, 'claimed'); assert.equal(state.smsRecords[0].status.startsWith('실패'), false)
  assert.equal((await invoke()).body.code, 'SMS_REVIEW_REQUIRED'); assert.equal(state.vendorCalls, 1)
})
test('held migration members are skipped without requesting SMS or changing hold metadata', async (t) => {
  const held = member(); held.meta = { ...held.meta, reco_paused: true, reco_pause_reason: 'legacy_import_review' }
  const { state, invoke } = await fixture(t, { members: [held] })
  assert.equal((await invoke()).status, 200); assert.equal(state.vendorCalls, 0)
  assert.equal(state.members[0].meta.reco_paused, true); assert.equal(state.outbox[0].status, 'skipped')
})
test('88 aggregate-only factory does not query SMS settings, claim outbox, or invoke provider', async (t) => {
  const { state, invoke } = await fixture(t)
  assert.equal((await invoke(undefined, undefined, true)).status, 200)
  assert.equal(state.jobs[0].queueSms, false); assert.equal(state.outbox.length, 0); assert.equal(state.vendorCalls, 0)
  assert.equal(state.calls.includes('site_settings'), false); assert.equal(state.calls.includes('lotto_sync_claim_sms'), false)
})
test('audit write failure still returns the originating failure and no false completion', async (t) => {
  const { invoke } = await fixture(t, { failLogs: true, upstreamStatus: 503 })
  const result = await invoke(); assert.equal(result.body.code, 'UPSTREAM_FETCH'); assert.equal(result.body.auditRecorded, false)
})

test('an older unfinished recount resumes even when the latest round is already confirmed', async (t) => {
  const old = { ...prior(), confirmed_at: null }
  const current = { ...pending(), confirmed_at: '2026-10-03T13:13:55Z' }
  const { state, invoke } = await fixture(t, { rounds: [old, current],
    jobs: [{ round_no: 1243, status: 'pending', total: 1, done: 0, winners: 0, queueSms: false }] })
  assert.equal((await invoke()).status, 200)
  assert.equal(state.jobs[0].done, 1); assert.equal(state.upstreamCalls + state.vendorCalls, 0)
})
test('a skipped claim page does not defer valid recipients behind it until the next cron', async (t) => {
  const held = member('a'); held.meta = { ...held.meta, reco_paused: true, reco_pause_reason: 'legacy_import_review' }
  const { state, invoke } = await fixture(t, { members: [held, member('b')], claimSkipLimit: 1 })
  assert.equal((await invoke()).status, 200)
  assert.equal(state.outbox[0].status, 'skipped'); assert.equal(state.outbox[1].status, 'accepted')
  assert.equal(state.vendorCalls, 1)
})

test('lost claim response leaves review evidence without any provider call or retry', async (t) => {
  const { state, invoke } = await fixture(t, { loseClaimResponse: true })
  assert.equal((await invoke()).body.code, 'SMS_CLAIM')
  assert.equal(state.outbox[0].status, 'claimed'); assert.equal(state.vendorCalls, 0)
  assert.equal((await invoke()).body.code, 'SMS_REVIEW_REQUIRED'); assert.equal(state.vendorCalls, 0)
})
test('lost finish response after its commit is healthy on retry and does not call provider again', async (t) => {
  const { state, invoke } = await fixture(t, { loseFinishResponse: true, finishCommitsBeforeLoss: true })
  assert.equal((await invoke()).body.code, 'SMS_RECORD')
  assert.equal(state.outbox[0].status, 'accepted')
  assert.equal((await invoke()).status, 200); assert.equal(state.vendorCalls, 1)
})
