import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import handler from '../../api/resend-failed-sms.ts'
import * as retry from '../../src/lib/smsRetry.ts'

const require = createRequire(import.meta.url)
const ambiguous = ['실패', '실패(?)', '실패(NET)', '실패(NET_ERR)', '실패(EXCEPTION)',
  '실패(D179)', '실패(906)', '실패(999)', '실패(새코드)']

test('상태 문자열은 어떤 실패도 자동 재발송 권한으로 바꾸지 않는다', () => {
  for (const status of [...ambiguous, '실패(305)', '발송완료', '접수확인필요(요청중)', null, undefined]) {
    assert.equal(retry.isRetriableFailure(status), false, String(status))
  }
})

async function request(options: { authorized?: boolean; method?: string; query?: Record<string, unknown> } = {}) {
  let status = 0
  let body: Record<string, unknown> = {}
  const response = {
    status(value: number) { status = value; return response },
    json(value: Record<string, unknown>) { body = value; return response },
  }
  await handler({ method: options.method ?? 'GET',
    headers: { authorization: options.authorized === false ? 'Bearer wrong' : 'Bearer synthetic-cron' },
    query: options.query ?? {} }, response)
  return { status, body }
}

test('중복 실패·동시 호출·임의 승인 인자가 있어도 서버는 네트워크/DB 접근 없이 보류한다', async () => {
  const original = process.env.CRON_SECRET
  const originalFetch = globalThis.fetch
  process.env.CRON_SECRET = 'synthetic-cron'
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls++; throw new Error('Real network forbidden') }
  try {
    // 같은 계약의 중복 실패와 타 사이트 동일번호 계약도 일괄 처리하지 않는다.
    const failures = ambiguous.flatMap((status, i) => [
      { id: `a-${i}`, member_id: 'same-contract', phone: '01000000001', body: 'same', status },
      { id: `b-${i}`, member_id: 'same-contract', phone: '01000000001', body: 'same', status },
      { id: `c-${i}`, member_id: 'other-site-contract', phone: '01000000001', body: 'same', status },
    ])
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => request({ query: {
      dryRun: i % 2 ? '1' : '0', day: '2026-10-06', type: 'all', force: '1',
      receipt_verified: true, provider_not_accepted: true, failedRows: failures,
    } })))
    for (const { status, body } of results) {
      assert.equal(status, 200)
      assert.equal(body.skipped, 'receipt_confirmation_required')
      assert.equal(body.code, retry.SMS_RETRY_RECEIPT_REQUIRED)
      assert.equal(body.automaticRetryEnabled, false)
      assert.equal(body.attempted, 0)
      assert.equal(body.sent, 0)
      assert.equal(body.wouldSend, 0)
      assert.equal(body.failed, undefined, '미조회 건수를 실패 0건으로 오표시하지 않는다')
    }
    assert.equal(networkCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (original === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original
  }
})

test('서버 보류 응답에도 인증과 method 경계는 유지한다', async () => {
  const original = process.env.CRON_SECRET
  try {
    delete process.env.CRON_SECRET
    assert.equal((await request()).status, 500)
    process.env.CRON_SECRET = 'synthetic-cron'
    assert.equal((await request({ authorized: false })).status, 401)
    assert.equal((await request({ method: 'POST' })).status, 405)
    assert.equal((await request({ method: 'DELETE' })).status, 405)
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original
  }
})

function loadModule(path: string, dependencies: Record<string, unknown>): Record<string, unknown> {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const exported = {}
  vm.runInNewContext(js, {
    exports: exported,
    require(name: string) {
      assert.ok(Object.hasOwn(dependencies, name), `검수되지 않은 의존성: ${name}`)
      return dependencies[name]
    },
  })
  return exported
}

test('프런트 일괄 재발송 직접 호출도 공급업체·DB·진행 콜백을 실행하지 않는다', async () => {
  let accesses = 0
  const forbidden = () => { accesses++; throw new Error('DB access forbidden') }
  const mod = loadModule('../../src/features/settings/smsResend.ts', {
    '@/lib/db/remote': { sb: forbidden, paginateAll: forbidden }, '@/lib/smsRetry': retry,
  })
  const resend = mod.resendFailedSms as (day: string, actor: string, options: { onProgress: () => void }) => Promise<Record<string, unknown>>
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    resend('2026-10-06', 'synthetic-admin', { onProgress: forbidden })))
  for (const result of results) {
    assert.equal(result.blocked, true)
    assert.equal(result.code, retry.SMS_RETRY_RECEIPT_REQUIRED)
    assert.equal(result.attempted, 0)
    assert.equal(result.sent, 0)
  }
  assert.equal(accesses, 0)
})

test('실패 현황 조회는 건수와 원인만 집계하고 재발송 가능 건수로 표시하지 않는다', async () => {
  const rows = ambiguous.map((status, id) => ({ id, status }))
  const mod = loadModule('../../src/features/settings/smsResend.ts', {
    '@/lib/db/remote': { paginateAll: async () => rows, sb: () => { throw new Error('unused') } },
    '@/lib/smsRetry': retry,
  })
  const fetchFailed = mod.fetchFailedSms as (day: string) => Promise<Record<string, unknown>>
  const result = await fetchFailed('2026-10-06')
  assert.equal(result.requiresReceiptReview, rows.length)
  assert.equal(result.retriable, undefined)
  assert.equal(result.permanent, undefined)
})

function renderCard(options: { role?: string; error?: boolean; rows?: unknown[] } = {}) {
  let enabled: unknown
  const mod = loadModule('../../src/features/settings/FailedSmsResendCard.tsx', {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'), 'lucide-react': require('lucide-react'),
    '@/design-system/components': { Button: ({ children }: { children: React.ReactNode }) => React.createElement('button', null, children) },
    '@/lib/auth': { useRole: () => options.role ?? 'admin' }, '@/lib/smsRetry': retry,
    './ui': { hintCls: 'hint', SectionCard: ({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) =>
      React.createElement('section', null, React.createElement('h2', null, title), React.createElement('p', null, desc), children) },
    './api': { useFailedSms: (_day: string, _type: string, allowed: boolean) => {
      enabled = allowed
      return { isError: !!options.error, isFetching: false, refetch() {}, data: options.error ? undefined : {
        rows: options.rows ?? [], byCode: [], requiresReceiptReview: options.rows?.length ?? 0,
      } }
    } },
  })
  return { html: renderToStaticMarkup(React.createElement(mod.FailedSmsResendCard as React.ComponentType)), enabled }
}

test('화면은 보류와 충전 후 자동회수 중지를 명시하고 발송 버튼을 노출하지 않는다', () => {
  const { html } = renderCard({ rows: [{ id: 'failure' }] })
  assert.match(html, /충전 후에도 자동 재발송하지 않습니다/)
  assert.match(html, /개별 1회 처리/)
  assert.match(html, /실패 1건/)
  assert.doesNotMatch(html, /<button[^>]*>[^<]*다시 보내기|재발송 완료|이 화면에서만 복구|다시 가지 않습니다/)
})

test('빈 결과는 정상 접수/수신 완료로 추론하지 않고 오류와 권한 경계를 렌더링한다', () => {
  const empty = renderCard().html
  assert.match(empty, /조회된 실패 기록이 없습니다/)
  assert.doesNotMatch(empty, /모두 정상 발송/)
  assert.match(renderCard({ error: true }).html, /실패 건을 불러오지 못했습니다/)
  const rep = renderCard({ role: 'rep' })
  assert.equal(rep.html, '')
  assert.equal(rep.enabled, false)
})
