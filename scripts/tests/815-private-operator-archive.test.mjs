// Synthetic in-memory PostgreSQL only. No credentials, network, or customer rows.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const migration = await readFile(new URL('../../supabase/migrations/20260914052432_private_legacy815_operator_archive.sql', import.meta.url), 'utf8')
const tables = ['members','payments','assignments','legacy_member_memos','legacy_member_sms','legacy_member_wins']
async function as(role, fn) {
  await db.exec(`SET ROLE ${role}`)
  try { return await fn() } finally { await db.exec('RESET ROLE') }
}
async function snapshot() {
  const result = {}
  for(const table of tables)
    result[table] = (await db.query(`SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text) AS hash FROM public.${table} t`)).rows[0].hash
  return result
}
async function archiveRow(overrides={}) {
  const row = {run_id:'synthetic-review',source_table:'members',record_key:'operator',member_id:'operator',row_data:{id:'operator',meta:{original:true}},...overrides}
  await db.query(`INSERT INTO private.legacy815_operator_archive (run_id,source_table,record_key,member_id,row_data,row_md5)
    VALUES ($1,$2,$3,$4,$5::jsonb,coalesce($6,md5(($5::jsonb)::text)))`,
    [row.run_id,row.source_table,row.record_key,row.member_id,JSON.stringify(row.row_data),overrides.row_md5 ?? null])
}
before(async()=>{
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE unrelated;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon,authenticated,service_role;
    CREATE TABLE members(id text PRIMARY KEY,name text,phone text,meta jsonb);
    CREATE TABLE payments(id text PRIMARY KEY,member_id text REFERENCES members(id),amount numeric,paid_at timestamptz);
    CREATE TABLE assignments(id text PRIMARY KEY,member_id text REFERENCES members(id),staff_id text);
    CREATE TABLE legacy_member_memos(source_site text,legacy_idx bigint,member_id text REFERENCES members(id),body text,PRIMARY KEY(source_site,legacy_idx));
    CREATE TABLE legacy_member_sms(source_site text,legacy_idx bigint,member_id text REFERENCES members(id),body text,PRIMARY KEY(source_site,legacy_idx));
    CREATE TABLE legacy_member_wins(source_site text,legacy_idx bigint,round_no integer,member_id text REFERENCES members(id),numbers integer[],PRIMARY KEY(source_site,legacy_idx,round_no));
    ALTER TABLE members ENABLE ROW LEVEL SECURITY;
    CREATE POLICY members_read ON members FOR SELECT TO authenticated USING (true);
    INSERT INTO members VALUES ('operator','synthetic operator',NULL,'{"source_site":"lotto815","reco_paused":true,"nullable":null,"nested":{"v":[1,"2",false]}}'),('native','synthetic customer','01000000000','{}');
    INSERT INTO payments VALUES ('p1','operator',12345.67,'2026-08-31T18:02:03+09:00');
    INSERT INTO assignments VALUES ('a1','operator','staff-admin');
    INSERT INTO legacy_member_memos VALUES ('lotto815',9007199254740993,'operator',E'synthetic\\n메모');
    INSERT INTO legacy_member_sms VALUES ('lotto815',9007199254740994,'operator',NULL);
    INSERT INTO legacy_member_wins VALUES ('lotto815',9007199254740995,1242,'operator',ARRAY[1,2,3,4,5,6]);`)
})
after(()=>db.close())
test('migration creates an empty private archive without changing members or public objects',async()=>{
  const rows = await snapshot()
  const before = (await db.query("SELECT relacl::text,relrowsecurity FROM pg_class WHERE oid='public.members'::regclass")).rows
  const policies = (await db.query("SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='members'")).rows
  const functions = (await db.query("SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows
  await db.exec(migration)
  assert.deepEqual(await snapshot(),rows)
  assert.deepEqual((await db.query("SELECT relacl::text,relrowsecurity FROM pg_class WHERE oid='public.members'::regclass")).rows,before)
  assert.deepEqual((await db.query("SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='members'")).rows,policies)
  assert.deepEqual((await db.query("SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows,functions)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM private.legacy815_operator_archive')).rows[0].n,0)
  assert.deepEqual((await db.query("SELECT relrowsecurity,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='private.legacy815_operator_archive'::regclass")).rows,[{relrowsecurity:true,owner:'postgres'}])
  assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='private' AND tablename='legacy815_operator_archive'")).rows[0].n,0)
})
test('anon, authenticated, service role with BYPASSRLS, and PUBLIC inheritors cannot access the archive',async()=>{
  for(const role of ['anon','authenticated','service_role','unrelated']) {
    const privileges = (await db.query(`SELECT has_schema_privilege($1,'private','USAGE') AS schema_usage,
      has_schema_privilege($1,'private','CREATE') AS schema_create,
      has_table_privilege($1,'private.legacy815_operator_archive','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_access`,[role])).rows[0]
    assert.deepEqual(privileges,{schema_usage:false,schema_create:false,table_access:false})
    await as(role,async()=>{
      await assert.rejects(db.query('SELECT * FROM private.legacy815_operator_archive'),{code:'42501'})
      await assert.rejects(archiveRow(),{code:'42501'})
      for(const sql of ["UPDATE private.legacy815_operator_archive SET run_id='changed'",'DELETE FROM private.legacy815_operator_archive','TRUNCATE private.legacy815_operator_archive'])
        await assert.rejects(db.exec(sql),{code:'42501'})
      await assert.rejects(db.exec('CREATE TABLE private.cannot_create(id text)'),{code:'42501'})
    })
  }
})
test('only whitelisted tables and exact object digests are stored; keys prevent a second copy',async()=>{
  for(const overrides of [{source_table:'sms_sends'},{run_id:' '},{record_key:''},{member_id:''},{row_data:[]},{row_data:null},{row_data:'text'},{row_md5:'a'.repeat(32)},{row_md5:'invalid'}])
    await assert.rejects(archiveRow(overrides),{code:'23514'})
  await archiveRow()
  await assert.rejects(archiveRow(),{code:'23505'})
  const row=(await db.query("SELECT row_md5=md5(row_data::text) AS digest_matches,archived_at IS NOT NULL AS has_time FROM private.legacy815_operator_archive WHERE run_id='synthetic-review'")).rows[0]
  assert.deepEqual(row,{digest_matches:true,has_time:true})
  await assert.rejects(db.exec("UPDATE private.legacy815_operator_archive SET row_data=row_data||'{\"changed\":true}' WHERE run_id='synthetic-review'"),{code:'23514'})
})
test('Postgres can archive and restore all six source tables with exact JSON and FK order',async()=>{
  const before = await snapshot()
  await db.exec('BEGIN')
  try {
    for(const table of tables) {
      const member = table==='members'?'t.id':'t.member_id'
      const key = table==='legacy_member_wins'?"concat(t.source_site,':',t.legacy_idx,':',t.round_no)":table.startsWith('legacy_')?"concat(t.source_site,':',t.legacy_idx)":'t.id'
      await db.exec(`INSERT INTO private.legacy815_operator_archive (run_id,source_table,record_key,member_id,row_data,row_md5)
        SELECT 'restore-trial','${table}',${key},${member},to_jsonb(t),md5(to_jsonb(t)::text) FROM public.${table} t WHERE ${member}='operator'`)
    }
    assert.equal((await db.query("SELECT count(*)::int AS n FROM private.legacy815_operator_archive WHERE run_id='restore-trial' AND row_md5=md5(row_data::text)")).rows[0].n,6)
    for(const table of [...tables].reverse()) await db.exec(`DELETE FROM public.${table} WHERE ${table==='members'?'id':'member_id'}='operator'`)
    assert.deepEqual((await db.query('SELECT id FROM public.members')).rows,[{id:'native'}])
    for(const table of tables)
      await db.exec(`INSERT INTO public.${table} SELECT (jsonb_populate_record(NULL::public.${table},row_data)).*
        FROM private.legacy815_operator_archive WHERE run_id='restore-trial' AND source_table='${table}'`)
    assert.deepEqual(await snapshot(),before)
    for(const table of tables) {
      const member = table==='members'?'t.id':'t.member_id'
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.${table} t JOIN private.legacy815_operator_archive a
        ON a.run_id='restore-trial' AND a.source_table='${table}' AND a.member_id=${member}
        WHERE to_jsonb(t)=a.row_data AND md5(to_jsonb(t)::text)=a.row_md5`)).rows[0].n,1)
    }
  } finally { await db.exec('ROLLBACK') }
  assert.deepEqual(await snapshot(),before)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM private.legacy815_operator_archive WHERE run_id='restore-trial'")).rows[0].n,0)
})
