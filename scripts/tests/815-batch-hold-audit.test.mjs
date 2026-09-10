// In-memory synthetic PostgreSQL only. No credentials, network, or customer data.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const load = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const migration = await load('20260910120000_815_batch_hold_audit.sql')
const held = {source_site:'lotto815',import_batch:'lotto815-local-audit',reco_paused:true,
  reco_pause_reason:'legacy_import_review',legacy_consent_review_required:true}
async function call(batch='lotto815-local-audit') {
  return (await db.query('SELECT public.admin_verify_815_batch_holds($1) AS result',[batch])).rows[0].result
}
async function snapshot() {
  return (await db.query('SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),\'[]\') AS rows FROM public.members m')).rows[0].rows
}
async function row(id,phone,meta) {
  await db.query('INSERT INTO public.members VALUES ($1,$2,$3)',[id,phone,JSON.stringify(meta)])
}
before(async()=>{
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE members(id text PRIMARY KEY,phone text NOT NULL,meta jsonb);
    ALTER TABLE members ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
    GRANT SELECT ON members TO service_role;
    CREATE INDEX members_phone_digits_idx ON members ((regexp_replace(phone,'\\D','','g')));`)
  await db.exec(await load('20260910000100_legacy_sms_import_hold.sql'))
  await row('held','01090000001',held)
  await row('native','01090000002',{})
  await row('other-site','01090000003',{...held,source_site:'infolotto'})
  await row('other-batch','01090000004',{...held,import_batch:'lotto815-local-other'})
})
after(()=>db.close())
test('migration and replay keep rows and member grants/RLS unchanged',async()=>{
  const before = await snapshot()
  const grants = (await db.query("SELECT relacl::text,relrowsecurity FROM pg_class WHERE oid='members'::regclass")).rows
  await db.exec(migration); await db.exec(migration)
  assert.deepEqual(await snapshot(),before)
  assert.deepEqual((await db.query("SELECT relacl::text,relrowsecurity FROM pg_class WHERE oid='members'::regclass")).rows,grants)
  const f=(await db.query("SELECT prosecdef,provolatile,proconfig,md5(prosrc) AS md5 FROM pg_proc WHERE oid='public.admin_verify_815_batch_holds(text)'::regprocedure")).rows[0]
  assert.equal(f.prosecdef,false); assert.equal(f.provolatile,'s'); assert.ok(f.proconfig.includes('search_path=""'))
})
test('service role only and exact batch/site isolation',async()=>{
  for(const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`)
    await assert.rejects(call(),{code:'42501'})
    await db.exec('RESET ROLE')
  }
  await db.exec('SET ROLE service_role')
  assert.deepEqual(await call(),{batch_id:'lotto815-local-audit',members:1,held_metadata_members:1,held_rpc_members:1,consent_review_members:1})
  await db.exec('RESET ROLE')
})
test('empty batch is observed as zero and invalid requests fail',async()=>{
  assert.deepEqual(await call('lotto815-missing'),{batch_id:'lotto815-missing',members:0,held_metadata_members:0,held_rpc_members:0,consent_review_members:0})
  for(const value of [null,'','other-site','lotto815-','lotto815-A','lotto815-a\n','lotto815-'+ 'x'.repeat(97)])
    await assert.rejects(call(value),{code:'22023'})
})
test('string true does not count as boolean hold or consent',async()=>{
  await row('string','01090000005',{...held,reco_paused:'true',legacy_consent_review_required:'true'})
  const r=await call()
  assert.equal(r.members,2); assert.equal(r.held_metadata_members,1); assert.equal(r.held_rpc_members,1); assert.equal(r.consent_review_members,1)
})
test('international telephone lookup is preserved and RPC mismatches remain visible',async()=>{
  await row('intl','+82 (0)10-9000-0006',{...held})
  await row('foreign-held','01090000007',{...held,source_site:'infolotto'})
  await row('same-recipient','0082 10 9000 0007',{...held,reco_paused:false})
  const r=await call()
  assert.equal(r.members,4); assert.equal(r.held_metadata_members,2); assert.equal(r.held_rpc_members,3); assert.equal(r.consent_review_members,3)
})
test('500-member boundary and read-only transaction are respected',async()=>{
  await db.query(`INSERT INTO members SELECT 'bulk-'||i,'0108'||lpad(i::text,7,'0'),$1::jsonb FROM generate_series(1,500)i`,
    [JSON.stringify({...held,import_batch:'lotto815-bulk'})])
  const before=await snapshot()
  await db.exec('BEGIN READ ONLY')
  assert.deepEqual(await call('lotto815-bulk'),{batch_id:'lotto815-bulk',members:500,held_metadata_members:500,held_rpc_members:500,consent_review_members:500})
  await db.exec('COMMIT')
  assert.deepEqual(await snapshot(),before)
  await row('bulk-overflow','01089999999',{...held,import_batch:'lotto815-bulk'})
  await assert.rejects(call('lotto815-bulk'),{code:'22023'})
})
