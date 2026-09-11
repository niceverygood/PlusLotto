// Local in-memory PostgreSQL only. No production credentials or customer fixtures.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const baseSql = await readFile(new URL('../../supabase/migrations/20260910023000_atomic_815_review_import.sql', import.meta.url), 'utf8')
const lookupSql = await readFile(new URL('../../supabase/migrations/20260910030000_atomic_815_review_import_lookup.sql', import.meta.url), 'utf8')
const sql = await readFile(new URL('../../supabase/migrations/20260910111500_atomic_815_phone_representations.sql', import.meta.url), 'utf8')
const schema = await readFile(new URL('../../supabase/migrations/0001_schema.sql', import.meta.url), 'utf8')
const duplicateGuard = (await readFile(new URL('../../supabase/migrations/20260722081812_duplicate_member_guard.sql', import.meta.url), 'utf8')).split('-- 신규 차단 뒤에는')[0]
const flags = Object.fromEntries(['groupSystemYN','groupAdminYN','groupPartnerYN','groupSalesYN','groupSecondSalesYN','groupStaffYN','groupDummyYN','groupTeamAdmYN','groupTeamYN'].map(k=>[k,'N']))
let serial = 0
const batch = () => `lotto815-local-${++serial}`
function member(b, overrides = {}) {
  const idx = ++serial
  return { id:`mem_${randomUUID()}`,user_id:`local-${idx}`,name:'합성 테스트',nickname:null,
    phone:`01099${String(idx).padStart(6,'0')}`,grade:'goldp',status:'active',consult_status:'신규',outcall_done:false,
    inflow_code:null,inflow_type:null,memo:null,registered_at:'2024-01-01T09:00:00+09:00',last_active_at:null,
    is_suspended:false,is_deleted:false,is_withdrawn:false,
    meta:{source_site:'lotto815',import_batch:b,legacy_idx:idx,reco_paused:true,reco_pause_reason:'legacy_import_review',
      legacy_consent_review_required:true,legacy_agree_sms_yn:'N',legacy_account_flags:{...flags}},...overrides }
}
function payment(b, m, overrides = {}) {
  return {id:`pay_${randomUUID()}`,member_id:m.id,product_id:'legacy_lotto815_family',amount:1000,method:'manual',status:'approved',
    period_start:'2024-01-01T00:00:00+09:00',period_end:'2027-01-01T00:00:00+09:00',depositor_name:null,
    paid_at:'2024-01-01T00:00:00+09:00',created_at:'2024-01-01T00:00:00+09:00',
    meta:{source_site:'lotto815',import_batch:b,legacy_idx:++serial},...overrides}
}
async function call(b, members, payments, counts=[members.length,payments.length,payments.reduce((a,p)=>a+p.amount,0)]) {
  return (await db.query('SELECT public.admin_import_815_review_batch($1,$2,$3,$4,$5,$6) AS result',
    [b,JSON.stringify(members),JSON.stringify(payments),...counts])).rows[0].result
}
async function snapshot() {
  return (await db.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]') FROM public.members m) AS members,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.payments p) AS payments,
    (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]') FROM public.logs l) AS logs,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') FROM public.products p) AS products`)).rows[0]
}
async function rejectsUnchanged(b, members, payments, counts, code) {
  const before = await snapshot()
  await assert.rejects(call(b,members,payments,counts), code ? {code} : undefined)
  assert.deepEqual(await snapshot(), before)
}
before(async()=>{
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`)
  await db.exec(schema)
  await db.exec(`ALTER TABLE public.members ADD COLUMN consult_status text DEFAULT '신규';
    ALTER TABLE public.payments ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
    CREATE FUNCTION public.app_role() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
    CREATE FUNCTION public.app_staff_id() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
    GRANT USAGE ON SCHEMA public,auth TO service_role,anon,authenticated;
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
    INSERT INTO products(id,name,grade_granted,is_active) VALUES ('legacy_lotto815_family','합성 과거상품','goldp',false);
    INSERT INTO members(id,user_id,name,phone,meta) VALUES ('native','native','합성 기존고객','01011112222','{"unchanged":true}');`)
  await db.exec(duplicateGuard)
  await db.exec(`CREATE TRIGGER members_admin_ops BEFORE INSERT OR UPDATE ON public.members
    FOR EACH ROW EXECUTE FUNCTION public.enforce_member_admin_ops();`)
})
after(()=>db.close())

