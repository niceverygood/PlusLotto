/**
 * 프리미엄로또(best) 사이트 등록 회귀. 합성 데이터만 쓰는 인메모리 PostgreSQL — 운영 접속 없음.
 * PGLITE_MODULE=/tmp/pluslotto-site-scope-pgtest/node_modules/@electric-sql/pglite/dist/index.js \
 *   node --test scripts/tests/best-legacy-site.test.mjs
 *
 * 가장 중요한 회귀는 **이관 직후 프리미엄 회원의 문자가 서버에서 막히는가**이다.
 * 화면(src/lib/legacyImportHold.ts)이 막아도 최종 차단은 서버 몫이라, 여기가 빠지면
 * 검수 전인 8,740명에게 조합문자가 그대로 나간다. 화면상으로는 정상으로 보인다.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const read = (name) => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')

const hold = (site) => ({ source_site: site, reco_pause_reason: 'legacy_import_review', reco_paused: true })

async function held(phone) {
  return (await db.query('SELECT public.sms_is_legacy_import_held($1) AS v', [phone])).rows[0].v
}
async function insert(id, phone, meta) {
  await db.query('INSERT INTO public.members(id,phone,meta) VALUES ($1,$2,$3)', [id, phone, JSON.stringify(meta)])
}

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.members(id text PRIMARY KEY, phone text NOT NULL, meta jsonb);
    CREATE INDEX members_phone_digits_idx ON public.members ((regexp_replace(phone, '\\D', '', 'g')));
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT SELECT ON public.members TO authenticated, service_role;
    CREATE TABLE public.legacy_member_memos(id text PRIMARY KEY, source_site text NOT NULL);
    CREATE TABLE public.legacy_member_sms(id text PRIMARY KEY, source_site text NOT NULL);
    CREATE TABLE public.legacy_member_wins(id text PRIMARY KEY, source_site text NOT NULL);
    ALTER TABLE public.legacy_member_memos
      ADD CONSTRAINT legacy_member_memos_source_site_check
      CHECK (source_site IN ('lotto815','cplotto','infolotto')) NOT VALID;
    ALTER TABLE public.legacy_member_sms
      ADD CONSTRAINT legacy_member_sms_source_site_check
      CHECK (source_site IN ('lotto815','cplotto','infolotto')) NOT VALID;
    ALTER TABLE public.legacy_member_wins
      ADD CONSTRAINT legacy_member_wins_source_site_check
      CHECK (source_site IN ('lotto815','cplotto','infolotto')) NOT VALID;
  `)
  await db.exec(await read('20260910000100_legacy_sms_import_hold.sql'))

  // 마이그레이션 적용 전에는 프리미엄이 막히지 않는 것이 정상이다 — 이 테스트가 무엇을
  // 증명하는지 분명히 해두기 위해 먼저 확인한다.
  await insert('before', '01011110001', hold('best'))
  assert.equal(await held('01011110001'), false, '적용 전에는 best 가 보류되지 않아야 한다')

  await db.exec(await read('20260929020000_best_legacy_site.sql'))
})

after(async () => { await db.close() })

test('프리미엄 이관 회원의 문자는 서버에서 보류된다', async () => {
  await insert('best-held', '01022220001', hold('best'))
  assert.equal(await held('01022220001'), true)
})

test('기존 세 사이트의 보류는 그대로다', async () => {
  for (const [index, site] of ['lotto815', 'cplotto', 'infolotto'].entries()) {
    const phone = `0103333000${index + 1}`
    await insert(`old-${site}`, phone, hold(site))
    assert.equal(await held(phone), true, site)
  }
})

test('프리미엄이라도 보류 사유가 아니면 막지 않는다', async () => {
  // 운영자가 검수를 마치고 해제한 회원까지 계속 막으면 문자가 영영 안 나간다.
  await insert('best-released', '01044440001',
    { source_site: 'best', reco_pause_reason: 'legacy_import_review', reco_paused: false })
  assert.equal(await held('01044440001'), false)
  await insert('best-other-pause', '01044440002',
    { source_site: 'best', reco_pause_reason: '고객요청', reco_paused: true })
  assert.equal(await held('01044440002'), false)
})

test('이관 사이트가 아닌 회원은 영향이 없다', async () => {
  await insert('plus', '01055550001', hold('pluslotto'))
  assert.equal(await held('01055550001'), false)
})

test('+82 표기로 와도 프리미엄 보류가 걸린다', async () => {
  await insert('best-intl', '01066660001', hold('best'))
  for (const phone of ['+821066660001', '00821066660001', '01066660001']) {
    assert.equal(await held(phone), true, phone)
  }
})

test('회원 이력 테이블이 프리미엄 출처를 받는다', async () => {
  for (const table of ['legacy_member_memos', 'legacy_member_sms', 'legacy_member_wins']) {
    await db.query(`INSERT INTO public.${table}(id, source_site) VALUES ($1, 'best')`, [`${table}-best`])
    await assert.rejects(
      () => db.query(`INSERT INTO public.${table}(id, source_site) VALUES ($1, 'unknown_site')`, [`${table}-bad`]),
      `${table} 은 모르는 출처를 여전히 거부해야 한다`)
  }
})

test('두 번 적용해도 결과가 같다', async () => {
  await db.exec(await read('20260929020000_best_legacy_site.sql'))
  await insert('best-again', '01077770001', hold('best'))
  assert.equal(await held('01077770001'), true)
})
