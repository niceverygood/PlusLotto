import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import handler, { latestCompletedRound, parseDrawResponse, syncPrizeForRank } from '../../api/weekly-lotto-sync.ts'

const OFFICIAL = { ltEpsd: 1244, ltRflYmd: '20261003', tm1WnNo: 1, tm2WnNo: 13, tm3WnNo: 18,
  tm4WnNo: 26, tm5WnNo: 34, tm6WnNo: 38, bnsWnNo: 25, rnk1WnAmt: 1604686625,
  rnk2WnAmt: 60175749, rnk3WnAmt: 1290287, wholEpsdSumNtslAmt: 123436098000 }
const responseFor = (rows: unknown[] = [OFFICIAL]) => ({ data: { list: rows } })
type Round = ReturnType<typeof parseDrawResponse>[number]
const pending = (): Round => parseDrawResponse(responseFor(), 1244, 1244)[0]
const prior = (): Round => ({ ...pending(), round_no: 1243, draw_date: '2026-09-26T11:45:00.000Z', confirmed_at: '2026-09-26T12:00:00Z' })
type Member = { id: string; name: string; phone: string; grade: string; win_history: string | null;
  is_suspended: boolean; is_withdrawn: boolean; meta: Record<string, unknown> | null }
const member = (id = 'fixture-1'): Member => ({ id, name: 'fixture', phone: '01000000000', grade: 'vip',
  win_history: null, is_suspended: false, is_withdrawn: false,
  meta: { unrelated: 'keep', reco_paused: true, reco_pause_reason: 'legacy_import_review',
    weekly_recos: [{ round_no: 1244, sets: [[1, 13, 18, 2, 3, 4], [1, 13, 18, 26, 2, 3]] }] } })

