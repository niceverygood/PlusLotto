// 이관 사이트 목록은 한 곳에 못 두고 다섯 군데에 흩어져 있다.
//
//   src/lib/legacySites.ts   LEGACY_SITES        (UI 라벨 + 보류 판정의 출처)
//   src/lib/siteScope.ts     SITE_SCOPES         (사이트 선택 · $brand 이름 · 회원 필터)
//   src/lib/legacyImportHold.ts                   (legacySites 를 import — 복제본 없음)
//   api/send-sms.ts          MEMBER_SITES/LEGACY_SITES (Vercel 함수는 src import 불가 → 복제)
//   supabase/migrations/…    sms_is_legacy_import_held 의 IN 목록 (DB 최종 게이트)
//
// 사이트를 추가할 때 한 곳이라도 빠지면 조용히 어긋난다. 실제 결과는:
//   · siteScope 누락 → 그 사이트 회원 문자의 $brand 가 "플러스로또"로 나간다(남의 브랜드 발송)
//   · send-sms 누락 → 검수 전 회원에게 문자가 나가고, 사이트 발신번호도 안 잡힌다
//   · SQL 누락 → 서버 최종 보류 게이트가 그 사이트를 통과시킨다
// 그래서 목록 일치를 테스트로 강제한다.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import { LEGACY_SITES, LEGACY_SITE_KEYS } from '../../src/lib/legacySites.ts'
import { SITE_SCOPES } from '../../src/lib/siteScope.ts'

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

/** `new Set([...])` / `IN (...)` 안의 작은따옴표 문자열을 뽑는다. */
function quoted(block: string): string[] {
  return [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

function setLiteral(source: string, name: string): string[] {
  const m = source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`))
  assert.ok(m, `${name} 선언을 찾지 못했다`)
  return quoted(m[1])
}

const legacyKeys = LEGACY_SITES.map((s) => s.key)

test('이관 사이트 목록에 88로또가 들어 있다', () => {
  assert.ok(legacyKeys.includes('lotto88'), 'legacySites 에 lotto88 이 있어야 한다')
  assert.ok(
    SITE_SCOPES.some((s) => s.key === 'lotto88'),
    'siteScope 에 lotto88 이 있어야 $brand 가 "88로또"로 나간다',
  )
})

test('이관 사이트는 모두 사이트 선택 목록에도 있어야 한다 — 없으면 $brand 가 남의 브랜드로 나간다', () => {
  const scopeKeys = new Set(SITE_SCOPES.map((s) => s.key))
  for (const key of legacyKeys) {
    assert.ok(scopeKeys.has(key), `siteScope 에 ${key} 가 빠졌다`)
  }
})

test('api/send-sms.ts 의 복제 목록이 legacySites 와 일치한다', () => {
  const src = read('api/send-sms.ts')
  const legacy = setLiteral(src, 'LEGACY_SITES')
  const members = setLiteral(src, 'MEMBER_SITES')

  assert.deepEqual([...legacy].sort(), [...legacyKeys].sort(), 'LEGACY_SITES 가 어긋났다')
  // MEMBER_SITES = 이관 사이트 + 플러스로또(기존 회원).
  assert.deepEqual([...members].sort(), [...legacyKeys, 'pluslotto'].sort(), 'MEMBER_SITES 가 어긋났다')
})

test('DB 보류 게이트(sms_is_legacy_import_held)의 사이트 목록이 일치한다', () => {
  // 가장 나중에 적용되는 정의가 실제로 동작하는 정의다.
  const dir = new URL('../../supabase/migrations/', import.meta.url)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => readFileSync(new URL(f, dir), 'utf8').includes('FUNCTION public.sms_is_legacy_import_held'))
  assert.ok(files.length > 0, '보류 게이트 함수 정의를 찾지 못했다')

  const latest = readFileSync(new URL(files[files.length - 1], dir), 'utf8')
  const m = latest.match(/source_site'\s*IN\s*\(([^)]*)\)/)
  assert.ok(m, `${files[files.length - 1]} 에서 사이트 목록을 찾지 못했다`)
  assert.deepEqual([...quoted(m[1])].sort(), [...legacyKeys].sort(), 'SQL 게이트 목록이 어긋났다')
})

test('legacyImportHold 는 목록을 따로 두지 않고 legacySites 를 쓴다', () => {
  const src = read('src/lib/legacyImportHold.ts')
  assert.ok(src.includes('LEGACY_SITE_KEYS'), 'legacySites 의 집합을 써야 한다')
  assert.ok(!/new Set\(\[\s*'/.test(src), '자체 사이트 목록 복제본이 남아 있다')
  assert.equal(LEGACY_SITE_KEYS.size, legacyKeys.length)
  for (const key of legacyKeys) assert.ok(LEGACY_SITE_KEYS.has(key))
})

test('사이트별 발신번호 설정이 이관 사이트를 모두 다룬다', () => {
  const db = read('src/types/db.ts')
  const m = db.match(/by_site\?: Partial<Record<([^>]*),\s*SiteSmsSettings>>/)
  assert.ok(m, 'by_site 타입을 찾지 못했다')
  const keys = [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])
  assert.deepEqual([...keys].sort(), [...legacyKeys].sort(), 'by_site 키가 이관 사이트와 어긋났다')

  // 설정 화면에도 입력칸이 있어야 한다 — 없으면 발신번호를 넣을 방법이 없어 발송이 막힌다.
  const page = read('src/features/settings/SiteSettingsPage.tsx')
  for (const key of legacyKeys) {
    assert.ok(page.includes(`sender_${key}`), `설정 화면에 ${key} 발신번호 입력칸이 없다`)
  }
})

test('88로또는 전환 전까지 사이트 선택 드롭다운에서만 감춰진다', () => {
  // 목록에서 빼는 게 아니라 노출만 막는다. 전환일(10/5)에 PENDING_SITE_SCOPES 를 비운다.
  const src = read('src/lib/siteScope.ts')
  assert.ok(src.includes("PENDING_SITE_SCOPES"), 'PENDING_SITE_SCOPES 가 있어야 한다')
  assert.ok(src.includes('SELECTABLE_SITE_SCOPES'), 'SELECTABLE_SITE_SCOPES 가 있어야 한다')
  const shell = read('src/app/AppShell.tsx')
  assert.ok(shell.includes('SELECTABLE_SITE_SCOPES'), '드롭다운은 SELECTABLE_SITE_SCOPES 를 써야 한다')
  // SELECTABLE_SITE_SCOPES.map 이 SITE_SCOPES.map 을 부분 문자열로 포함하므로 앞 글자를 제외한다.
  assert.ok(!/(?<![A-Z_])SITE_SCOPES\.map/.test(shell), '드롭다운이 전체 목록을 그대로 쓰고 있다')
})
