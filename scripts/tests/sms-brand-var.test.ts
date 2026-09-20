import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSms } from '../../src/lib/sms.ts'
import { memberSiteLabel } from '../../src/lib/siteScope.ts'
import type { Member } from '../../src/types/db.ts'

// 이관 사이트 회원에게 "플러스로또" 라고 적힌 문자가 나가면 회원은 자기가 가입한 곳이 아니라고
// 본다(현장 9/18). 템플릿 한 벌 + $brand 로 사이트 이름만 갈아끼운다.
function member(meta: Record<string, unknown> | null): Member {
  return {
    id: 'm1',
    user_id: 'pl1001',
    name: '홍길동',
    phone: '010-1234-5678',
    grade: 'free',
    status: '정상',
    meta,
  } as unknown as Member
}

test('회원 출처 사이트 이름이 $brand 자리에 들어간다', () => {
  const cases: Array<[Record<string, unknown> | null, string]> = [
    [null, '플러스로또'],
    [{}, '플러스로또'],
    [{ source_site: 'pluslotto' }, '플러스로또'],
    [{ source_site: 'lotto815' }, '815로또'],
    [{ source_site: 'infolotto' }, '인포로또'],
    [{ source_site: 'cplotto' }, '일행로또'],
  ]
  for (const [meta, label] of cases) {
    assert.equal(renderSms('[$brand] $name님 안녕하세요', member(meta)), `[${label}] 홍길동님 안녕하세요`)
  }
})

test('알 수 없는 출처·all 이라도 사이트 키가 본문에 새어나가지 않는다', () => {
  for (const source of ['unknown-site', 'all', '   ', 'lotto88']) {
    const body = renderSms('[$brand]', member({ source_site: source }))
    assert.equal(body, '[플러스로또]')
    assert.ok(!body.includes(source.trim() || 'x'))
  }
})

test('overrides 로 $brand 를 덮어쓸 수 있다', () => {
  assert.equal(renderSms('$brand', member({ source_site: 'lotto815' }), { brand: '직접지정' }), '직접지정')
})

test('memberSiteLabel 은 사이트 키가 아닌 한글 이름을 돌려준다', () => {
  assert.equal(memberSiteLabel({ source_site: 'cplotto' }), '일행로또')
  assert.equal(memberSiteLabel(undefined), '플러스로또')
})
