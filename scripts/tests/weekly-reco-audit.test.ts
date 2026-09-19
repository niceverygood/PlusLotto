import assert from 'node:assert/strict'
import test from 'node:test'

import {
  expectsComboSms,
  recoAuditMisses,
  recoSkipReason,
  type RecoAuditCtx,
  type RecoGateCtx,
} from '../../api/weekly-reco.ts'

const TODAY_KST = '2026-09-22'
const SINCE = '2026-09-22T00:00:00.000Z'
const ROUND = 1243

const ctx: RecoGateCtx = {
  today: 2, // 화요일
  todayKst: TODAY_KST,
  force: false,
  autoEnabled: true,
  paidSmsOn: true,
  targetRound: ROUND,
}

function auditCtx(over: Partial<RecoAuditCtx> = {}): RecoAuditCtx {
  return { ...ctx, sinceIso: SINCE, smsOk: new Set(), smsFail: new Set(), ...over }
}

type Row = Parameters<typeof recoAuditMisses>[0][number]

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    grade: 'vip',
    name: `회원${id}`,
    phone: `0100000${id.padStart(4, '0')}`,
    meta: { weekly_reco_day: 2 },
    registered_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

/** 발급까지 끝난 회원의 meta. */
function issued(day = 2, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { weekly_reco_day: day, weekly_recos: [{ round_no: ROUND, issued_at: SINCE, sets: [] }], ...extra }
}

// ── 게이트가 발송 루프와 같은 규칙인지 ────────────────────────────────────────
test('발급 대상/제외 판정이 한 함수로 모인다', () => {
  assert.equal(recoSkipReason({ grade: 'vip', meta: { weekly_reco_day: 2 } }, ctx), null)
  assert.equal(recoSkipReason({ grade: 'vip', meta: { weekly_reco_day: 3 } }, ctx), 'day')
  assert.equal(recoSkipReason({ grade: 'vip', meta: null }, ctx), 'day') // 유료 요일 미설정
  assert.equal(recoSkipReason({ grade: 'free', meta: null }, { ...ctx, today: 5 }), null) // 무료 기본요일
  assert.equal(recoSkipReason({ grade: 'vip', meta: { weekly_reco_day: 2, reco_paused: true } }, ctx), 'paused')
  assert.equal(
    recoSkipReason({ grade: 'vip', meta: { weekly_reco_day: 2, end_date: '2026-09-21' } }, ctx),
    'expired',
  )
  assert.equal(
    recoSkipReason({ grade: 'vip', meta: { weekly_reco_day: 2, end_date: TODAY_KST } }, ctx),
    null, // 종료일 당일까지는 이용 가능
  )
  assert.equal(
    recoSkipReason({ grade: 'vip', meta: { weekly_reco_day: 2, weekly_reco_count: 0 } }, ctx),
    'count-zero',
  )
  assert.equal(recoSkipReason({ grade: 'vip', meta: issued() }, ctx), 'already')
})

test('일시정지는 force 로도 우회되지 않는다', () => {
  const forced = { ...ctx, force: true }
  assert.equal(recoSkipReason({ grade: 'vip', meta: { weekly_reco_day: 9, reco_paused: true } }, forced), 'paused')
  assert.equal(recoSkipReason({ grade: 'vip', meta: { weekly_reco_day: 9, end_date: '2020-01-01' } }, forced), 'expired')
})

