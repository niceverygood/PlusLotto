import assert from 'node:assert/strict'
import test from 'node:test'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import handler from '../../api/send-sms.ts'

// 실제 handler의 인증 → DB 보류 조회 → 벤더 호출을 검증한다.
// global fetch와 undici 양쪽을 격리하여 어떤 테스트도 실제 DB나 문자 서비스에 접근하지 않는다.
type Provider = 'solapi' | 'oneshot'
type RpcResult = { data?: unknown; error?: boolean; throws?: boolean }
type FixtureOptions = {
  provider?: Provider
  auth?: 'cron' | 'staff'
  rpc?: RpcResult
  missingConfig?: 'url' | 'key'
  body?: Record<string, unknown>
}

async function invoke(options: FixtureOptions = {}) {
  const provider = options.provider ?? 'solapi'
  const rpc = options.rpc ?? { data: false }
  const env: Record<string, string | undefined> = {
    CRON_SECRET: 'synthetic-cron-secret',
    SUPABASE_URL: options.missingConfig === 'url' ? undefined : 'https://sms-hold-test.supabase.co',
    VITE_SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: options.missingConfig === 'key' ? undefined : 'synthetic-service-key',
    ONESHOT_ID: 'synthetic-id',
    ONESHOT_SEND_PHONE: '0212340000',
    ONESHOT_RESELLER: undefined,
    SOLAPI_API_KEY: 'synthetic-solapi-key',
    SOLAPI_API_SECRET: 'synthetic-solapi-secret',
    SOLAPI_ENABLED: provider === 'solapi' ? 'true' : 'false',
    FIXIE_URL: undefined,
    PROXY_URL: undefined,
  }
  const originalEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  const originalDispatcher = getGlobalDispatcher()
  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  setGlobalDispatcher(mockAgent)
  let solapiCalls = 0
  let oneshotCalls = 0
  const holdRequests: unknown[] = []
  const events: string[] = []
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  })

  mockAgent.get('https://api2.msgagent.com').intercept({
    path: '/api/webshot/send/general/SMS/synthetic-id', method: 'POST',
  }).reply(() => {
    oneshotCalls += 1
    events.push('oneshot')
    return { statusCode: 200, data: JSON.stringify({ result_code: '0', cmid: 'synthetic-message' }) }
  })
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin === 'https://sms-hold-test.supabase.co') {
      if (url.pathname === '/auth/v1/user') return json({ id: 'synthetic-user' })
      if (url.pathname === '/rest/v1/staff') return json({ id: 'synthetic-staff', is_active: true })
      if (url.pathname === '/rest/v1/rpc/sms_is_legacy_import_held') {
        events.push('hold-check')
        holdRequests.push(JSON.parse(String(init?.body)))
        if (rpc.throws) throw new Error('synthetic private DB error: 010-0000-0001')
        if (rpc.error) return json({ code: 'PGRST202', message: 'synthetic private DB error: 010-0000-0001' }, 404)
        return json(rpc.data)
      }
    }
    if (url.href === 'https://api.solapi.com/messages/v4/send') {
      solapiCalls += 1
      events.push('solapi')
      return json({ statusCode: '2000', messageId: 'synthetic-message' })
    }
    throw new Error('Unexpected network request in isolated SMS test')
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const response = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this },
    json(body: Record<string, unknown>) { this.body = body; return this },
    end() { return this },
  }
  try {
    await handler({
      method: 'POST',
      headers: options.auth === 'staff'
        ? { authorization: 'Bearer synthetic-staff-token' }
        : { 'x-internal-secret': 'synthetic-cron-secret' },
      body: options.body ?? { dest_phone: '010-0000-0001', msg_body: '격리된 테스트 메시지' },
    }, response)
    return { response, solapiCalls, oneshotCalls, holdRequests, events }
  } finally {
    globalThis.fetch = originalFetch
    setGlobalDispatcher(originalDispatcher)
    await mockAgent.close()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('이관 검토 보류는 크론 인증을 포함해 양쪽 문자 벤더 호출 전에 차단한다', async (t) => {
  for (const provider of ['solapi', 'oneshot'] as const) {
    await t.test(provider, async () => {
      const result = await invoke({ provider, rpc: { data: true } })
      assert.equal(result.response.statusCode, 423)
      assert.equal(result.response.body.code, 'LEGACY_IMPORT_HOLD')
      assert.equal(result.response.body.ok, false)
      assert.equal(result.solapiCalls + result.oneshotCalls, 0)
      assert.deepEqual(result.holdRequests, [{ p_phone: '01000000001' }])
      assert.deepEqual(result.events, ['hold-check'])
      assert.doesNotMatch(JSON.stringify(result.response.body), /010[-]?0000[-]?0001/)
    })
  }
})

test('운영자 인증을 거친 수동 요청에도 이관 보류가 적용된다', async () => {
  const result = await invoke({ auth: 'staff', rpc: { data: true } })
  assert.equal(result.response.statusCode, 423)
  assert.equal(result.response.body.code, 'LEGACY_IMPORT_HOLD')
  assert.equal(result.solapiCalls + result.oneshotCalls, 0)
  assert.equal(result.holdRequests.length, 1)
})

test('DB에서 보류 없음이 확인된 정상·미등록·검토 해제 번호는 기존 벤더 경로로 발송한다', async (t) => {
  for (const provider of ['solapi', 'oneshot'] as const) {
    await t.test(provider, async () => {
      const result = await invoke({ provider, rpc: { data: false } })
      assert.equal(result.response.statusCode, 200)
      assert.equal(result.response.body.ok, true)
      assert.equal(result.solapiCalls, provider === 'solapi' ? 1 : 0)
      assert.equal(result.oneshotCalls, provider === 'oneshot' ? 1 : 0)
      assert.deepEqual(result.events, ['hold-check', provider])
    })
  }
})

test('설정 누락·DB 오류·잘못된 RPC 응답은 개인정보 없이 닫힌 상태로 실패한다', async (t) => {
  const scenarios: Record<string, FixtureOptions> = {
    'Supabase URL 누락': { missingConfig: 'url' },
    'service role key 누락': { missingConfig: 'key' },
    'RPC 미배포 또는 DB 오류': { rpc: { error: true } },
    '연결 예외': { rpc: { throws: true } },
    'null 응답': { rpc: { data: null } },
    '문자열 false 응답': { rpc: { data: 'false' } },
    '객체 응답': { rpc: { data: {} } },
  }
  for (const [name, options] of Object.entries(scenarios)) {
    for (const provider of ['solapi', 'oneshot'] as const) {
      await t.test(`${name}: ${provider}`, async () => {
        const result = await invoke({ ...options, provider })
        assert.equal(result.response.statusCode, 503)
        assert.equal(result.response.body.code, 'SMS_HOLD_CHECK')
        assert.equal(result.response.body.ok, false)
        assert.equal(result.solapiCalls + result.oneshotCalls, 0)
        assert.doesNotMatch(JSON.stringify(result.response.body), /synthetic|010[-]?0000[-]?0001/)
      })
    }
  }
})

test('check_only는 전화번호만으로 같은 보류 검사를 하고 어느 벤더에도 발송하지 않는다', async (t) => {
  for (const provider of ['solapi', 'oneshot'] as const) {
    for (const held of [false, true]) {
      await t.test(`${provider}: held=${held}`, async () => {
        const result = await invoke({
          provider,
          rpc: { data: held },
          body: { dest_phone: '010-0000-0001', check_only: true },
        })
        assert.equal(result.response.statusCode, held ? 423 : 200)
        assert.equal(result.response.body.code, held ? 'LEGACY_IMPORT_HOLD' : 'CHECK_ONLY')
        assert.equal(result.response.body.ok, !held)
        assert.equal(result.solapiCalls + result.oneshotCalls, 0)
        assert.deepEqual(result.events, ['hold-check'])
      })
    }
  }
})

test('check_only 요청에 발송 본문이 함께 있어도 발송하지 않는다', async () => {
  const result = await invoke({
    body: { dest_phone: '010-0000-0001', msg_body: '격리된 테스트 메시지', check_only: true },
  })
  assert.equal(result.response.body.code, 'CHECK_ONLY')
  assert.equal(result.solapiCalls + result.oneshotCalls, 0)
})

test('잘못된 check_only 값이 실제 발송으로 오인되지 않는다', async () => {
  const result = await invoke({
    body: { dest_phone: '010-0000-0001', msg_body: '격리된 테스트 메시지', check_only: 'true' },
  })
  assert.equal(result.response.statusCode, 400)
  assert.equal(result.solapiCalls + result.oneshotCalls, 0)
})
