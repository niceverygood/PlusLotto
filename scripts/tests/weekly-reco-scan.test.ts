import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import handler, { scanMembers, type MemberScanRow } from '../../api/weekly-reco.ts'

const base = 'https://synthetic-scan.supabase.co'
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const timeout = () => json({ code: '57014', message: 'canceling statement due to statement timeout' }, 500)
const row = (n: number): MemberScanRow => ({ id: `synthetic-${String(n).padStart(6, '0')}`, grade: 'gold', name: 'synthetic', phone: '01000000000', registered_at: '2020-01-01', meta: { reco_paused: n % 2 === 0, weekly_reco_day: 3, weekly_reco_count: 10, weekly_recos: [], nested: { preserve: n } } })

async function withFetch(fetcher: typeof fetch, work: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = fetcher
  try { await work() } finally { globalThis.fetch = original }
}

function assertRead(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): URL {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, base, 'real network forbidden')
  assert.equal(url.pathname, '/rest/v1/members')
  assert.equal(init?.method ?? 'GET', 'GET')
  assert.equal(url.searchParams.get('select'), 'id,grade,name,phone,meta,registered_at,assigned_staff_id,status')
  assert.equal(url.searchParams.get('status'), 'eq.active')
  for (const flag of ['is_deleted', 'is_withdrawn', 'is_suspended']) assert.equal(url.searchParams.get(flag), 'eq.false')
  assert.equal(url.searchParams.get('order'), 'id.asc')
  return url
}

test('healthy scan retains the 1000-row keyset query and full metadata', async () => {
  const expected = Array.from({ length: 1001 }, (_, i) => row(i)), calls: URL[] = []
  await withFetch(async (input, init) => {
    const url = assertRead(input, init); calls.push(url)
    const cursor = url.searchParams.get('id')?.slice(3) ?? ''
    return json(expected.filter(r => r.id > cursor).slice(0, Number(url.searchParams.get('limit'))))
  }, async () => {
    assert.deepEqual(await scanMembers(createClient(base, 'synthetic-key'), 1000), expected)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(u => u.searchParams.get('limit')), ['1000', '1000'])
    assert.equal(calls[1].searchParams.get('id'), `gt.${expected[999].id}`)
  })
})

test('timeout retries use the same cursor, 250 then100, and do not end at a shrunken full page', async () => {
  const expected = Array.from({ length: 350 }, (_, i) => row(i)), calls: URL[] = []
  await withFetch(async (input, init) => {
    const url = assertRead(input, init); calls.push(url)
    if (calls.length <= 2) return timeout()
    const cursor = url.searchParams.get('id')?.slice(3) ?? ''
    return json(expected.filter(r => r.id > cursor).slice(0, Number(url.searchParams.get('limit'))))
  }, async () => {
    assert.deepEqual(await scanMembers(createClient(base, 'synthetic-key'), 1000), expected)
    assert.deepEqual(calls.map(u => u.searchParams.get('limit')), ['1000', '250', '100', '100', '100', '100'])
    assert.ok(calls.slice(0, 3).every(u => !u.searchParams.has('id')))
    assert.equal(calls[3].searchParams.get('id'), `gt.${expected[99].id}`)
  })
})

test('a later timeout never re-reads earlier successful pages or advances the failed cursor', async () => {
  const expected = Array.from({ length: 1350 }, (_, i) => row(i)), calls: URL[] = []
  await withFetch(async (input, init) => {
    const url = assertRead(input, init); calls.push(url)
    if (calls.length === 2) return timeout()
    const cursor = url.searchParams.get('id')?.slice(3) ?? ''
    return json(expected.filter(r => r.id > cursor).slice(0, Number(url.searchParams.get('limit'))))
  }, async () => {
    const got = await scanMembers(createClient(base, 'synthetic-key'), 1000)
    assert.deepEqual(got, expected)
    assert.equal(new Set(got.map(r => r.id)).size, expected.length)
    assert.deepEqual(calls.map(u => u.searchParams.get('limit')), ['1000', '1000', '250', '250'])
    assert.equal(calls[1].searchParams.get('id'), calls[2].searchParams.get('id'))
  })
})

test('permission/schema errors do not retry and timeout retries remain bounded', async () => {
  for (const code of ['42501', '57014']) {
    let calls = 0
    await withFetch(async (input, init) => { assertRead(input, init); calls++; return json({ code, message: 'synthetic failure' }, code === '42501' ? 403 : 500) }, async () => {
      await assert.rejects(scanMembers(createClient(base, 'synthetic-key'), 1000), { code })
      assert.equal(calls, code === '57014' ? 3 : 1)
    })
  }
})

test('scoped scan retries never fall through to an unscoped query', async () => {
  let calls = 0
  const expected = [row(1), row(2)]
  await withFetch(async (input, init) => {
    const url = assertRead(input, init); calls++
    assert.equal(url.searchParams.get('id'), `in.(${expected.map(r => r.id).join(',')})`)
    return calls === 1 ? timeout() : json(expected)
  }, async () => {
    assert.deepEqual(await scanMembers(createClient(base, 'synthetic-key'), 1000, expected.map(r => r.id)), expected)
    assert.equal(calls, 2)
  })
})