// ── 허위 누락을 만들지 않는다(이 기능의 핵심) ────────────────────────────────
test('정상 제외 사유 4종은 누락으로 잡히지 않는다', () => {
  const rows = [
    row('1', { registered_at: '2026-09-22T09:10:00.000Z' }), // 발송 시작 이후 가입
    row('2', { meta: { weekly_reco_day: 2, end_date: '2026-09-01' } }), // 종료일 경과
    row('3', { meta: { weekly_reco_day: 2, reco_paused: true } }), // 일시정지
    row('4', { meta: { weekly_reco_day: 2, weekly_reco_count: 0 } }), // 발송갯수 0
    row('5', { meta: { weekly_reco_day: 4 } }), // 그날 지정요일 아님
  ]
  const r = recoAuditMisses(rows, auditCtx())
  assert.deepEqual(r.misses, [])
  assert.equal(r.expected, 0)
  assert.equal(r.checked, 5)
  assert.deepEqual(r.excluded, {
    day: 1,
    paused: 1,
    expired: 1,
    count_zero: 1,
    registered_after: 1,
    no_phone: 0,
  })
})

test('발송 시작 이후 가입자는 발급 기록이 없어도 누락이 아니다', () => {
  // 신규 가입자를 매번 누락으로 올리면 현장이 목록 자체를 믿지 않게 된다.
  const late = row('n', { registered_at: '2026-09-22T09:30:00.000Z', meta: { weekly_reco_day: 2 } })
  assert.deepEqual(recoAuditMisses([late], auditCtx()).misses, [])
  // 반대로 발송 시작 전 가입자는 잡아야 한다.
  const early = row('e', { registered_at: '2026-09-21T23:59:00.000Z', meta: { weekly_reco_day: 2 } })
  assert.deepEqual(
    recoAuditMisses([early], auditCtx()).misses.map((m) => m.reason),
    ['not_issued'],
  )
})

// ── 진짜 누락 3종 ────────────────────────────────────────────────────────────
test('조합 자체가 발급되지 않은 회원을 not_issued 로 잡는다', () => {
  // 2026-09-16 88로또 951명 사고 유형 — 함수가 중간에 끊겨 뒤쪽 회원이 통째로 빠졌다.
  const rows = [row('a', { meta: issued() }), row('b'), row('c')]
  const r = recoAuditMisses(rows, auditCtx({ smsOk: new Set(['a']) }))
  assert.deepEqual(
    r.misses.map((m) => [m.member_id, m.reason]),
    [
      ['b', 'not_issued'],
      ['c', 'not_issued'],
    ],
  )
  assert.equal(r.expected, 3)
})

test('발급됐지만 문자 기록이 없으면 sms_missing, 실패 응답이면 sms_failed', () => {
  const rows = [
    row('ok', { meta: issued() }),
    row('gone', { meta: issued() }),
    row('failed', { meta: issued() }),
  ]
  const r = recoAuditMisses(rows, auditCtx({ smsOk: new Set(['ok']), smsFail: new Set(['failed']) }))
  assert.deepEqual(
    r.misses.map((m) => [m.member_id, m.reason]),
    [
      ['gone', 'sms_missing'],
      ['failed', 'sms_failed'],
    ],
  )
})

test('누락 목록에 이름·번호가 담겨 현장이 바로 연락할 수 있다', () => {
  const [miss] = recoAuditMisses([row('x', { name: '김민재', phone: '01084910930' })], auditCtx()).misses
  assert.deepEqual(miss, {
    member_id: 'x',
    name: '김민재',
    phone: '01084910930',
    grade: 'vip',
    reason: 'not_issued',
  })
})

// ── 문자 대상 판정 ───────────────────────────────────────────────────────────
test('무료회원은 발급만 받고 문자 미발송이 누락이 아니다', () => {
  const free = row('f', { grade: 'free', meta: issued(5) })
  const r = recoAuditMisses([free], auditCtx({ today: 5 }))
  assert.deepEqual(r.misses, [])
  assert.equal(r.expected, 1)
})

test('유료 SMS 가 꺼져 있으면 문자 미발송을 누락으로 보지 않는다', () => {
  const rows = [row('p', { meta: issued() })]
  assert.deepEqual(recoAuditMisses(rows, auditCtx({ paidSmsOn: false })).misses, [])
})

