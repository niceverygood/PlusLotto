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
  auth?: 'cron' | 'staff' | 'none'
  rpc?: RpcResult
  staff?: RpcResult
  member?: RpcResult
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
  const memberRequests: string[] = []
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
      if (url.pathname === '/rest/v1/staff') {
        if (options.staff?.throws) throw new Error('synthetic private staff error')
        if (options.staff?.error) return json({ code: 'TEST_ERROR' }, 500)
        return json(options.staff ? options.staff.data : {
          id: 'synthetic-staff', is_active: true, role: 'admin', team_id: 'synthetic-team',
        })
      }
      if (url.pathname === '/rest/v1/members') {
        events.push('member-check')
        const memberId = (url.searchParams.get('id') ?? '').replace(/^eq\./, '')
        memberRequests.push(memberId)
        if (options.member?.throws) throw new Error('synthetic private member error: 010-0000-0001')
        if (options.member?.error) return json({ code: 'TEST_ERROR', message: 'synthetic private member error' }, 500)
        if (options.member) return json(options.member.data)
        return json(memberId === 'synthetic-plus' || memberId === 'synthetic-815' ? {
          id: memberId,
          phone: '010-0000-0001',
          assigned_staff_id: 'synthetic-staff',
          team_id: 'synthetic-team',
          meta: memberId === 'synthetic-815'
            ? { source_site: 'lotto815', reco_paused: true, reco_pause_reason: 'legacy_import_review' }
            : {},
        } : null)
      }
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
      headers: options.auth === 'none' ? {} : options.auth === 'staff'
        ? { authorization: 'Bearer synthetic-staff-token' }
        : { 'x-internal-secret': 'synthetic-cron-secret' },
      body: options.body ?? { dest_phone: '010-0000-0001', msg_body: '격리된 테스트 메시지' },
    }, response)
    return { response, solapiCalls, oneshotCalls, holdRequests, memberRequests, events }
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

const targetBody = {
  member_id: 'synthetic-plus', dest_phone: '010-0000-0001', msg_body: '격리된 테스트 메시지',
}
const targetMember = {
  id: 'synthetic-plus', phone: '010-0000-0001', assigned_staff_id: 'synthetic-staff',
  team_id: 'synthetic-team', meta: {},
}
const activeStaff = {
  id: 'synthetic-staff', is_active: true, role: 'admin', team_id: 'synthetic-team',
}

test('같은 전화번호의 플러스 회원은 발송 가능하고 이관 보류 중인 815 회원만 차단한다', async (t) => {
  for (const provider of ['solapi', 'oneshot'] as const) {
    for (const auth of ['cron', 'staff'] as const) {
      for (const memberId of ['synthetic-plus', 'synthetic-815']) {
        await t.test(`${provider}/${auth}/${memberId}`, async () => {
          const held = memberId === 'synthetic-815'
          const result = await invoke({ provider, auth, rpc: { data: true }, body: { ...targetBody, member_id: memberId } })
          assert.equal(result.response.statusCode, held ? 423 : 200)
          assert.equal(result.response.body.ok, !held)
          assert.equal(result.solapiCalls + result.oneshotCalls, held ? 0 : 1)
          assert.deepEqual(result.holdRequests, [])
          assert.deepEqual(result.memberRequests, [memberId])
          assert.deepEqual(result.events, held ? ['member-check'] : ['member-check', provider])
        })
      }
    }
  }
})

test('대상 회원의 실제 출처·보류 사유·boolean 정지 값으로만 이관 보류를 판단한다', async (t) => {
  const cases = [
    { meta: { source_site: 'lotto815', reco_paused: true, reco_pause_reason: 'legacy_import_review' }, held: true },
    { meta: { source_site: 'cplotto', reco_paused: true, reco_pause_reason: 'legacy_import_review' }, held: true },
    { meta: { source_site: 'infolotto', reco_paused: true, reco_pause_reason: 'legacy_import_review' }, held: true },
    { meta: { source_site: 'lotto815', reco_paused: false, reco_pause_reason: 'legacy_import_review' }, held: false },
    { meta: { source_site: 'lotto815', reco_paused: true, reco_pause_reason: 'other_reason' }, held: false },
    { meta: { source_site: 'pluslotto', reco_paused: true, reco_pause_reason: 'legacy_import_review' }, held: false },
    { meta: { source_site: null }, held: false },
    { meta: null, held: false },
  ]
  for (const [index, scenario] of cases.entries()) {
    await t.test(String(index), async () => {
      const result = await invoke({ member: { data: { ...targetMember, meta: scenario.meta } }, body: { ...targetBody, check_only: true } })
      assert.equal(result.response.statusCode, scenario.held ? 423 : 200)
      assert.equal(result.solapiCalls + result.oneshotCalls, 0)
      assert.deepEqual(result.holdRequests, [])
    })
  }
})

