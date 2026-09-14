// Real readonly RPC migration, synthetic PGlite records; no production reads or writes.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const load = (file) => readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8')
const migration = await load('20260914034935_scoped_815_collision_phone_peers.sql')
const id = () => `mem_${randomUUID()}`
const unusedId = id()
const phone = '01000001234'
const forms = [phone, '+82 10 0000 1234', '0082 10 0000 1234', '+82 010 0000 1234', '0082 010 0000 1234']
const fixtures = forms.map((value, i) => ({ id: id(), phone: value,
  meta: i === 0 ? {} : { source_site: ['lotto815', 'infolotto', 'cplotto', 'lotto815'][i - 1], legacy_idx: 100 + i, import_batch: `synthetic-${i}` } }))
const moved = { id: id(), phone: '01099998888', meta: { source_site: 'lotto815', legacy_idx: 200, import_batch: 'synthetic-previous' } }
const unrelated = { id: id(), phone: '01099997777', meta: { source_site: 'pluslotto' } }

async function as(role, action) {
  await db.exec(`SET ROLE ${role}`)
  try { return await action() } finally { await db.exec('RESET ROLE') }
}
async function call(phones = [phone], ids = [unusedId]) {
  return (await db.query('SELECT public.admin_815_collision_phone_peers($1,$2) AS result', [phones, ids])).rows[0].result
}
async function insert(rows) {
  await db.query(`INSERT INTO public.members(id,user_id,name,phone,meta)
    SELECT id,id,'합성 회원',phone,meta FROM jsonb_to_recordset($1) AS r(id text,phone text,meta jsonb)`, [JSON.stringify(rows)])
}
async function snapshot() {
  return (await db.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM members m) AS members,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM payments p) AS payments,
    (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]') FROM logs l) AS logs,
    (SELECT count(*)::int FROM sms_sends) AS sms,
    (SELECT count(*)::int FROM assignments) AS assignments`)).rows[0]
}
function resultFor(row) {
  return { id: row.id, user_id: row.id, phone: row.phone, source_site: row.meta.source_site ?? null,
    legacy_idx: row.meta.legacy_idx == null ? null : String(row.meta.legacy_idx), import_batch: row.meta.import_batch ?? null }
}

before(async () => {
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;`)
  await db.exec(await load('0001_schema.sql'))
  await db.exec(await load('0002_rls.sql'))
  await db.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
    CREATE INDEX members_phone_digits_idx ON public.members((regexp_replace(phone,'\\D','','g')));`)
  await insert([...fixtures, moved, unrelated])
  await db.exec(migration)
})
after(() => db.close())

test('migration is replayable, stable, invoker and service-only without any data change', async () => {
  const previous = await snapshot()
  await db.exec(migration)
  assert.deepEqual(await snapshot(), previous)
  const fn = (await db.query(`SELECT prosecdef,provolatile,proconfig,prorettype::regtype::text AS result_type
    FROM pg_proc WHERE oid='public.admin_815_collision_phone_peers(text[],text[])'::regprocedure`)).rows[0]
  assert.equal(fn.prosecdef, false)
  assert.equal(fn.provolatile, 's')
  assert.equal(fn.result_type, 'jsonb')
  assert.deepEqual(fn.proconfig, ['search_path=""'])
  for (const role of ['anon', 'authenticated']) {
    await as(role, () => assert.rejects(call(), { code: '42501' }))
    assert.equal((await db.query(`SELECT has_function_privilege($1,'public.admin_815_collision_phone_peers(text[],text[])','EXECUTE') AS allowed`, [role])).rows[0].allowed, false)
  }
  await assert.rejects(call(), { code: '42501' }) // Owner execution does not masquerade as service role.
  assert.deepEqual(await snapshot(), previous)
})

test('five phone representations return every site with exact identifier fields, including previous 815', async () => {
  const previous = await snapshot()
  const actual = await as('service_role', () => call())
  assert.deepEqual(actual, fixtures.map(resultFor).sort((a, b) => a.id.localeCompare(b.id)))
  assert.deepEqual(await snapshot(), previous)
})

test('planned IDs expose out-of-cohort phone movement and UNION removes overlapping peers', async () => {
  const actual = await as('service_role', () => call([phone, phone], [moved.id, fixtures[0].id, moved.id]))
  assert.deepEqual(actual, [...fixtures, moved].map(resultFor).sort((a, b) => a.id.localeCompare(b.id)))
  assert.equal(actual.some((r) => r.id === unrelated.id), false)
  await db.query('UPDATE members SET phone=$1 WHERE id=$2', ['01088887777', fixtures[1].id])
  try {
    const movedActual = await as('service_role', () => call([phone], [fixtures[1].id]))
    assert.equal(movedActual.find((r) => r.id === fixtures[1].id).phone, '01088887777')
    assert.equal(movedActual.length, fixtures.length)
  } finally { await db.query('UPDATE members SET phone=$1 WHERE id=$2', [fixtures[1].phone, fixtures[1].id]) }
})

test('new unexpected peer is immediately included; nonexistent valid planned IDs are allowed', async () => {
  assert.deepEqual(await as('service_role', () => call(['01066665555'], [unusedId])), [])
  const added = { id: id(), phone: '010-0000-1234', meta: { source_site: 'new_unreviewed_site' } }
  await insert([added])
  try {
    const actual = await as('service_role', () => call())
    assert.deepEqual(actual, [...fixtures, added].map(resultFor).sort((a, b) => a.id.localeCompare(b.id)))
  } finally { await db.query('DELETE FROM members WHERE id=$1', [added.id]) }
})

test('null, empty, non-domestic, invalid IDs and oversized arrays are rejected without data change', async () => {
  const previous = await snapshot()
  const invalid = [
    [null, [unusedId]], [[phone], null], [[], [unusedId]], [[phone], []],
    [[null], [unusedId]], [[phone], [null]], [['+821000001234'], [unusedId]], [['010-0000-1234'], [unusedId]],
    [['0212345678'], [unusedId]], [['all'], [unusedId]], [['01000001234\n'], [unusedId]],
    [[phone], ['mem_not-a-uuid']], [[phone], ['pay_00000000-0000-0000-0000-000000000000']],
    [Array(2667).fill(phone), [unusedId]], [[phone], Array(2667).fill(unusedId)],
  ]
  for (const [phones, ids] of invalid) await as('service_role', () => assert.rejects(call(phones, ids), { code: '22023' }))
  await as('service_role', () => assert.rejects(db.query(`SELECT public.admin_815_collision_phone_peers(ARRAY[ARRAY[$1]],ARRAY[$2])`, [phone, unusedId]), { code: '22023' }))
  await as('service_role', () => assert.rejects(db.query(`SELECT public.admin_815_collision_phone_peers(p_phones=>ARRAY[$1],p_unknown=>ARRAY[$2])`, [phone, unusedId]), { code: '42883' }))
  const max = await as('service_role', () => call(Array(2666).fill(phone), Array(2666).fill(unusedId)))
  assert.deepEqual(max, fixtures.map(resultFor).sort((a, b) => a.id.localeCompare(b.id)))
  assert.deepEqual(await snapshot(), previous)
})

test('SECURITY INVOKER never elevates missing table SELECT privilege', async () => {
  await db.exec('REVOKE SELECT ON public.members FROM service_role')
  try { await as('service_role', () => assert.rejects(call(), { code: '42501' })) }
  finally { await db.exec('GRANT SELECT ON public.members TO service_role') }
})

test('single JSON array includes more than 1000 peers without clipping', async () => {
  const bulk = Array.from({ length: 1201 }, (_, i) => ({ id: id(), phone: '01055554444', meta: { source_site: i % 2 ? 'lotto815' : 'pluslotto' } }))
  await insert(bulk)
  const previous = await snapshot()
  const actual = await as('service_role', () => call(['01055554444'], [unusedId]))
  assert.equal(actual.length, 1201)
  assert.deepEqual(actual.map((r) => r.id), bulk.map((r) => r.id).sort())
  assert.deepEqual(await snapshot(), previous)
})

test('phone expression and planned ID branches can use their respective existing BTREE indexes', async () => {
  await db.exec('SET enable_seqscan=off')
  try {
    const result = await db.query(`EXPLAIN (FORMAT JSON) WITH wanted AS (
      SELECT id FROM members WHERE regexp_replace(phone,'\\D','','g') = ANY($1::text[])
      UNION SELECT id FROM members WHERE id = ANY($2::text[])
    ) SELECT m.id FROM wanted w JOIN members m ON m.id=w.id`, [[phone, '821000001234'], [moved.id]])
    const text = JSON.stringify(result.rows)
    assert.ok(text.includes('members_phone_digits_idx'), text)
    assert.ok(text.includes('members_pkey'), text)
  } finally { await db.exec('RESET enable_seqscan') }
})
