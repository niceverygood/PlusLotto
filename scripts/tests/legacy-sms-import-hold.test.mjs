/**
 * Synthetic data in an in-memory PostgreSQL instance only; no production connection.
 * PGLITE_MODULE=/tmp/pluslotto-site-scope-pgtest/node_modules/@electric-sql/pglite/dist/index.js \
 *   node --test scripts/tests/legacy-sms-import-hold.test.mjs
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const migration = await readFile(new URL('../../supabase/migrations/20260910000100_legacy_sms_import_hold.sql', import.meta.url), 'utf8')
const heldMeta = { source_site: 'lotto815', reco_pause_reason: 'legacy_import_review', reco_paused: true }
let baseline

async function value(sql, params = []) {
  return (await db.query(sql, params)).rows[0].value
}
async function held(phone) {
  return value('SELECT public.sms_is_legacy_import_held($1) AS value', [phone])
}
async function asRole(role) {
  await db.exec('RESET ROLE')
  if (role) await db.exec(`SET ROLE ${role}`)
}
async function insert(id, phone, meta) {
  await db.query('INSERT INTO public.members(id,phone,meta) VALUES ($1,$2,$3)', [id, phone, JSON.stringify(meta)])
}
async function snapshot() {
  return {
    rows: await value('SELECT md5(string_agg(to_jsonb(m)::text, chr(10) ORDER BY id)) AS value FROM public.members m'),
    table: (await db.query("SELECT relrowsecurity,relforcerowsecurity,relacl::text FROM pg_class WHERE oid='public.members'::regclass")).rows,
    policies: (await db.query("SELECT polname,polcmd,polroles::text,pg_get_expr(polqual,polrelid) AS qual,pg_get_expr(polwithcheck,polrelid) AS check FROM pg_policy WHERE polrelid='public.members'::regclass ORDER BY polname")).rows,
  }
}

before(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE ROLE unrelated;
    CREATE TABLE public.members(id text PRIMARY KEY, phone text NOT NULL, meta jsonb);
    CREATE INDEX members_phone_digits_idx ON public.members ((regexp_replace(phone, '\\D', '', 'g')));
    ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own_member ON public.members FOR SELECT TO authenticated USING (id = 'visible');
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, unrelated;
    GRANT SELECT ON public.members TO authenticated, service_role;
    INSERT INTO public.members VALUES ('visible','01000000001','{}');
    INSERT INTO public.members(id,phone,meta)
      SELECT 'filler_' || i, '019' || lpad(i::text,8,'0'), '{}'::jsonb FROM generate_series(1,20000) i;
  `)
  await insert('held', '010-9000-0001', heldMeta)
  baseline = await snapshot()
  await db.exec(migration)
  await db.exec(migration) // Replay must keep the same data, RLS, and role permissions.
})
after(async () => db.close())

test('add-only migration is idempotent and leaves all rows, table grants and RLS unchanged', async () => {
  await asRole()
  assert.deepEqual(await snapshot(), baseline)
  const functions = (await db.query(`SELECT prorettype::regtype::text AS result,prosecdef,provolatile,proconfig
    FROM pg_proc WHERE oid='public.sms_is_legacy_import_held(text)'::regprocedure`)).rows
  assert.equal(functions.length, 1)
  assert.equal(functions[0].result, 'boolean')
  assert.equal(functions[0].prosecdef, false)
  assert.equal(functions[0].provolatile, 's')
  assert.ok(functions[0].proconfig.includes('search_path=""'))
})

test('only service_role can call; authenticated visibility and anonymous table denial are retained', async () => {
  await asRole('service_role')
  assert.equal(await held('01090000001'), true)
  for (const role of ['anon', 'authenticated', 'unrelated']) {
    await asRole(role)
    await assert.rejects(held('01090000001'), { code: '42501' })
  }
  await asRole('authenticated')
  assert.deepEqual((await db.query('SELECT id FROM public.members')).rows, [{ id: 'visible' }])
  await asRole('anon')
  await assert.rejects(db.query('SELECT id FROM public.members'), { code: '42501' })
  await asRole()
  const permissions = (await db.query(`SELECT role,has_function_privilege(role,'public.sms_is_legacy_import_held(text)','EXECUTE') AS allowed
    FROM unnest(ARRAY['anon','authenticated','unrelated','service_role']) AS role`)).rows
  assert.deepEqual(permissions, [
    { role: 'anon', allowed: false }, { role: 'authenticated', allowed: false },
    { role: 'unrelated', allowed: false }, { role: 'service_role', allowed: true },
  ])
})

test('domestic, +82 and 0082 stored/caller formats all address the same recipient', async () => {
  const forms = ['010-9000-0002', '+82 10 9000 0002', '0082-10-9000-0002', '+82 (0)10-9000-0002', '0082 (0)10 9000 0002']
  await asRole()
  await insert('normalization', forms[0], heldMeta)
  for (const stored of forms) {
    await asRole()
    await db.query("UPDATE public.members SET phone=$1 WHERE id='normalization'", [stored])
    await asRole('service_role')
    for (const input of forms) assert.equal(await held(input), true, `${stored} / ${input}`)
    assert.equal(await held('01090000003'), false)
  }
  for (const input of [null, '', '---', '82', '0082', '+1-202-555-0100']) {
    assert.equal(await held(input), false)
  }
})

test('strict source, review reason, and JSON boolean true are all required', async () => {
  const cases = [
    [heldMeta, true],
    [{ ...heldMeta, source_site: 'cplotto' }, true],
    [{ ...heldMeta, source_site: 'infolotto' }, true],
    ...['pluslotto', 'unknown', '', null, 815].map(source_site => [{ ...heldMeta, source_site }, false]),
    ...[false, 'true', 'false', 1, 0, null, {}, []].map(reco_paused => [{ ...heldMeta, reco_paused }, false]),
    ...['manual', '', null, true].map(reco_pause_reason => [{ ...heldMeta, reco_pause_reason }, false]),
    [{ source_site: 'lotto815', reco_paused: true }, false],
    [{ reco_pause_reason: 'legacy_import_review', reco_paused: true }, false],
    [{ source_site: 'lotto815', reco_pause_reason: 'legacy_import_review' }, false],
    [{}, false], [null, false], [[], false], ['bad metadata', false],
  ]
  await asRole()
  await insert('flags', '01090000004', {})
  for (const [meta, expected] of cases) {
    await asRole()
    await db.query("UPDATE public.members SET meta=$1 WHERE id='flags'", [JSON.stringify(meta)])
    await asRole('service_role')
    assert.equal(await held('01090000004'), expected, JSON.stringify(meta))
  }
})

test('any held duplicate wins over ordinary members; boolean false explicitly releases the last hold', async () => {
  await asRole()
  await insert('duplicate_native', '01090000005', {})
  await insert('duplicate_held_1', '+82 10-9000-0005', heldMeta)
  await insert('duplicate_held_2', '0082 10 9000 0005', { ...heldMeta, source_site: 'infolotto' })
  await asRole('service_role')
  assert.equal(await held('01090000005'), true)
  await asRole()
  await db.exec(`UPDATE public.members SET meta=jsonb_set(meta,'{reco_paused}','false') WHERE id='duplicate_held_1'`)
  await asRole('service_role')
  assert.equal(await held('01090000005'), true)
  await asRole()
  await db.exec(`UPDATE public.members SET meta=jsonb_set(meta,'{reco_paused}','false') WHERE id='duplicate_held_2'`)
  await asRole('service_role')
  assert.equal(await held('01090000005'), false)
})

test('invoker uses public.members even with a caller search_path shadow table', async () => {
  await asRole()
  await db.exec(`CREATE SCHEMA decoy; CREATE TABLE decoy.members(phone text,meta jsonb);
    GRANT USAGE ON SCHEMA decoy TO service_role; GRANT SELECT ON decoy.members TO service_role;`)
  await asRole('service_role')
  await db.exec('SET search_path = decoy, public')
  assert.equal(await held('01090000001'), true)
  await db.exec('RESET search_path')
})

test('actual function lookup uses existing phone expression index on a nontrivial member table', async () => {
  await asRole()
  await db.exec('ANALYZE public.members')
  const source = await value("SELECT prosrc AS value FROM pg_proc WHERE oid='public.sms_is_legacy_import_held(text)'::regprocedure")
  const lookup = source.match(/RETURN EXISTS \(([\s\S]*?)\n  \);/)[1]
    .replace('v_phone_representations', '$1::text[]')
  await asRole('service_role')
  const result = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${lookup}`, [
    ['01090000001', '821090000001', '00821090000001', '8201090000001', '008201090000001'],
  ])
  const plan = JSON.stringify(result.rows)
  assert.match(plan, /members_phone_digits_idx/)
  assert.doesNotMatch(plan, /Seq Scan/)
})
