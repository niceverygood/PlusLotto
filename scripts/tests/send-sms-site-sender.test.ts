import assert from 'node:assert/strict'
import test from 'node:test'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import handler, { __resetSiteSenderCacheForTests } from '../../api/send-sms.ts'

// 사이트별 발신번호를 서버가 다시 고르는지 검증한다(현장 9/18 — 이관 사이트 운영 시작 선행조건).
// 실제 DB·문자 벤더에는 접근하지 않는다. 벤더로 나간 발신번호를 직접 꺼내 대조한다.

type SiteSettingsFixture = { data?: unknown; error?: boolean }
type Options = {
  /** 회원 meta.source_site. 미지정이면 플러스로또. */
  site?: string
  /** site_settings 응답. 미지정이면 815·인포·일행 3사 모두 등록된 정상 설정. */
  settings?: SiteSettingsFixture
}

const DEFAULT_SETTINGS = {
  sms: {
    sender_no: '0212340000',
    by_site: {
      lotto815: { sender_no: '025550815' },
      infolotto: { sender_no: '02-555-1111' }, // 하이픈이 섞여 있어도 숫자만 남겨야 한다
      cplotto: { sender_no: '025553333' },
    },
  },
}

async function invoke(options: Options = {}) {
  __resetSiteSenderCacheForTests()
  const env: Record<string, string | undefined> = {
    CRON_SECRET: 'synthetic-cron-secret',
    SUPABASE_URL: 'https://sms-sender-test.supabase.co',
    VITE_SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    ONESHOT_ID: 'synthetic-id',
    ONESHOT_SEND_PHONE: '0212340000',
    ONESHOT_RESELLER: undefined,
    SOLAPI_API_KEY: 'synthetic-solapi-key',
    SOLAPI_API_SECRET: 'synthetic-solapi-secret',
    SOLAPI_ENABLED: 'true',
    FIXIE_URL: undefined,
    PROXY_URL: undefined,
  }
  const originalEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  const originalFetch = globalThis.fetch
  const originalDispatcher = getGlobalDispatcher()
  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  setGlobalDispatcher(mockAgent)

  let vendorCalls = 0
  let sentFrom: string | null = null
  let settingsReads = 0
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin === 'https://sms-sender-test.supabase.co') {
      if (url.pathname === '/rest/v1/members') {
        const site = options.site
        return json({
          id: 'synthetic-member',
          phone: '010-0000-0001',
          assigned_staff_id: 'synthetic-staff',
          team_id: 'synthetic-team',
          // 보류가 아닌 정상 회원이어야 발신번호 결정 단계까지 온다.
          meta: site ? { source_site: site } : {},
        })
      }
      if (url.pathname === '/rest/v1/site_settings') {
        settingsReads += 1
        if (options.settings?.error) return json({ code: 'TEST_ERROR' }, 500)
        return json(options.settings ? options.settings.data : DEFAULT_SETTINGS)
      }
    }
    if (url.href === 'https://api.solapi.com/messages/v4/send') {
      vendorCalls += 1
      sentFrom = String((JSON.parse(String(init?.body)) as { message: { from: string } }).message.from)
      return json({ statusCode: '2000', messageId: 'synthetic-message' })
    }
    throw new Error(`Unexpected network request in isolated SMS test: ${url.href}`)
  }

  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
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
      headers: { 'x-internal-secret': 'synthetic-cron-secret' },
      body: {
        member_id: 'synthetic-member',
        dest_phone: '010-0000-0001',
        msg_body: '격리된 테스트 메시지',
        // 호출자는 여전히 플러스로또 기본 번호를 보낸다 — 서버가 덮어써야 한다.
        send_phone: '0212340000',
      },
    }, response)
    return { response, vendorCalls, sentFrom, settingsReads }
  } finally {
    globalThis.fetch = originalFetch
    setGlobalDispatcher(originalDispatcher)
    await mockAgent.close()
    __resetSiteSenderCacheForTests()
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('이관 사이트 회원은 호출자가 보낸 기본 발신번호 대신 그 사이트 번호로 나간다', async (t) => {
  for (const [site, expected] of [
    ['lotto815', '025550815'],
    ['infolotto', '025551111'], // 하이픈 제거 확인
    ['cplotto', '025553333'],
  ] as const) {
    await t.test(site, async () => {
      const r = await invoke({ site })
      assert.equal(r.response.statusCode, 200)
      assert.equal(r.vendorCalls, 1)
      assert.equal(r.sentFrom, expected)
    })
  }
})

test('플러스로또 회원은 기존 발신번호를 그대로 쓰고 설정을 조회하지 않는다', async () => {
  const r = await invoke()
  assert.equal(r.response.statusCode, 200)
  assert.equal(r.vendorCalls, 1)
  assert.equal(r.sentFrom, '0212340000')
  // 기존 대다수 발송 경로에 조회를 한 번 더 붙이지 않는다.
  assert.equal(r.settingsReads, 0)
})

test('발신번호가 설정되지 않은 이관 사이트는 기본 번호로 폴백하지 않고 거부한다', async () => {
  const r = await invoke({ site: 'lotto815', settings: { data: { sms: { sender_no: '0212340000' } } } })
  assert.equal(r.response.statusCode, 409)
  assert.equal(r.response.body.code, 'SMS_SENDER_UNSET')
  assert.equal(r.vendorCalls, 0, '설정 누락 시 문자가 나가면 안 된다')
})

test('빈 문자열·비숫자 발신번호도 미설정으로 보고 거부한다', async () => {
  for (const bad of ['', '   ', '번호없음']) {
    const r = await invoke({
      site: 'lotto815',
      settings: { data: { sms: { sender_no: '0212340000', by_site: { lotto815: { sender_no: bad } } } } },
    })
    assert.equal(r.response.statusCode, 409, `발신번호 ${JSON.stringify(bad)} 는 거부되어야 한다`)
    assert.equal(r.vendorCalls, 0)
  }
})

test('설정 조회가 실패하면 열지 않고 닫는다', async () => {
  const r = await invoke({ site: 'lotto815', settings: { error: true } })
  assert.equal(r.response.statusCode, 503)
  assert.equal(r.response.body.code, 'SMS_SENDER_LOOKUP')
  assert.equal(r.vendorCalls, 0, '조회 실패를 설정 없음으로 간주해 기본 번호로 보내면 안 된다')
})