test('유료인데 번호가 없으면 누락이 아니라 회원정보 문제로 따로 센다', () => {
  const r = recoAuditMisses([row('np', { phone: null, meta: issued() })], auditCtx())
  assert.deepEqual(r.misses, [])
  assert.equal(r.excluded.no_phone, 1)
})

test('재발송으로 성공 기록이 생기면 앞선 실패는 누락이 아니다', () => {
  const rows = [row('r', { meta: issued() })]
  const r = recoAuditMisses(rows, auditCtx({ smsOk: new Set(['r']), smsFail: new Set(['r']) }))
  assert.deepEqual(r.misses, [])
})

test('expectsComboSms 는 유료 SMS 가동·유료등급·번호 세 조건을 모두 본다', () => {
  assert.equal(expectsComboSms({ grade: 'vip', phone: '01000000000' }, { paidSmsOn: true }), true)
  assert.equal(expectsComboSms({ grade: 'free', phone: '01000000000' }, { paidSmsOn: true }), false)
  assert.equal(expectsComboSms({ grade: 'vip', phone: null }, { paidSmsOn: true }), false)
  assert.equal(expectsComboSms({ grade: 'vip', phone: '01000000000' }, { paidSmsOn: false }), false)
})

// ── 구조 가드 ────────────────────────────────────────────────────────────────
// 판정 규칙이 발송 루프와 대조 양쪽에 따로 적히면 한쪽만 고쳐질 때 허위 목록이 나간다.
// 소스에서 "게이트를 직접 다시 구현했는지"를 막는다.
test('발송 루프와 누락 대조가 판정 함수를 공유한다', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('../../api/weekly-reco.ts', import.meta.url)), 'utf8')

  const count = (needle: string) => src.split(needle).length - 1

  // 각 판정 조건은 파일 전체에서 정확히 한 번(= recoSkipReason 본문)만 나와야 한다.
  // 두 번 나오면 발송 루프나 대조가 게이트를 따로 구현한 것이고, 규칙이 갈라진다.
  for (const expr of [
    'recoSafetyBlockReason(meta, ctx.todayKst)', // 일시정지·종료일
    'meta.weekly_reco_count === 0', // 발송갯수 0
    'recos[0]?.round_no === ctx.targetRound', // 이미 발급됨
    '? DEFAULT_DAY', // 무료 기본 발송요일
  ]) {
    assert.equal(count(expr), 1, `판정 조건이 여러 곳에 적혀 있다: ${expr}`)
  }

  // 발송 루프와 대조는 모두 공용 게이트를 호출해야 한다.
  assert.equal(count('recoSkipReason(r, gateCtx)'), 1, '발송 루프가 공용 게이트를 써야 한다')
  assert.equal(count('recoSkipReason(r, ctx)'), 1, '대조가 공용 게이트를 써야 한다')
})

test('대조 실행(audit=1)은 발송을 하지 않고 또 다른 대조를 부르지 않는다', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('../../api/weekly-reco.ts', import.meta.url)), 'utf8')

  const branch = src.indexOf('if (auditOnly) {')
  assert.ok(branch > 0, 'auditOnly 분기가 있어야 한다')
  const branchEnd = src.indexOf('\n    }\n', branch)
  const body = src.slice(branch, branchEnd)
  // 대조 분기 안에서 문자 발송·회원 갱신·자기 재호출이 일어나면 안 된다.
  for (const forbidden of ['sendComboSms', "from('members').update", 'audit=1', 'chain=']) {
    assert.ok(!body.includes(forbidden), `대조 분기가 ${forbidden} 를 해서는 안 된다`)
  }
  // 그리고 발송 경로보다 먼저 빠져나가야 한다.
  assert.ok(body.includes('return res.status(200).json('), '대조 분기는 자체 응답으로 끝나야 한다')
  assert.ok(branch < src.indexOf('const eligible:'), '대조 분기가 발송 루프보다 앞에 있어야 한다')
})