test('회원별 요청은 검증된 직원 역할의 회원·팀 경계를 지킨다', async (t) => {
  const cases = [
    { name: 'admin은 전체', role: 'admin', teamId: null, assigned: null, memberTeam: null, allowed: true },
    { name: 'manager는 전체', role: 'manager', teamId: null, assigned: null, memberTeam: null, allowed: true },
    { name: 'leader는 같은 팀', role: 'leader', teamId: 'team-a', assigned: null, memberTeam: 'team-a', allowed: true },
    { name: 'leader는 다른 팀 거부', role: 'leader', teamId: 'team-a', assigned: 'synthetic-staff', memberTeam: 'team-b', allowed: false },
    { name: 'leader의 null 팀끼리 일치 불가', role: 'leader', teamId: null, assigned: null, memberTeam: null, allowed: false },
    { name: 'rep은 본인 담당', role: 'rep', teamId: null, assigned: 'synthetic-staff', memberTeam: null, allowed: true },
    { name: 'rep은 같은 팀이어도 타인 담당 거부', role: 'rep', teamId: 'team-a', assigned: 'other-staff', memberTeam: 'team-a', allowed: false },
    { name: 'rep은 미배정 거부', role: 'rep', teamId: null, assigned: null, memberTeam: null, allowed: false },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const result = await invoke({
        auth: 'staff', staff: { data: { ...activeStaff, role: scenario.role, team_id: scenario.teamId } },
        member: { data: { ...targetMember, assigned_staff_id: scenario.assigned, team_id: scenario.memberTeam } },
        // 클라이언트가 보낸 역할·담당자·팀은 권한 근거로 쓰지 않는다.
        body: { ...targetBody, check_only: true, role: 'admin', staff_id: 'other-staff', team_id: 'team-a' },
      })
      assert.equal(result.response.statusCode, scenario.allowed ? 200 : 403)
      assert.equal(result.response.body.code, scenario.allowed ? 'CHECK_ONLY' : 'SMS_TARGET')
      assert.equal(result.solapiCalls + result.oneshotCalls, 0)
      assert.deepEqual(result.holdRequests, [])
    })
  }
})

test('활성 직원과 유효한 역할을 확인하지 못하면 대상 조회 전에 인증을 거부한다', async (t) => {
  const cases: Record<string, RpcResult> = {
    inactive: { data: { ...activeStaff, is_active: false } },
    nullActive: { data: { ...activeStaff, is_active: null } },
    missingActive: { data: { ...activeStaff, is_active: undefined } },
    unknownRole: { data: { ...activeStaff, role: 'owner' } },
    missingTeam: { data: { ...activeStaff, team_id: undefined } },
    missingStaff: { data: null },
    failed: { error: true },
    unavailable: { throws: true },
  }
  for (const [name, staff] of Object.entries(cases)) {
    await t.test(name, async () => {
      const result = await invoke({ auth: 'staff', staff, body: targetBody })
      assert.equal(result.response.statusCode, 401)
      assert.deepEqual(result.events, [])
      assert.equal(result.solapiCalls + result.oneshotCalls, 0)
    })
  }
  const noAuth = await invoke({ auth: 'none', body: { ...targetBody, check_only: true } })
  assert.equal(noAuth.response.statusCode, 401)
  assert.deepEqual(noAuth.memberRequests, [])
})

test('국내·+82·0082·820·00820 표현은 서버 회원 전화번호와 같은 번호일 때만 허용한다', async (t) => {
  const phones = ['010-0000-0001', '+82 10-0000-0001', '0082-10-0000-0001', '+82 (0)10-0000-0001', '0082 (0)10-0000-0001']
  for (const storedPhone of phones) {
    for (const requestedPhone of phones) {
      await t.test(`${storedPhone}/${requestedPhone}`, async () => {
        const result = await invoke({
          member: { data: { ...targetMember, phone: storedPhone } },
          body: { ...targetBody, dest_phone: requestedPhone, check_only: true, source_site: 'pluslotto' },
        })
        assert.equal(result.response.statusCode, 200)
        assert.equal(result.response.body.code, 'CHECK_ONLY')
        assert.equal(result.solapiCalls + result.oneshotCalls, 0)
      })
    }
    await t.test(`815 hold/${storedPhone}`, async () => {
      const result = await invoke({ body: { ...targetBody, member_id: 'synthetic-815', dest_phone: storedPhone } })
      assert.equal(result.response.statusCode, 423)
      assert.equal(result.solapiCalls + result.oneshotCalls, 0)
    })
  }
})

