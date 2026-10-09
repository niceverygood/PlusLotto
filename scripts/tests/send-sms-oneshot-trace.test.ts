import assert from 'node:assert/strict'
import test from 'node:test'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import handler, { __resetSiteSenderCacheForTests } from '../../api/send-sms.ts'

// 원샷 경로가 건별 추적번호(tran_id)를 업체로 보내고, 대조에 필요한 발송 사실을 돌려주는지 검증한다
// (현장 10/9 — 접수 성공인데 업체 전송내역에 없는 3명을 1:1로 대조할 수 없었다).
// 실제 DB·문자 업체에는 접근하지 않는다.

async function invoke(tranId: unknown, vendorReply: string) {
  __resetSiteSenderCacheForTests()
  const env: Record<string, string | undefined> = {
    CRON_SECRET: 'synthetic-cron-secret',
    SUPABASE_URL: 'https://sms-trace-test.supabase.co',
    VITE_SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
    ONESHOT_ID: 'synthetic-id',
    ONESHOT_SEND_PHONE: '0212340000',
    ONESHOT_RESELLER: undefined,
    SOLAPI_API_KEY: undefined,
    SOLAPI_API_SECRET: undefined,
    SOLAPI_ENABLED: undefined,
    FIXIE_URL: undefined,
    PROXY_URL: undefined,
  }
  const originalEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  const originalFetch = globalThis.fetch
  const originalDispatcher = getGlobalDispatcher()
  const mockAgent = new MockAgent()
  mockAgent.disableNetConnect()
  setGlobalDispatcher(mockAgent)

  const forms: FormData[] = []
  mockAgent.get('https://api2.msgagent.com')
    .intercept({ path: '/api/webshot/send/general/LMS/synthetic-id', method: 'POST' })
    .reply(200, (opts) => {
      // undici 의 FormData 는 전역 FormData 와 다른 클래스라 instanceof 대신 모양으로 확인한다.
      const form = opts.body as unknown as { get?: unknown }
      if (form && typeof form.get === 'function') forms.push(opts.body as unknown as FormData)
      return vendorReply
    })

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin === 'https://sms-trace-test.supabase.co') {
      if (url.pathname === '/rest/v1/members')
        return json({ id: 'synthetic-member', phone: '010-0000-0001', assigned_staff_id: 'synthetic-staff',
          team_id: 'synthetic-team', meta: { source_site: 'lotto815' } })
      if (url.pathname === '/rest/v1/site_settings')
        return json({ sms: { sender_no: '0212340000', by_site: { lotto815: { sender_no: '1661-5333' } } } })
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
        source_site: 'lotto815',
        dest_phone: '010-0000-0001',
        msg_body: '격리된 테스트 메시지',
        send_phone: '0212340000',
        msgType: 'LMS',
        tran_id: tranId,
      },
    }, response)
    return { response, forms }
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

test('원샷 발송은 추적번호를 업체로 보내고 실제 발신번호·시각·업체 응답을 돌려준다', async () => {
  const { response, forms } = await invoke('R2h4kx9q', JSON.stringify({ result_code: '0', result_msg: 'success' }))
  assert.equal(response.statusCode, 200)
  assert.equal(forms.length, 1)
  assert.equal(forms[0].get('tran_id'), 'R2h4kx9q')
  assert.equal(forms[0].get('send_phone'), '16615333')
  const b = response.body
  assert.equal(b.ok, true)
  assert.equal(b.provider, 'oneshot')
  assert.equal(b.sender, '16615333', '호출자가 보낸 번호가 아니라 사이트별로 다시 고른 실제 번호')
  assert.equal(b.dest, '01000000001')
  assert.equal(b.tranId, 'R2h4kx9q')
  assert.equal(b.providerHttpStatus, 200)
  assert.match(String(b.requestedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.match(String(b.respondedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.deepEqual(b.raw, { result_code: '0', result_msg: 'success' })
})

test('추적번호는 영문·숫자·_- 30자로 정리하고, 없으면 보내지 않는다', async () => {
  const dirty = await invoke('R-1;DROP 한글_' + 'x'.repeat(40), JSON.stringify({ result_code: '0' }))
  const sent = String(dirty.forms[0].get('tran_id'))
  assert.match(sent, /^[A-Za-z0-9_-]{1,30}$/)
  assert.equal(sent, 'R-1DROP_' + 'x'.repeat(22))
  assert.equal(dirty.response.body.tranId, sent)

  for (const missing of [undefined, 42, '', '한글']) {
    const r = await invoke(missing, JSON.stringify({ result_code: '0' }))
    assert.equal(r.forms[0].get('tran_id'), null)
    assert.equal(r.response.body.tranId, null)
  }
})

test('업체가 JSON 이 아닌 응답을 주면 원문을 잘라 보존하고 실패로 본다', async () => {
  const { response } = await invoke('R1', '<html>' + 'e'.repeat(5000))
  assert.equal(response.body.ok, false)
  assert.equal(String((response.body.raw as { raw: string }).raw).length, 2000)
})
