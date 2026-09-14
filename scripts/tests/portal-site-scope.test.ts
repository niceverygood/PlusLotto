import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PORTAL_SITE, isPortalSourceSite, loadPortalSession, loginPortalMock,
  normalizePortalPhone, PORTAL_SESSION_KEY, PORTAL_SITES, savePortalSession,
  type PortalMemberSession,
} from '../../src/lib/portalScope'

const plus = {
  name: '플러스 테스트', grade: 'free' as const, phone: '01012345678',
  registered_at: '2024-01-01T00:00:00Z',
  meta: { homepage_pw: 'plus-pass', weekly_recos: [{ round_no: 1200, issued_at: '2026-01-01', sets: [[1, 2, 3, 4, 5, 6]] }] },
  is_deleted: false, is_withdrawn: false,
}
const legacy = {
  ...plus, name: '815 테스트', grade: 'vip' as const,
  meta: {
    source_site: 'lotto815', homepage_pw: 'legacy-pass', reco_paused: true,
    reco_pause_reason: 'legacy_import_review', end_date: '2020-01-01',
    weekly_recos: [{ round_no: 1199, issued_at: '2025-12-25', sets: [[7, 8, 9, 10, 11, 12]] }],
  },
}

function storageStub(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

test('site choice defaults to PlusLotto and excludes all-sites lookup', () => {
  assert.equal(DEFAULT_PORTAL_SITE, 'pluslotto')
  assert.deepEqual(PORTAL_SITES.map((site) => site.key), ['pluslotto', 'lotto815', 'infolotto', 'cplotto'])
  for (const site of ['all', 'other', '', null, undefined]) assert.equal(isPortalSourceSite(site), false)
})

test('same phone across sites keeps separate password, grade and recommendation history', () => {
  const a = loginPortalMock([plus, legacy], plus.phone, 'plus-pass', 'pluslotto')!
  const b = loginPortalMock([plus, legacy], plus.phone, 'legacy-pass', 'lotto815')!
  assert.equal(a.name, plus.name)
  assert.equal(a.grade, 'free')
  assert.equal(a.sourceSite, 'pluslotto')
  assert.equal(a.recos[0].round_no, 1200)
  assert.equal(b.name, legacy.name)
  assert.equal(b.grade, 'vip')
  assert.equal(b.sourceSite, 'lotto815')
  assert.equal(b.recos[0].round_no, 1199)
  assert.equal(loginPortalMock([plus, legacy], plus.phone, 'legacy-pass', 'pluslotto'), null)
  assert.equal(loginPortalMock([plus, legacy], plus.phone, 'plus-pass', 'lotto815'), null)
})

test('shared default password cannot select an account from another site', () => {
  const rows = [{ ...plus, meta: {} }, { ...legacy, meta: { source_site: 'lotto815' } }]
  assert.equal(loginPortalMock(rows, plus.phone, '5678', 'pluslotto')?.name, plus.name)
  assert.equal(loginPortalMock(rows, plus.phone, '5678', 'lotto815')?.name, legacy.name)
  assert.equal(loginPortalMock([rows[1]], plus.phone, '5678', 'pluslotto'), null)
})

test('unsupported or missing site never falls back to a phone-only search', () => {
  for (const site of ['all', 'other', '', null, undefined]) {
    assert.equal(loginPortalMock([plus, legacy], plus.phone, 'plus-pass', site), null)
  }
})

test('same-site duplicates fail closed even when only one password matches', () => {
  const duplicate = { ...legacy, meta: { ...legacy.meta, homepage_pw: 'different' } }
  assert.equal(loginPortalMock([legacy, duplicate], plus.phone, 'legacy-pass', 'lotto815'), null)
  assert.equal(loginPortalMock([legacy, duplicate], plus.phone, 'different', 'lotto815'), null)
  assert.equal(loginPortalMock([legacy, duplicate, plus], plus.phone, 'plus-pass', 'pluslotto')?.name, plus.name)
})

test('PlusLotto preserves latest-account selection within its site and never tries an older password', () => {
  const recent = { ...plus, name: '플러스 최근 가입자', registered_at: '2025-01-01T00:00:00Z',
    meta: { homepage_pw: 'recent-pass', weekly_recos: [] } }
  const latestOtherSite = { ...legacy, registered_at: '2026-01-01T00:00:00Z' }
  const rows = [plus, recent, latestOtherSite]
  assert.equal(loginPortalMock(rows, plus.phone, 'recent-pass', 'pluslotto')?.name, recent.name)
  assert.equal(loginPortalMock(rows, plus.phone, 'plus-pass', 'pluslotto'), null)
  assert.equal(loginPortalMock(rows, plus.phone, 'legacy-pass', 'pluslotto'), null)
  assert.equal(loginPortalMock(rows, plus.phone, 'legacy-pass', 'lotto815')?.name, legacy.name)
})

test('deleted and withdrawn accounts cannot log in or create an active-account ambiguity', () => {
  const deleted = { ...legacy, is_deleted: true }
  const withdrawn = { ...legacy, is_withdrawn: true }
  assert.equal(loginPortalMock([deleted, withdrawn], plus.phone, 'legacy-pass', 'lotto815'), null)
  assert.equal(loginPortalMock([deleted, withdrawn, legacy], plus.phone, 'legacy-pass', 'lotto815')?.name, legacy.name)
})

test('sending hold and expired contract do not newly remove read access to existing history', () => {
  assert.equal(loginPortalMock([legacy], plus.phone, 'legacy-pass', 'lotto815')?.recos[0].round_no, 1199)
})

test('phone aliases use the same identity inside the selected site', () => {
  for (const phone of ['010-1234-5678', '+82 10 1234 5678', '0082 10 1234 5678', '+82 010 1234 5678', '0082 010 1234 5678']) {
    assert.equal(normalizePortalPhone(phone), plus.phone)
    assert.equal(loginPortalMock([plus, legacy], phone, 'legacy-pass', 'lotto815')?.phone, plus.phone)
    assert.equal(loginPortalMock([{ ...legacy, phone }], plus.phone, 'legacy-pass', 'lotto815')?.phone, plus.phone)
  }
})

test('legacy unscoped cache is removed and never upgraded to a PlusLotto session', () => {
  const storage = storageStub({ site_member: JSON.stringify({ name: legacy.name, grade: 'vip', phone: plus.phone, recos: [] }) })
  assert.equal(loadPortalSession(storage), null)
  assert.equal(storage.getItem('site_member'), null)
  assert.equal(storage.getItem(PORTAL_SESSION_KEY), null)
})

test('versioned session retains the selected site and logout removes both cache formats', () => {
  const session = loginPortalMock([legacy], plus.phone, 'legacy-pass', 'lotto815')!
  const storage = storageStub({ site_member: '{}' })
  savePortalSession(storage, session)
  assert.deepEqual(loadPortalSession(storage), session)
  assert.equal(storage.getItem('site_member'), null)
  savePortalSession(storage, null)
  assert.equal(loadPortalSession(storage), null)
  assert.equal(storage.getItem(PORTAL_SESSION_KEY), null)
})

test('malformed, unscoped or all-sites v2 cache is not restored', () => {
  for (const raw of ['{', 'null', '[]', JSON.stringify({ name: plus.name, grade: 'free', phone: plus.phone }),
    JSON.stringify({ name: plus.name, grade: 'free', phone: plus.phone, sourceSite: 'all' })]) {
    assert.equal(loadPortalSession(storageStub({ [PORTAL_SESSION_KEY]: raw })), null)
  }
})

test('failed site switch can clear prior data before a new session is saved', () => {
  const storage = storageStub()
  savePortalSession(storage, loginPortalMock([plus], plus.phone, 'plus-pass', 'pluslotto'))
  savePortalSession(storage, null)
  const next = loginPortalMock([legacy], plus.phone, 'wrong', 'lotto815')
  assert.equal(next, null)
  assert.equal(loadPortalSession(storage), null)
  savePortalSession(storage, { ...loginPortalMock([plus], plus.phone, 'plus-pass', 'pluslotto')!, sourceSite: 'all' } as unknown as PortalMemberSession)
  assert.equal(loadPortalSession(storage), null)
})
