import test from 'node:test'
import assert from 'node:assert/strict'
import handler, { parseRecoRequest, recoSkipReason, recoContextProblem } from '../../api/weekly-reco.ts'

type Row = { id: string; grade: string; name: string; phone: string; registered_at: string; assigned_staff_id: string | null; status: string; is_deleted: boolean; is_withdrawn: boolean; is_suspended: boolean; meta: Record<string, unknown> }
type Ledger = { id: string; token: string; status: string; member: Row; issue: Record<string, unknown>; shouldSend: boolean; receipt?: Record<string, unknown> }
function member(id: string, site = 'lotto815'): Row {
  return { id, grade: 'gold', name: 'synthetic', phone: '01000000001', registered_at: '2020-01-01T00:00:00Z', assigned_staff_id: 'test-staff', status: 'active', is_deleted: false, is_withdrawn: false, is_suspended: false,
    meta: { source_site: site, weekly_reco_day: 2, weekly_reco_count: 1, reco_paused: false, reco_pause_reason: null, end_date: '2027-12-31', weekly_recos: [] } }
}
interface Options { nullMeta?: boolean; rows?: Row[]; concurrent?: boolean; changeHold?: boolean; loseClaim?: boolean; finishFails?: boolean; provider?: 'accepted' | 'rejected' | 'unknown' | 'empty'; role?: string; inactiveStaff?: boolean; smsEnabled?: boolean; commonSenderBlank?: boolean; missingSiteSender?: boolean }
async function fixture(options: Options, work: (s: {
  rows: Row[]; ledger: Map<string, Ledger>; sends: Record<string, unknown>[]; writes: string[]; requests: string[]; logs: Record<string, unknown>[];
  invoke: (body?: Record<string, unknown>, query?: Record<string, unknown>, auth?: string) => Promise<{ status: number; body: Record<string, unknown> }>
}) => Promise<void>) {
  const oldFetch = globalThis.fetch, oldNow = Date.now
  const env = { CRON_SECRET: 'synthetic-secret', SUPABASE_URL: 'https://synthetic-reco.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key', SELF_BASE_URL: 'https://synthetic-reco.invalid' }
  const oldEnv = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env); Date.now = () => Date.parse('2026-10-06T00:30:00Z')
  const rows = options.rows ?? [member('test-a')], ledger = new Map<string, Ledger>(), sends: Record<string, unknown>[] = [], writes: string[] = [], requests: string[] = [], logs: Record<string, unknown>[] = []
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  let scans = 0, release: (() => void) | undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), method = init?.method ?? 'GET'
    requests.push(method + ' ' + url.pathname)
    if (url.origin === 'https://synthetic-reco.invalid') {
      if (url.pathname === '/api/send-sms') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        assert.equal(ledger.get(String(body.member_id))?.status, 'claimed', 'provider is always after durable claim')
        sends.push(body)
        if (options.provider === 'unknown') throw new Error('synthetic response lost')
        if (options.provider === 'empty') return json({ ok: false, code: '' })
        if (options.provider === 'rejected') return json({ ok: false, code: 'D179' })
        return json({ ok: true, code: '0', cmid: 'synthetic-receipt' })
      }
      if (url.pathname === '/api/weekly-reco' && url.searchParams.get('audit') === '1') return json({ ok: true })
    }
    assert.equal(url.origin, 'https://synthetic-reco.supabase.co', 'all real network forbidden')
    if (url.pathname === '/auth/v1/user') return json({ id: 'synthetic-auth' })
    const table = url.pathname.replace('/rest/v1/', '')
    if (table === 'staff') return json({ id: 'test-staff', role: options.role ?? 'admin', is_active: !options.inactiveStaff })
    if (table === 'site_settings') {
      if (method !== 'GET') { writes.push(table); return json(null) }
      return json({ id: 1, lotto_exclude: { fixed: [], excluded: [] }, weekly_free_reco: { enabled: true, set_count: 1, logic_ratio: 0, paid_sms: true }, sms: { oneshot_enabled: options.smsEnabled !== false, sender_no: options.commonSenderBlank ? '' : '0212340000', by_site: { lotto815: { sender_no: options.missingSiteSender ? '' : '0212340001' }, infolotto: { sender_no: '0212340002' }, cplotto: { sender_no: '0212340003' }, best: { sender_no: '0212340004' } } } })
    }
    if (table === 'sms_templates') return json({ body: '$brand No. $round\n$num' })
    if (table === 'lotto_rounds') return json([{ round_no: 1244, draw_date: '2026-10-03', numbers: [1,2,3,4,5,6], bonus: 7 }])
    if (table === 'members') {
      assert.equal(method, 'GET', 'no stale full-meta client update')
      const idFilter = url.searchParams.get('id'), ids = idFilter?.startsWith('in.(') ? idFilter.slice(4,-1).split(',').map(id => id.replaceAll('"','')) : undefined
      const snap = structuredClone(rows.filter(r => r.status === 'active' && !r.is_deleted && !r.is_withdrawn && !r.is_suspended && (!ids || ids.includes(r.id))))
      scans++; if (options.concurrent && scans <= 2) { if (scans === 2) release?.(); await barrier }
      return json(options.nullMeta ? snap.map(r => ({ ...r, meta: null })) : snap)
    }
    if (table === 'reco_issue_ledger') return json([...ledger.values()].map(x => ({ id: x.id, member_id: x.member.id, status: x.status })))
    if (table === 'rpc/reco_issue_claim') {
      writes.push('claim')
      const p = JSON.parse(String(init?.body)) as Record<string, unknown>, row = rows.find(r => r.id === p.p_member_id)
      assert.ok(row)
      assert.equal(p.p_expected_grade, row.grade); assert.equal(p.p_expected_phone, row.phone)
      if (options.changeHold) row.meta = { ...row.meta, reco_paused: true, field_edit: 'preserve' }
      if (JSON.stringify(row.meta) !== JSON.stringify(p.p_expected_meta)) return json({ ok: true, claimed: false, status: 'review_required', reason: 'META_CHANGED' })
      if (ledger.has(row.id)) return json({ ok: true, claimed: false, status: 'skipped', reason: 'ALREADY_CLAIMED' })
      if (row.meta.reco_paused) return json({ ok: true, claimed: false, status: 'skipped', reason: 'HELD' })
      const issue = p.p_issue as Record<string, unknown>
      const entry: Ledger = { id: 'claim-' + row.id, token: 'token-' + row.id, member: row, status: 'claimed', issue, shouldSend: p.p_also_sms === true }
      ledger.set(row.id, entry); row.meta = { ...row.meta, weekly_recos: [issue] }
      if (options.loseClaim) throw new Error('synthetic claim response lost after commit')
      return json({ ok: true, claimed: true, status: 'claimed', claim_id: entry.id, claim_token: entry.token, member: { ...structuredClone(row), ...(options.nullMeta ? { meta: null } : {}) }, issue, should_send: entry.shouldSend })
    }
    if (table === 'rpc/reco_issue_finish') {
      writes.push('finish')
      if (options.finishFails) return json({ code: 'SYNTHETIC_RECEIPT_FAILURE' }, 500)
      const p = JSON.parse(String(init?.body)) as Record<string, unknown>, entry = [...ledger.values()].find(x => x.id === p.p_claim_id)
      assert.ok(entry); assert.equal(entry.token, p.p_claim_token)
      entry.status = String(p.p_outcome); entry.receipt = p.p_receipt as Record<string, unknown>
      return json({ ok: true, status: entry.status, outcome: entry.status, repeated: false })
    }
    if (table === 'logs') { writes.push('logs'); logs.push(JSON.parse(String(init?.body)) as Record<string,unknown>); return json(null) }
    throw new Error('Unexpected synthetic request: ' + table)
  }
  const invoke = async (body?: Record<string, unknown>, query: Record<string, unknown> = {}, auth = 'Bearer synthetic-secret') => {
    const result = { status: 0, body: {} as Record<string, unknown> }
    const response = { status(n: number) { result.status = n; return this }, json(value: Record<string, unknown>) { result.body = value; return this } }
    await handler({ method: body ? 'POST' : 'GET', headers: { authorization: auth }, query, body }, response)
    return result
  }
  try { await work({ rows, ledger, sends, writes, requests, logs, invoke }) } finally {
    globalThis.fetch = oldFetch; Date.now = oldNow
    for (const [k,v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

test('invalid/ambiguous targeting and force never fall through to a global run', async () => {
  for (const req of [
    { method: 'GET', query: { member_id: 'a' } }, { method: 'GET', query: { memberIds: ['a'] } }, { method: 'GET', query: { force: '1' } },
    { method: 'POST', body: { memberIds: [] } }, { method: 'POST', body: { memberIds: ['a','a'] } }, { method: 'POST', body: { memberIds: Array.from({ length: 51 }, (_, i) => 'a' + i) } },
    { method: 'POST', body: { memberIds: ['a'], dryRun: 'true' } }, { method: 'POST', body: { memberIds: ['a'], mode: 'manual', setCount: 0 } },
    { method: 'POST', body: { memberIds: ['a','b'], mode: 'manual' } }, { method: 'POST', body: { member_ids: ['a'] } },
  ]) assert.throws(() => parseRecoRequest(req))
  await fixture({}, async s => { const r = await s.invoke(undefined, { source_site: 'lotto815' }); assert.equal(r.status, 400); assert.equal(s.requests.length, 0) })
})
test('GET and exact-ID POST dryRun have zero writes/provider requests/self chains', async () => {
  await fixture({ rows: [member('test-a'), member('test-plus', 'pluslotto')] }, async s => {
    const all = await s.invoke(undefined, { dryRun: '1' }), one = await s.invoke({ memberIds: ['test-a'], dryRun: true, expectedRound: 1245 })
    assert.equal(all.body.wouldIssue, 2); assert.equal(one.body.wouldIssue, 1)
    assert.deepEqual(s.writes, []); assert.deepEqual(s.sends, [])
    assert.equal(s.requests.some(r => r.includes('/api/weekly-reco')), false)
  })
})
test('four approved synthetic IDs use exact scope/brands and exclude Plus/other members', async () => {
  const ids = ['test-815','test-info','test-ilhang','test-best'], sites = ['lotto815','infolotto','cplotto','best']
  await fixture({ rows: [...ids.map((id,i) => member(id,sites[i])), member('test-plus', 'pluslotto'), member('test-other')] }, async s => {
    const r = await s.invoke({ memberIds: ids, expectedRound: 1245 })
    assert.equal(r.body.issued, 4); assert.equal(r.body.smsSent, 4); assert.deepEqual(s.sends.map(x => x.member_id).sort(), ids.sort())
    assert.deepEqual(new Set(s.sends.map(x => x.source_site)), new Set(sites))
    assert.ok(s.sends.every(x => !String(x.msg_body).startsWith('plus')))
    assert.equal(s.requests.some(x => x.includes('/api/weekly-reco')), false)
  })
})
test('missing/inactive scoped target and changed expected round stop before any claim', async () => {
  await fixture({}, async s => {
    assert.equal((await s.invoke({ memberIds: ['missing'] })).status, 409)
    assert.equal((await s.invoke({ memberIds: ['test-a'], expectedRound: 1244 })).status, 409)
    assert.deepEqual(s.writes, [])
  })
})
test('staff cannot enter unscoped cron; rep can only issue assigned exact IDs', async () => {
  await fixture({ role: 'rep', rows: [member('test-a'), { ...member('test-other'), assigned_staff_id: 'other-staff' }] }, async s => {
    assert.equal((await s.invoke(undefined, {}, 'Bearer staff-token')).status, 401)
    assert.equal((await s.invoke({ memberIds: ['test-other'], mode: 'manual' }, {}, 'Bearer staff-token')).status, 403)
    assert.deepEqual(s.writes, [])
    const r = await s.invoke({ memberIds: ['test-a'], mode: 'manual', alsoSms: false }, {}, 'Bearer staff-token')
    assert.equal(r.body.issued, 1); assert.equal(r.body.smsSent, 0)
  })
})
test('inactive staff never claim', async () => {
  await fixture({ inactiveStaff: true }, async s => { assert.equal((await s.invoke({ memberIds: ['test-a'] }, {}, 'Bearer staff-token')).status, 401); assert.deepEqual(s.writes, []) })
})
test('manual single bypasses day but does not bypass hold; default count zero skips', async () => {
  await fixture({ rows: [{ ...member('test-a'), meta: { ...member('test-a').meta, weekly_reco_day: 5, reco_paused: true } }] }, async s => {
    const r = await s.invoke({ memberIds: ['test-a'], mode: 'manual', setCount: 1 }, {}, 'Bearer staff-token')
    assert.equal(r.body.issued, 0); assert.equal(s.sends.length, 0); assert.equal(s.ledger.size, 0)
  })
  await fixture({ rows: [{ ...member('test-a'), meta: { ...member('test-a').meta, weekly_reco_count: 0 } }] }, async s => {
    assert.equal((await s.invoke({ memberIds: ['test-a'], mode: 'manual' }, {}, 'Bearer staff-token')).body.issued, 0)
    assert.equal((await s.invoke({ memberIds: ['test-a'], mode: 'manual', setCount: 1, alsoSms: false }, {}, 'Bearer staff-token')).body.issued, 1)
    assert.equal(s.rows[0].meta.weekly_reco_count, 0)
  })
})
test('same member and round in concurrent cron requests has one durable claim and one send', async () => {
  await fixture({ concurrent: true }, async s => {
    const result = await Promise.all([s.invoke(),s.invoke()])
    assert.equal(s.ledger.size, 1); assert.equal(s.sends.length, 1)
    assert.equal(result.reduce((n,r) => n + Number(r.body.issued),0), 1)
  })
})
test('new hold/concurrent metadata edit is preserved by CAS rejection before sending', async () => {
  await fixture({ changeHold: true }, async s => {
    const r = await s.invoke({ memberIds: ['test-a'] })
    assert.equal(s.rows[0].meta.reco_paused, true); assert.equal(s.rows[0].meta.field_edit, 'preserve')
    assert.equal(s.sends.length, 0); assert.equal(r.body.reviewRequired, 1)
  })
})
test('lost claim response never sends or reclaims on subsequent execution', async () => {
  await fixture({ loseClaim: true }, async s => {
    const first = await s.invoke({ memberIds: ['test-a'] }); await s.invoke({ memberIds: ['test-a'] })
    assert.equal(first.body.reviewRequired, 1); assert.equal(s.ledger.size, 1); assert.equal(s.sends.length, 0)
  })
})
test('accepted request with receipt failure is review-required and never resent', async () => {
  await fixture({ finishFails: true }, async s => {
    const first = await s.invoke({ memberIds: ['test-a'] }); await s.invoke({ memberIds: ['test-a'] })
    assert.equal(first.body.ok, false); assert.equal(first.body.reviewRequired, 1); assert.equal(first.body.errors, 1)
    assert.equal(s.sends.length, 1); assert.equal(s.ledger.get('test-a')?.status, 'claimed')
  })
})
test('provider failure/unknown/code-less responses persist and never automatically resend', async () => {
  for (const provider of ['rejected','unknown','empty'] as const) await fixture({ provider }, async s => {
    const first = await s.invoke({ memberIds: ['test-a'] }); await s.invoke({ memberIds: ['test-a'] })
    assert.equal(first.body.ok, false); assert.equal(s.sends.length, 1)
    assert.equal(s.ledger.get('test-a')?.status, provider === 'rejected' ? 'rejected' : 'unknown')
  })
})
test('accepted receipt retains provider ID and body; SMS disabled is explicitly not_requested', async () => {
  await fixture({}, async s => {
    const r = await s.invoke({ memberIds: ['test-a'], mode: 'manual' }, {}, 'Bearer staff-token')
    assert.equal(s.ledger.get('test-a')?.receipt?.cmid, 'synthetic-receipt')
    assert.equal(s.ledger.get('test-a')?.receipt?.httpStatus, 200)
    assert.equal((r.body.results as Record<string, unknown>[])[0].sms_outcome, 'accepted')
  })
  await fixture({ smsEnabled: false }, async s => {
    const r = await s.invoke({ memberIds: ['test-a'], mode: 'manual' }, {}, 'Bearer staff-token')
    assert.equal(s.sends.length, 0); assert.equal((r.body.results as Record<string, unknown>[])[0].sms_outcome, 'not_requested')
  })
})
test('same-round issue anywhere in history prevents another issue', () => {
  assert.equal(recoSkipReason({ grade: 'gold', meta: { weekly_reco_day: 2, weekly_recos: [{ round_no: 1246 },{ round_no: 1245 }] } },
    { today: 2,todayKst: '2026-10-06', force: false, autoEnabled: true, paidSmsOn: true,targetRound: 1245 }), 'already')
})

test('leader with no team retains existing whole-member scope for scoped dry-run and issue', async () => {
  await fixture({ role: 'leader', rows: [{ ...member('test-a'), assigned_staff_id: null }] }, async s => {
    const pre = await s.invoke({ memberIds: ['test-a'], mode: 'manual', dryRun: true }, {}, 'Bearer staff-token')
    assert.equal(pre.body.wouldSend, 1)
    const result = await s.invoke({ memberIds: ['test-a'], mode: 'manual' }, {}, 'Bearer staff-token')
    assert.equal(result.body.smsSent, 1)
    assert.equal(s.logs.length, 1); assert.equal(s.logs[0].action, 'reco.manual_issue'); assert.equal(s.logs[0].actor, 'test-staff')
  })
})
test('legacy site sender works without common sender; missing actual sender never claims', async () => {
  await fixture({ commonSenderBlank: true }, async s => {
    const r = await s.invoke({ memberIds: ['test-a'] })
    assert.equal(r.body.smsSent, 1); assert.equal(s.sends[0].send_phone, '0212340001')
  })
  await fixture({ missingSiteSender: true }, async s => {
    const r = await s.invoke({ memberIds: ['test-a'] })
    assert.equal(s.ledger.size, 0); assert.equal(s.sends.length, 0)
    assert.equal((r.body.results as Record<string,unknown>[])[0].code, 'SMS_SENDER_UNSET')
  })
})
test('preview fails closed for true hold, malformed metadata and invalid dates', async () => {
  for (const [meta, code] of [
    [{ reco_paused: true, reco_pause_reason: 'legacy_import_review' }, 'HELD'],
    [{ reco_paused: 'false' }, 'INVALID_HOLD'], [{ end_date: '2026-02-30' }, 'INVALID_END_DATE'],
    [{ end_date: 'bad-date' }, 'INVALID_END_DATE'], [{ weekly_reco_day: '2' }, 'INVALID_DAY'],
    [{ weekly_reco_count: '1' }, 'INVALID_COUNT'], [{ weekly_recos: null }, 'INVALID_HISTORY'],
  ] as const) {
    assert.equal(recoContextProblem(meta), code)
    await fixture({ rows: [{ ...member('test-a'), meta: { ...member('test-a').meta, ...meta } }] }, async s => {
      const r = await s.invoke({ memberIds: ['test-a'], dryRun: true })
      assert.equal(r.body.wouldSend, 0); assert.equal((r.body.results as Record<string,unknown>[])[0].code, code)
      assert.deepEqual(s.writes, [])
    })
  }
})
test('global and scoped previews consult durable ledger after displayed issue history is removed', async () => {
  await fixture({}, async s => {
    await s.invoke({ memberIds: ['test-a'] })
    s.rows[0].meta.weekly_recos = []
    const priorWrites = s.writes.length
    const scoped = await s.invoke({ memberIds: ['test-a'], dryRun: true }), global = await s.invoke(undefined, { dryRun: '1' })
    assert.equal(scoped.body.wouldSend, 0); assert.equal(global.body.wouldSend, 0)
    assert.equal(s.writes.length, priorWrites); assert.equal(s.sends.length, 1)
  })
})
test('inactive status with false flags is excluded before scoped preview/claim', async () => {
  await fixture({ rows: [{ ...member('test-a'), status: 'pending' }] }, async s => {
    const r = await s.invoke({ memberIds: ['test-a'], dryRun: true })
    assert.equal(r.status, 409); assert.deepEqual(s.writes, [])
  })
})

test('historical hold reason with false flag remains allowed without deleting source history', async () => {
  const meta = { ...member('test-a').meta, reco_paused: false, reco_pause_reason: 'legacy_import_review' }
  assert.equal(recoContextProblem(meta), null)
  await fixture({ rows: [{ ...member('test-a'), meta }] }, async s => {
    assert.equal((await s.invoke({ memberIds: ['test-a'], dryRun: true })).body.wouldSend, 1)
    assert.equal((await s.invoke({ memberIds: ['test-a'] })).body.smsSent, 1)
    assert.equal(s.rows[0].meta.reco_pause_reason, 'legacy_import_review')
    assert.equal(s.rows[0].meta.reco_paused, false)
  })
})

test('manual issuance accepts a SQL NULL metadata snapshot and nullable claim response', async () => {
  await fixture({ nullMeta: true, rows: [{ ...member('test-a'), meta: {} }] }, async s => {
    const r = await s.invoke({ memberIds: ['test-a'], mode: 'manual', setCount: 1, alsoSms: true }, {}, 'Bearer staff-token')
    assert.equal(r.body.issued, 1); assert.equal(r.body.smsSent, 1); assert.equal(r.body.reviewRequired, 0)
    assert.equal(s.ledger.size, 1); assert.equal(s.sends.length, 1)
    assert.equal((r.body.results as Record<string,unknown>[])[0].status, 'issued')
  })
})