test('add-only replay does not change rows and grants only the service role', async(t)=>{
  const before = await snapshot()
  await db.exec(baseSql); await db.exec(lookupSql); await db.exec(sql); await db.exec(sql)
  assert.deepEqual(await snapshot(),before)
  const f=(await db.query(`SELECT prosecdef,proconfig,md5(prosrc) AS body_md5 FROM pg_proc
    WHERE oid='public.admin_import_815_review_batch(text,jsonb,jsonb,integer,integer,bigint)'::regprocedure`)).rows[0]
  assert.equal(f.prosecdef,false);assert.ok(f.proconfig.includes('search_path=""'))
  assert.ok(f.proconfig.includes('lock_timeout=3s'))
  t.diagnostic(`final function body md5=${f.body_md5}`)
  for(const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`)
    await assert.rejects(call(batch(),[member(batch())],[]),{code:'42501'})
    await db.exec('RESET ROLE')
  }
})
test('one atomic request inserts exact source rows and retry is a no-write rejection',async()=>{
  const b=batch(),m=[member(b),member(b)],p=[payment(b,m[0]),payment(b,m[1])]
  await db.exec('SET ROLE service_role')
  const result=await call(b,m,p)
  assert.deepEqual(result,{batch_id:b,members:2,payments:2,amount:2000,held_members:2,atomic:true})
  await rejectsUnchanged(b,m,p,undefined,'23505')
  await db.exec('RESET ROLE')
})
test('existing phone is rejected before duplicate marker or log can change',async()=>{
  const b=batch(),m=member(b,{phone:'01011112222'})
  await rejectsUnchanged(b,[m],[payment(b,m)],undefined,'23505')
})
const storedPhoneForms = {
  domestic: d => `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`,
  '+82': d => `+82 ${d.slice(1,3)}-${d.slice(3,7)}-${d.slice(7)}`,
  '0082': d => `0082 ${d.slice(1,3)}-${d.slice(3,7)}-${d.slice(7)}`,
  '820': d => `+82 (0)${d.slice(1,3)}-${d.slice(3,7)}-${d.slice(7)}`,
  '00820': d => `0082 (0)${d.slice(1,3)}-${d.slice(3,7)}-${d.slice(7)}`,
}
for (const [form, storedPhone] of Object.entries(storedPhoneForms)) {
  test(`existing ${form} number rejects domestic import and preserves every row and log`, async()=>{
    const b=batch(), candidate=member(b)
    const existingId=`existing-${randomUUID()}`
    await db.query(`INSERT INTO members(id,user_id,name,phone,meta)
      VALUES ($1,$1,'synthetic existing phone',$2,'{"unchanged":true,"nested":{"keep":[1,2]}}')`,
      [existingId,storedPhone(candidate.phone)])
    await db.exec('SET ROLE service_role')
    try {
      await rejectsUnchanged(b,[candidate],[payment(b,candidate)],undefined,'23505')
    } finally {
      await db.exec('RESET ROLE')
    }
  })
}
test('non-domestic candidate spelling remains rejected before writes',async()=>{
  for (const form of ['+82','0082','820','00820']) {
    const b=batch(),candidate=member(b)
    candidate.phone=storedPhoneForms[form](candidate.phone).replace(/\D/g,'')
    await rejectsUnchanged(b,[candidate],[payment(b,candidate)],undefined,'22023')
  }
})
test('a payment failure rolls back all member inserts',async()=>{
  const b=batch(),m=member(b),p=payment(b,m,{product_id:'legacy_lotto815_mania'}) // allowed code, missing FK fixture
  await rejectsUnchanged(b,[m],[p],undefined,'23503')
})
test('a silent trigger skip rolls back prior inserts and trigger side effects',async()=>{
  await db.exec(`CREATE FUNCTION public.synthetic_skip() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF new.user_id='drop-test' THEN UPDATE public.members SET meta=meta || '{"accidental":true}' WHERE id='native';
      RETURN NULL; END IF; RETURN new; END;$$;
    CREATE TRIGGER synthetic_skip BEFORE INSERT ON members FOR EACH ROW EXECUTE FUNCTION public.synthetic_skip();`)
  const b=batch(),m=[member(b),member(b,{user_id:'drop-test'})]
  await rejectsUnchanged(b,m,[payment(b,m[0])],undefined,'P0001')
  await db.exec('DROP TRIGGER synthetic_skip ON members')
})
test('wrong counts, amounts, links and source keys cannot partially apply',async()=>{
  const b=batch(),m=member(b),p=payment(b,m)
  await rejectsUnchanged(b,[m],[p],[1,1,999],'22023')
  await rejectsUnchanged(b,[m],[p],[2,1,1000],'22023')
  await rejectsUnchanged(b,[m],[{...p,member_id:'native'}],undefined,'22023')
  const other=member(b);other.meta.legacy_idx=m.meta.legacy_idx
  await rejectsUnchanged(b,[m,other],[p],undefined,'22023')
  await rejectsUnchanged(b,[m],[p,{...p,id:`pay_${randomUUID()}`}],undefined,'22023')
})
test('holds must be true boolean and only unflagged consent-preserved 815 rows enter',async()=>{
  for(const change of [
    {reco_paused:'true'},{reco_paused:false},{source_site:'pluslotto'},
    {legacy_agree_sms_yn:null},{legacy_account_flags:{...flags,groupTeamYN:'Y'}},
    {legacy_account_flags:{}},{weekly_recos:[]},{legacy_consent_review_required:false},
  ]) {
    const b=batch(),m=member(b);m.meta={...m.meta,...change}
    await rejectsUnchanged(b,[m],[],undefined,'22023')
  }
})
test('status flags and unassigned boundary are enforced',async()=>{
  for(const change of [{status:'suspended'}, {assigned_staff_id:'staff-other'}, {team_id:'team-other'}, {is_deleted:'false'}]) {
    const b=batch(),m=member(b,change)
    await rejectsUnchanged(b,[m],[],undefined,'22023')
  }
})
test('separate lookups still reject login and source identity collisions',async()=>{
  const b=batch(), existing=member(b)
  await call(b,[existing],[])
  for(const key of ['id','user_id','legacy_idx']) {
    const next=batch(),candidate=member(next)
    if(key==='legacy_idx') candidate.meta.legacy_idx=existing.meta.legacy_idx
    else candidate[key]=existing[key]
    await rejectsUnchanged(next,[candidate],[],undefined,'23505')
  }
})
test('100-member batch against 60000 synthetic existing rows',async(t)=>{
  await db.exec(`ALTER TABLE members DISABLE TRIGGER members_admin_ops;
    INSERT INTO members(id,user_id,name,phone) SELECT 'fixture-'||g,'fixture-'||g,'synthetic','0107'||lpad(g::text,7,'0')
    FROM generate_series(1,60000) g;
    ALTER TABLE members ENABLE TRIGGER members_admin_ops;
    CREATE INDEX members_phone_digits_review_test ON members(regexp_replace(phone,'\\D','','g'));`)
  const b=batch(), members=Array.from({length:100},()=>member(b)), payments=members.map(m=>payment(b,m))
  const started=performance.now()
  const result=await call(b,members,payments)
  t.diagnostic(`synthetic 60000+100 atomic request elapsed_ms=${Math.round(performance.now()-started)}`)
  assert.deepEqual(result,{batch_id:b,members:100,payments:100,amount:100000,held_members:100,atomic:true})
})