test('대상 누락·다른 전화번호·위조 출처는 번호 전체 조회로 폴백하지 않는다', async (t) => {
  const cases = [
    { body: { ...targetBody, member_id: 'missing-member' }, status: 403 },
    { body: { ...targetBody, dest_phone: '010-0000-0002' }, status: 403 },
    { body: { ...targetBody, dest_phone: '000' }, status: 403 },
    { body: { ...targetBody, source_site: 'lotto815' }, status: 403 },
    { body: { ...targetBody, member_id: 'synthetic-815', source_site: 'pluslotto' }, status: 403 },
    { body: { ...targetBody, source_site: 'all' }, status: 400 },
    { body: { ...targetBody, source_site: null }, status: 400 },
    { body: { ...targetBody, member_id: '' }, status: 400 },
    { body: { ...targetBody, member_id: ' ' }, status: 400 },
    { body: { ...targetBody, member_id: null }, status: 400 },
    { body: { ...targetBody, member_id: 123 }, status: 400 },
    { body: { ...targetBody, member_id: ['synthetic-plus'] }, status: 400 },
    { body: { dest_phone: '010-0000-0001', msg_body: '테스트', source_site: 'pluslotto' }, status: 400 },
  ]
  for (const [index, scenario] of cases.entries()) {
    await t.test(String(index), async () => {
      const result = await invoke({ rpc: { data: false }, body: scenario.body })
      assert.equal(result.response.statusCode, scenario.status)
      assert.equal(result.solapiCalls + result.oneshotCalls, 0)
      assert.deepEqual(result.holdRequests, [])
      assert.doesNotMatch(JSON.stringify(result.response.body), /synthetic|010[-]?0000[-]?0001/)
    })
  }
})

test('대상 회원 조회 오류·알 수 없는 응답은 두 벤더 모두 개인정보 없이 닫힌 상태로 실패한다', async (t) => {
  const cases: Record<string, FixtureOptions> = {
    error: { member: { error: true } },
    connection: { member: { throws: true } },
    wrongId: { member: { data: { ...targetMember, id: 'wrong-member' } } },
    multipleRows: { member: { data: [targetMember, targetMember] } },
    noPhone: { member: { data: { ...targetMember, phone: null } } },
    invalidPhone: { member: { data: { ...targetMember, phone: '000' } } },
    missingAssignment: { member: { data: { ...targetMember, assigned_staff_id: undefined } } },
    wrongTeam: { member: { data: { ...targetMember, team_id: 123 } } },
    missingMeta: { member: { data: { ...targetMember, meta: undefined } } },
    arrayMeta: { member: { data: { ...targetMember, meta: [] } } },
    unknownSite: { member: { data: { ...targetMember, meta: { source_site: 'unknown' } } } },
    invalidSite: { member: { data: { ...targetMember, meta: { source_site: 123 } } } },
    stringPause: { member: { data: { ...targetMember, meta: { source_site: 'lotto815', reco_paused: 'false' } } } },
    invalidReason: { member: { data: { ...targetMember, meta: { reco_pause_reason: [] } } } },
    missingUrl: { missingConfig: 'url' },
    missingKey: { missingConfig: 'key' },
  }
  for (const [name, options] of Object.entries(cases)) {
    for (const provider of ['solapi', 'oneshot'] as const) {
      await t.test(`${name}/${provider}`, async () => {
        const result = await invoke({ ...options, provider, body: targetBody })
        assert.equal(result.response.statusCode, 503)
        assert.equal(result.response.body.code, 'SMS_HOLD_CHECK')
        assert.equal(result.solapiCalls + result.oneshotCalls, 0)
        assert.deepEqual(result.holdRequests, [])
        assert.doesNotMatch(JSON.stringify(result.response.body), /synthetic|010[-]?0000[-]?0001/)
      })
    }
  }
})

test('회원 check_only는 실제 본문이 있어도 정상 대상 검증 뒤 벤더를 호출하지 않는다', async () => {
  const result = await invoke({ provider: 'oneshot', body: { ...targetBody, check_only: true } })
  assert.equal(result.response.body.code, 'CHECK_ONLY')
  assert.deepEqual(result.events, ['member-check'])
  assert.equal(result.solapiCalls + result.oneshotCalls, 0)
})
