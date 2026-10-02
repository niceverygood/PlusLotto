import assert from 'node:assert/strict'
import test from 'node:test'
import { CUSTOMER_SITES, customerSiteTiers, resolveCustomerSite } from '../../src/lib/customerSites'
import { loadPortalSession, PORTAL_SESSION_KEY, savePortalSession } from '../../src/lib/portalScope'
import { membershipTermsPath, membershipTermsSourceSite } from '../../src/lib/membership'

test('only the four supplied domains select an imported customer site', () => {
  const expected = [
    ['815korean.co.kr', 'lotto815'], ['infolotto.co.kr', 'infolotto'],
    ['ilhanglotto.co.kr', 'cplotto'], ['premiumlotto.co.kr', 'best'],
  ]
  for (const [host, key] of expected) {
    assert.equal(resolveCustomerSite(host, '플러스로또')?.key, key)
    assert.equal(resolveCustomerSite(`WWW.${host.toUpperCase()}.`, '플러스로또')?.key, key)
    for (const invalid of [`admin.${host}`, `${host}.other.test`, `evil${host}`]) {
      assert.equal(resolveCustomerSite(invalid, '플러스로또'), null)
    }
  }
  for (const host of ['localhost', 'lotto-plus.co.kr', '88lotto.co.kr', 'preview.vercel.app']) {
    assert.equal(resolveCustomerSite(host, '플러스로또'), null)
  }
})

test('a separate 88 deployment never adopts the PlusLotto tenant allowlist', () => {
  for (const site of CUSTOMER_SITES) {
    assert.equal(resolveCustomerSite(site.hostname, '88로또'), null)
    assert.equal(resolveCustomerSite(`${site.key}.localhost`, '88로또', true), null)
  }
})

test('local site previews require an explicit development flag', () => {
  assert.equal(resolveCustomerSite('best.localhost', '플러스로또'), null)
  assert.equal(resolveCustomerSite('best.localhost', '플러스로또', true)?.key, 'best')
})

test('provided packages keep total prices, periods and sold-out status without borrowed terms or benefits', () => {
  const expected = {
    lotto815: ['399,900원', '4,690,000원', '1661-5333'],
    infolotto: ['431,900원', '3,800,000원', '1833-6755'],
    cplotto: ['490,000원', '3,300,000원', '1661-9414'],
    best: ['431,900원', '6,160,000원', '1833-2090'],
  }
  for (const site of CUSTOMER_SITES) {
    assert.deepEqual(site.plans.slice(0, 2).map((p) => p.price), expected[site.key].slice(0, 2))
    assert.equal(site.business.support_phone, expected[site.key][2])
    assert.equal(site.plans[0].period, '1년+서비스6개월')
    assert.equal(site.plans[1].period, '1년+서비스2년')
    assert.equal(site.plans[2].soldOut, true)
    for (const tier of customerSiteTiers(site)) {
      assert.equal(tier.terms, '')
      assert.equal(tier.weekly_sets, '')
      assert.deepEqual(tier.highlights, [])
    }
  }
})

test('host scope rejects and removes another site cached session while manual login stays compatible', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const session = { sourceSite: 'best' as const, phone: '01000000000', name: '테스트', grade: 'vip' as const, recos: [] }
  savePortalSession(storage, session)
  assert.deepEqual(loadPortalSession(storage), session)
  assert.deepEqual(loadPortalSession(storage, 'best'), session)
  assert.equal(loadPortalSession(storage, 'lotto815'), null)
  assert.equal(storage.getItem(PORTAL_SESSION_KEY), null)
})

test('shared terms links carry the contract site while unscoped Plus links stay unchanged', () => {
  assert.equal(membershipTermsPath('vip'), '/terms/vip')
  assert.equal(membershipTermsPath('vip', { source_site: 'pluslotto' }), '/terms/vip')
  for (const site of CUSTOMER_SITES) {
    assert.equal(membershipTermsPath('vip', { source_site: site.key }), `/terms/vip?site=${site.key}`)
    assert.equal(membershipTermsSourceSite(null, site.key), site.key)
    assert.equal(membershipTermsSourceSite(site.key, 'pluslotto'), site.key)
  }
  assert.equal(membershipTermsSourceSite(null, null), 'pluslotto')
  assert.equal(membershipTermsSourceSite(null, 'all'), null)
  assert.equal(membershipTermsSourceSite(null, 'unknown'), null)
  assert.equal(membershipTermsPath('vip', { source_site: 'unknown' }), '/terms/vip?site=unknown')
  assert.equal(membershipTermsPath('vip', { source_site: 'x&site=pluslotto' }), '/terms/vip?site=x%26site%3Dpluslotto')
})
