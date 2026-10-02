/**
 * 88로또(lotto88) 사이트 등록 회귀. 합성 데이터만 쓰는 인메모리 PostgreSQL — 운영 접속 없음.
 * PGLITE_MODULE=/tmp/pluslotto-site-scope-pgtest/node_modules/@electric-sql/pglite/dist/index.js \
 *   node --test scripts/tests/lotto88-legacy-site.test.mjs
 *
 * 10/12 이관 후 88 회원은 source_site='lotto88' 이다. 서버 보류 목록에 없으면 검수 중인
 * 회원에게 문자가 그대로 나간다. best 마이그레이션 위에 올라가는 순서도 함께 확인한다.
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
  `)
  await db.exec(await read('20260910000100_legacy_sms_import_hold.sql'))
  await db.exec(await read('20260929020000_best_legacy_site.sql'))
  // 운영 순서 그대로: 프리미엄 이력 제약 검증(main, 9/30)까지 끝난 뒤에 88 이 올라간다.
  await db.exec(await read('20260930075715_validate_best_history_source_sites.sql'))

  await insert('before', '01011110001', hold('lotto88'))
  assert.equal(await held('01011110001'), false, '적용 전에는 lotto88 이 보류되지 않아야 한다')

  await db.exec(await read('20261002010000_lotto88_legacy_site.sql'))
  await db.exec(await read('20261002010100_validate_lotto88_history_source_sites.sql'))
})

after(async () => { await db.close() })

test('88 이관 회원의 문자는 검수 중 서버에서 보류된다', async () => {
  await insert('88-held', '01022220001', hold('lotto88'))
  assert.equal(await held('01022220001'), true)
})

test('앞서 등록한 사이트들의 보류는 그대로다', async () => {
  for (const [index, site] of ['lotto815', 'cplotto', 'infolotto', 'best'].entries()) {
    const phone = `0103333000${index + 1}`
    await insert(`prev-${site}`, phone, hold(site))
    assert.equal(await held(phone), true, site)
  }
})

test('검수 후 해제한 88 회원은 막지 않는다', async () => {
  await insert('88-released', '01044440001',
    { source_site: 'lotto88', reco_pause_reason: 'legacy_import_review', reco_paused: false })
  assert.equal(await held('01044440001'), false)
})

test('회원 이력 테이블이 88 출처를 받고 모르는 출처는 거부한다', async () => {
  for (const table of ['legacy_member_memos', 'legacy_member_sms', 'legacy_member_wins']) {
    await db.query(`INSERT INTO public.${table}(id, source_site) VALUES ($1, 'lotto88')`, [`${table}-88`])
    await db.query(`INSERT INTO public.${table}(id, source_site) VALUES ($1, 'best')`, [`${table}-best`])
    await assert.rejects(
      () => db.query(`INSERT INTO public.${table}(id, source_site) VALUES ($1, 'unknown_site')`, [`${table}-bad`]))
  }
})

test('88 등록 후에도 이력 제약이 검증 완료 상태로 남는다', async () => {
  const rows = (await db.query(`SELECT conname, convalidated FROM pg_constraint
    WHERE conname LIKE 'legacy_member_%_source_site_check' ORDER BY conname`)).rows
  assert.equal(rows.length, 3)
  for (const row of rows) assert.equal(row.convalidated, true, row.conname)
})

test('두 번 적용해도 결과가 같다', async () => {
  await db.exec(await read('20261002010000_lotto88_legacy_site.sql'))
  await insert('88-again', '01077770001', hold('lotto88'))
  assert.equal(await held('01077770001'), true)
})

test('재적용해도 이전상품 라벨 목록에 lotto88 이 중복으로 붙지 않는다', async () => {
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.legacy_label_probe(s text) RETURNS boolean LANGUAGE sql AS
    $f$ SELECT s in ('lotto815','cplotto','infolotto','best') $f$;
  `)
  for (let i = 0; i < 3; i += 1) await db.exec(await read('20261002010000_lotto88_legacy_site.sql'))
  const def = (await db.query(
    "SELECT pg_get_functiondef('public.legacy_label_probe(text)'::regprocedure) AS d")).rows[0].d
  assert.equal(def.split("'lotto88'").length - 1, 1, def)
})