type Fixture = {
  rounds: Round[]; members: Member[]; logs: Record<string, unknown>[]; smsRecords: unknown[]
  upstream: unknown; upstreamStatus: number; upstreamCalls: number; vendorCalls: number
  memberQueries: URL[]; failMemberRead: boolean; failMemberWrite: boolean; insertConflict: boolean
  smsEnabled: boolean
}
async function fixture(t: TestContext, options: Partial<Fixture> = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-03T12:55:00Z') })
  const state: Fixture = { rounds: [prior()], members: [member()], logs: [], smsRecords: [], upstream: responseFor(), upstreamStatus: 200,
    upstreamCalls: 0, vendorCalls: 0, memberQueries: [], failMemberRead: false, failMemberWrite: false, insertConflict: false, smsEnabled: true, ...options }
  const vars = { CRON_SECRET: 'synthetic-cron', SUPABASE_URL: 'https://lotto-sync-fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key', VERCEL_URL: 'sync-fixture.example' }
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  Object.assign(process.env, vars)
  const originalFetch = globalThis.fetch
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
  const eq = (url: URL, key: string) => url.searchParams.get(key)?.replace(/^eq\./, '')
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    if (url.hostname === 'www.dhlottery.co.kr') { state.upstreamCalls++; return json(state.upstream, state.upstreamStatus) }
    if (url.hostname === 'sync-fixture.example') { state.vendorCalls++; return json({ ok: true }) }
    assert.equal(url.hostname, 'lotto-sync-fixture.supabase.co', 'tests must never use a real network destination')
    const table = url.pathname.split('/').at(-1)
    if (table === 'lotto_rounds') {
      if (method === 'POST') {
        const rows = Array.isArray(body) ? body : [body]
        if (state.insertConflict || rows.some((r: Round) => state.rounds.some((old) => old.round_no === r.round_no))) return json({ code: '23505', message: 'duplicate fixture' }, 409)
        assert.equal(url.searchParams.has('on_conflict'), false)
        state.rounds.push(...structuredClone(rows)); return json(rows, 201)
      }
      let rows = state.rounds.filter((r) => !url.searchParams.has('round_no') || url.searchParams.get('round_no')?.startsWith('lte.')
        ? !url.searchParams.get('round_no')?.startsWith('lte.') || r.round_no <= Number(url.searchParams.get('round_no')?.slice(4))
        : r.round_no === Number(eq(url, 'round_no')))
      if (url.searchParams.get('confirmed_at') === 'is.null') rows = rows.filter((r) => r.confirmed_at === null)
      if (method === 'PATCH') { rows.forEach((r) => Object.assign(r, body)); return json(rows.map((r) => ({ round_no: r.round_no }))) }
      rows = [...rows].sort((a, b) => url.searchParams.get('order')?.includes('desc') ? b.round_no - a.round_no : a.round_no - b.round_no)
      if (url.searchParams.has('limit')) rows = rows.slice(0, Number(url.searchParams.get('limit')))
      return json(structuredClone(rows))
    }
    if (table === 'members') {
      if (method === 'GET') {
        state.memberQueries.push(url)
        if (state.failMemberRead) { state.failMemberRead = false; return json({ message: 'fixture read failure', code: 'XX000' }, 500) }
        const after = url.searchParams.get('id')?.replace(/^gt\./, '')
        return json(structuredClone(state.members.filter((m) => !after || m.id > after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(url.searchParams.get('limit') ?? 1000))))
      }
      assert.equal(method, 'PATCH')
      const found = state.members.find((m) => m.id === eq(url, 'id'))
      assert.ok(found)
      if (state.failMemberWrite) return json({ message: 'fixture write failure', code: 'XX000' }, 500)
      Object.assign(found, structuredClone(body)); return json([{ id: found.id }])
    }
    if (table === 'site_settings') return json([{ sms: { oneshot_enabled: state.smsEnabled, sender_no: '0200000000' }, win_sms: { enabled: state.smsEnabled, ranks: [4, 5], paid: true, free: false }, win_messages: [{ rank: 4, body: '$name $contents' }, { rank: 5, body: '$name $contents' }] }])
    if (table === 'sms_sends') { state.smsRecords.push(body); return json([], 201) }
    if (table === 'logs') { state.logs.push(body); return json([], 201) }
    throw new Error(`unhandled synthetic path ${url.pathname}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    t.mock.timers.reset()
  })
  async function invoke(recover?: unknown, authorization = 'Bearer synthetic-cron') {
    let status = 200
    let result: Record<string, unknown> = {}
    const res = { status(value: number) { status = value; return this }, json(body: Record<string, unknown>) { result = body } }
    await handler({ headers: { authorization }, query: recover === undefined ? {} : { recover_round: recover } }, res)
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
  assert.equal(row.total_sales, 123436098000)
  assert.equal(syncPrizeForRank(row, 4), 50000)
  assert.equal(syncPrizeForRank(row, 5), 5000)
  for (const override of [{ ltEpsd: 1245 }, { ltEpsd: null }, { ltEpsd: 'bad' }, { tm2WnNo: 1 }, { bnsWnNo: 1 }, { ltRflYmd: '20260931' }, { rnk1WnAmt: null }]) {
    assert.throws(() => parseDrawResponse(responseFor([{ ...OFFICIAL, ...override }]), 1244, 1244))
  }
  assert.throws(() => parseDrawResponse(responseFor([OFFICIAL, OFFICIAL]), 1244, 1244))
})
test('auth failure does not call upstream, DB, or SMS', async (t) => {
  const { state, invoke } = await fixture(t)
  assert.equal((await invoke(undefined, 'wrong')).status, 401)
  assert.equal(state.upstreamCalls + state.logs.length + state.vendorCalls, 0)
})
test('upstream no data, bad format, invalid balls, and HTTP errors are visible failures before insert', async (t) => {
  const { state, invoke } = await fixture(t)
  for (const [upstream, upstreamStatus, code] of [[responseFor([]), 200, 'UPSTREAM_NOT_READY'], [{ changed: [] }, 200, 'UPSTREAM_FORMAT'], [responseFor([{ ...OFFICIAL, tm2WnNo: 1 }]), 200, 'UPSTREAM_INVALID'], [{}, 403, 'UPSTREAM_FETCH']] as const) {
    state.upstream = upstream; state.upstreamStatus = upstreamStatus
    const result = await invoke()
    assert.ok(result.status >= 500); assert.equal(result.body.code, code)
    assert.equal(state.rounds.length, 1)
    assert.equal(state.logs.at(-1)?.action, 'lotto.sync_failed')
  }
  assert.equal(state.vendorCalls, 0)
})
test('new round stores official prizes and preserves unrelated metadata in the existing tally path', async (t) => {
  const { state, invoke } = await fixture(t, { smsEnabled: false })
  const result = await invoke()
  assert.equal(result.status, 200, JSON.stringify(result))
  assert.ok(state.rounds[1].confirmed_at)
  assert.deepEqual((state.members[0].meta?.win_records as { prize: number }[]).map((w) => w.prize), [5000, 50000])
  assert.equal(state.members[0].meta?.unrelated, 'keep')
  assert.equal(state.members[0].meta?.reco_paused, true)
  assert.equal(state.vendorCalls, 0)
  assert.equal(state.logs.at(-1)?.action, 'lotto.auto_sync')
})
test('member read failure after round insert is visible and later polling does not resend historical SMS', async (t) => {
  const { state, invoke } = await fixture(t, { failMemberRead: true })
  assert.equal((await invoke()).body.code, 'MEMBERS_READ')
  assert.equal(state.logs.at(-1)?.action, 'lotto.sync_failed')
  assert.equal((await invoke()).body.added, 0)
  assert.equal(state.vendorCalls, 0)
})
test('recovery parameters cannot enable a new retry or overwrite an existing manual round', async (t) => {
  const existing = { ...pending(), bonus: 24 }
  const { state, invoke } = await fixture(t, { rounds: [prior(), existing] })
  for (const input of ['1244', ['1244'], '1245']) assert.equal((await invoke(input)).body.code, 'RECOVERY_UNSUPPORTED')
  assert.equal(existing.confirmed_at, null)
  assert.equal(existing.bonus, 24)
  assert.equal(state.upstreamCalls, 0)
  assert.equal(state.vendorCalls, 0)
})
test('member write error is visible and never followed by SMS', async (t) => {
  const { state, invoke } = await fixture(t, { failMemberWrite: true })
  assert.equal((await invoke()).body.code, 'MEMBER_WRITE')
  assert.equal(state.members[0].meta?.win_records, undefined)
  assert.equal(state.vendorCalls, 0)
})
test('insert conflict never upserts or touches members and SMS', async (t) => {
  const { state, invoke } = await fixture(t, { insertConflict: true })
  assert.equal((await invoke()).body.code, 'ROUND_INSERT')
  assert.equal(state.memberQueries.length, 0)
  assert.equal(state.vendorCalls, 0)
})
test('member pages use stable ID keysets beyond 1000 rows', async (t) => {
  const members = Array.from({ length: 1001 }, (_, i) => ({ ...member(`fixture-${String(i).padStart(5, '0')}`), meta: { weekly_recos: [] } }))
  const { state, invoke } = await fixture(t, { members })
  assert.equal((await invoke()).status, 200)
  assert.equal(state.memberQueries.length, 2)
  assert.equal(state.memberQueries[0].searchParams.get('order'), 'id.asc')
  assert.equal(state.memberQueries[1].searchParams.get('id'), 'gt.fixture-00999')
  assert.equal(state.vendorCalls, 0)
})
test('multiple same-round recommendation issues preserve first matching issue semantics', async (t) => {
  const m = member()
  ;(m.meta?.weekly_recos as unknown[]).push({ round_no: 1244, sets: [[1, 13, 18, 26, 34, 38]] })
  const { state, invoke } = await fixture(t, { members: [m], smsEnabled: false })
  assert.equal((await invoke()).status, 200)
  assert.equal((state.members[0].meta?.win_records as unknown[]).length, 2)
  assert.equal(state.members[0].win_history, '1244회 4등 (2건)')
})
test('a normal new round retains the existing one-send behavior and the next poll sends nothing', async (t) => {
  const m = member()
  m.meta = { ...m.meta, reco_paused: false }
  const { state, invoke } = await fixture(t, { members: [m] })
  assert.equal((await invoke()).status, 200)
  assert.equal(state.vendorCalls, 1)
  assert.equal(state.smsRecords.length, 1)
  assert.deepEqual(state.members[0].meta?.win_sms_rounds, [1244])
  assert.equal((await invoke()).status, 200)
  assert.equal(state.vendorCalls, 1)
})
