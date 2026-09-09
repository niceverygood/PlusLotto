import test from 'node:test'
import assert from 'node:assert/strict'
import { isSiteScope, matchesSiteScope, memberSite, rpcSourceSite, SITE_SCOPES } from '../../src/lib/siteScope.ts'

test('기존 출처 없는 회원과 명시된 플러스로또 회원을 같은 사이트로 취급한다', () => {
  for (const meta of [undefined, null, {}, { source_site: '' }, { source_site: 'pluslotto' }]) {
    assert.equal(memberSite(meta), 'pluslotto')
    assert.equal(matchesSiteScope(meta, 'pluslotto'), true)
    assert.equal(matchesSiteScope(meta, 'lotto815'), false)
  }
})

test('같은 전화번호여도 사이트 선택은 회원의 출처만 따른다', () => {
  const members = [
    { phone: '01000000000', meta: {} },
    { phone: '01000000000', meta: { source_site: 'lotto815' } },
    { phone: '01000000000', meta: { source_site: 'infolotto' } },
  ]
  assert.equal(members.filter((m) => matchesSiteScope(m.meta, 'all')).length, 3)
  for (const site of ['pluslotto', 'lotto815', 'infolotto'] as const) {
    assert.equal(members.filter((m) => matchesSiteScope(m.meta, site)).length, 1)
  }
})

test('알 수 없는 출처를 플러스로또로 섞지 않고 전체에서만 조회한다', () => {
  assert.equal(matchesSiteScope({ source_site: 'unknown-site' }, 'pluslotto'), false)
  assert.equal(matchesSiteScope({ source_site: 'unknown-site' }, 'all'), true)
})

test('허용된 사이트만 선택할 수 있고 전체는 하위호환 RPC null을 사용한다', () => {
  for (const site of SITE_SCOPES) assert.equal(isSiteScope(site.key), true)
  for (const value of ['lotto88', 'premium', '"),true', '', null, 1]) assert.equal(isSiteScope(value), false)
  assert.equal(rpcSourceSite('all'), null)
  assert.equal(rpcSourceSite('lotto815'), 'lotto815')
  assert.equal(rpcSourceSite('pluslotto'), 'pluslotto')
})
