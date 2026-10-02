import assert from 'node:assert/strict'
import test from 'node:test'
import { formatComboSms, recoAuditMisses, scanRecoSms } from '../../api/weekly-reco.ts'
import { recoSmsBody } from '../../src/lib/sms.ts'

const sets = [[1, 7, 14, 21, 35, 42]]
const brands = [
  ['pluslotto', '플러스로또'], ['lotto815', '815로또'], ['infolotto', '인포로또'],
  ['cplotto', '일행로또'], ['best', '프리미엄로또'],
] as const

test('자동/수동 조합문자와 미리보기는 회원 계약의 $brand를 같은 본문으로 치환한다', () => {
  for (const [site, label] of brands) {
    const template = '[$brand] No. $round\n$name님\n$num'
    const meta = { source_site: site }
    const expected = `[${label}] No. 1245\n검수회원님\n[1] 1,7,14,21,35,42`
    assert.equal(formatComboSms('검수회원', 1245, sets, template, meta), expected)
    assert.equal(recoSmsBody('검수회원', 1245, sets, template, meta), expected)
  }
})

test('템플릿 없는 이관 회원도 자체 브랜드를 쓰고 기존 플러스 기본 문구는 보존한다', () => {
  for (const [site, label] of brands) {
    const meta = { source_site: site }
    const expected = `${site === 'pluslotto' ? 'plus' : label} No. 1245\n회원님\n[1] 1,7,14,21,35,42`
    assert.equal(formatComboSms('', 1245, sets, undefined, meta), expected)
    assert.equal(recoSmsBody('', 1245, sets, undefined, meta), expected)
  }
  assert.equal(formatComboSms('', 1245, sets), recoSmsBody('', 1245, sets))
})

test('출처 공백을 정규화하고 미지원 출처는 본문에 노출하지 않는다', () => {
  for (const [site, expected] of [[' best ', '프리미엄로또'], ['unknown', '플러스로또'], ['__proto__', '플러스로또'], ['', '플러스로또']]) {
    const meta = { source_site: site }
    assert.equal(formatComboSms('', 1245, sets, '$brand', meta), expected)
    assert.equal(recoSmsBody('', 1245, sets, '$brand', meta), expected)
  }
})

test('운영의 정확한 구 기본 템플릿은 이관 4사이트에서만 자체 이름으로 표시한다', () => {
  const oldDefault = 'plus No. $round\n$num'
  for (const [site, label] of brands) {
    const meta = { source_site: site }
    const expected = `${site === 'pluslotto' ? 'plus' : label} No. 1245\n[1] 1,7,14,21,35,42`
    assert.equal(formatComboSms('검수회원', 1245, sets, oldDefault, meta), expected)
    assert.equal(recoSmsBody('검수회원', 1245, sets, oldDefault, meta), expected)
  }
  for (const meta of [undefined, null, {}, { source_site: '' }, { source_site: 'unknown' }]) {
    const expected = 'plus No. 1245\n[1] 1,7,14,21,35,42'
    assert.equal(formatComboSms('검수회원', 1245, sets, oldDefault, meta), expected)
    assert.equal(recoSmsBody('검수회원', 1245, sets, oldDefault, meta), expected)
  }
})

test('plus가 포함된 사용자 지정 문구와 구 기본 템플릿의 변형은 덮어쓰지 않는다', () => {
  for (const template of [
    'plus 검수 안내 No. $round\n$num',
    'plus No. $round\n$name님\n$num',
    'plus No. $round\n$num\n',
    ' plus No. $round\n$num',
    'PLUS No. $round\n$num',
  ]) {
    const expected = template.replace('$round', '1245').replace('$name', '검수회원').replace('$num', '[1] 1,7,14,21,35,42')
    assert.equal(formatComboSms('검수회원', 1245, sets, template, { source_site: 'best' }), expected)
    assert.equal(recoSmsBody('검수회원', 1245, sets, template, { source_site: 'best' }), expected)
  }
})

test('실패 후 재발송 완료는 성공으로 대조하고 같은 번호의 타 사이트 계약은 별도 확인한다', async () => {
  const rows = [
    { id: '1', member_id: 'plus-contract', status: '실패(D179)' },
    { id: '2', member_id: 'plus-contract', status: '발송완료(재발송)' },
    { id: '3', member_id: '815-contract', status: '실패(SMS_SENDER_UNSET)' },
    { id: '4', member_id: 'info-contract', status: '발송완료' },
    { id: '5', member_id: 'plus-contract', status: '실패(NET)' },
  ]
  // Isolated PostgREST page fixture: no database or vendor calls.
  const sb = {
    from(table: string) {
      assert.equal(table, 'sms_sends')
      let cursor = ''
      let limit = 1000
      const query = {
        select() { return query },
        eq() { return query },
        gte() { return query },
        order() { return query },
        limit(value: number) { limit = value; return query },
        gt(column: string, value: string) { assert.equal(column, 'id'); cursor = value; return query },
        then: <T>(resolve: (value: { data: typeof rows; error: null }) => T) =>
          Promise.resolve(resolve({ data: rows.filter(row => row.id > cursor).slice(0, limit), error: null })),
      }
      return query
    },
  }
  const sms = await scanRecoSms(sb, '2026-10-06T00:00:00Z', 2)
  assert.deepEqual([...sms.ok].sort(), ['info-contract', 'plus-contract'])
  assert.deepEqual([...sms.fail], ['815-contract'])
  const members = ['plus-contract', '815-contract', 'info-contract'].map(id => ({
    id, grade: 'vip', name: '검수회원', phone: '01000000001', registered_at: '2026-01-01T00:00:00Z',
    meta: { weekly_reco_day: 2, weekly_recos: [{ round_no: 1245 }] },
  }))
  const audit = recoAuditMisses(members, {
    today: 2, todayKst: '2026-10-06', force: false, autoEnabled: true, paidSmsOn: true,
    targetRound: 1245, sinceIso: '2026-10-06T00:00:00Z', smsOk: sms.ok, smsFail: sms.fail,
  })
  assert.equal(audit.expected, 3)
  assert.deepEqual(audit.misses.map(row => [row.member_id, row.reason]), [['815-contract', 'sms_failed']])
})