test('exhausted member reads return observable57014 and never claim/log/send a partial list', async () => {
  const env = { CRON_SECRET: 'synthetic-secret', SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key' }
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const now = Date.now; Date.now = () => Date.parse('2026-10-07T00:00:00Z')
  let memberReads = 0
  try {
    await withFetch(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      assert.equal(url.origin, base, 'no SMS or self-chain allowed')
      assert.equal(init?.method ?? 'GET', 'GET', 'no claims or log writes allowed')
      switch (url.pathname) {
        case '/rest/v1/site_settings': return json({ id: 1, weekly_free_reco: { enabled: true, set_count: 10, paid_sms: true }, lotto_exclude: { fixed: [], excluded: [] }, sms: { oneshot_enabled: true, sender_no: '0212340000' } })
        case '/rest/v1/sms_templates': return json({ body: '$num' })
        case '/rest/v1/lotto_rounds': return json([{ round_no: 1244, draw_date: '2026-10-03', numbers: [1, 2, 3, 4, 5, 6], bonus: 7 }])
        case '/rest/v1/logs': return json([]) // today's completion check: not complete yet
        case '/rest/v1/members':
          memberReads++
          // A complete first page is already accumulated when the later read fails.
          return memberReads === 1 ? json(Array.from({ length: 1000 }, (_, i) => row(i))) : timeout()
        default: throw new Error('Unexpected request: ' + url.pathname)
      }
    }, async () => {
      const result = { status: 0, body: {} as Record<string, unknown> }
      await handler({ method: 'GET', headers: { authorization: 'Bearer synthetic-secret' }, query: { chain: '1' } }, {
        status(code) { result.status = code; return this }, json(body) { result.body = body; return this },
      })
      assert.equal(result.status, 500)
      assert.equal(result.body.stage, 'member_scan')
      assert.equal(result.body.error_code, '57014')
      assert.equal(memberReads, 4)
    })
  } finally {
    Date.now = now
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

test('scheduled scan narrows to today candidates in the database; Friday reads free members without a day in a separate pass', async () => {
  for (const [today, expectedOr] of [
    [3, ['(meta->>weekly_reco_day.eq.3)']],
    [5, ['(meta->>weekly_reco_day.eq.5)', '(and(grade.eq.free,meta->>weekly_reco_day.is.null))']],
  ] as const) {
    const calls: URL[] = []
    await withFetch(async (input, init) => {
      const url = assertRead(input, init); calls.push(url)
      return json(calls.length === 1 ? [row(1)] : [{ ...row(2), grade: 'free', meta: {} }])
    }, async () => {
      const got = await scanMembers(createClient(base, 'synthetic-key'), 1000, undefined, { today })
      assert.deepEqual(got.map(r => r.id), today === 5 ? [row(1).id, row(2).id] : [row(1).id])
      assert.deepEqual(calls.map(u => u.searchParams.get('or')), expectedOr)
    })
  }
  await assert.rejects(scanMembers(createClient(base, 'synthetic-key'), 1000, undefined, { today: 7 }), /INVALID_MEMBER_SCAN_DAY/)
})

test('Friday passes each page by their own cursor and never OR the two predicates', async () => {
  const dayRows = Array.from({ length: 1001 }, (_, i) => row(i))
  const freeRows = Array.from({ length: 3 }, (_, i) => ({ ...row(5000 + i), grade: 'free', meta: {} }))
  const calls: URL[] = []
  await withFetch(async (input, init) => {
    const url = assertRead(input, init); calls.push(url)
    const or = url.searchParams.get('or')
    assert.ok(or === '(meta->>weekly_reco_day.eq.5)' || or === '(and(grade.eq.free,meta->>weekly_reco_day.is.null))', `unexpected or=${or}`)
    const source = or === '(meta->>weekly_reco_day.eq.5)' ? dayRows : freeRows
    const cursor = url.searchParams.get('id')?.slice(3) ?? ''
    return json(source.filter(r => r.id > cursor).slice(0, Number(url.searchParams.get('limit'))))
  }, async () => {
    const got = await scanMembers(createClient(base, 'synthetic-key'), 1000, undefined, { today: 5 })
    assert.deepEqual(got.map(r => r.id), [...dayRows, ...freeRows].map(r => r.id))
    assert.equal(calls.length, 3)
    assert.equal(calls[1].searchParams.get('id'), `gt.${dayRows[999].id}`)
    assert.equal(calls[2].searchParams.has('id'), false, 'the free pass starts from the beginning')
  })
})

test('audit and scoped scans keep reading without a day filter', async () => {
  await withFetch(async (input, init) => {
    const url = assertRead(input, init)
    assert.equal(url.searchParams.has('or'), false)
    return json([row(1)])
  }, async () => {
    await scanMembers(createClient(base, 'synthetic-key'), 1000)
    await scanMembers(createClient(base, 'synthetic-key'), 1000, [row(1).id])
  })
})
