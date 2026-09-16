// Synthetic local PostgreSQL only. No source archive, network, credentials or real customer data.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const sql = await readFile(new URL('../../supabase/migrations/20260916020133_atomic_cplotto_review_import.sql', import.meta.url), 'utf8')
const schema = await readFile(new URL('../../supabase/migrations/0001_schema.sql', import.meta.url), 'utf8')
const duplicateGuard = (await readFile(new URL('../../supabase/migrations/20260914032636_atomic_815_collision_import.sql', import.meta.url), 'utf8')).split('CREATE OR REPLACE FUNCTION public.admin_import_815_collision_batch')[0]
const sha = '5f9af9af0666b980654841a05fe691423a3be90c31461220442fc7858eec8175'
const flags = Object.fromEntries(['groupSystemYN','groupAdminYN','groupPartnerYN','groupSalesYN','groupSecondSalesYN','groupStaffYN','groupDummyYN','groupTeamAdmYN','groupTeamYN'].map(k=>[k,'N']))
let serial = 0
const batch = () => `cplotto-review-20260916-${++serial}`
function member(b, overrides = {}) {
  const idx = ++serial
  return { id:`mem_${randomUUID()}`,user_id:`local-${idx}`,name:'합성 테스트',nickname:null,
    phone:`01099${String(idx).padStart(6,'0')}`,grade:'goldp',status:'active',consult_status:'신규',outcall_done:false,
    inflow_code:null,inflow_type:null,memo:null,registered_at:'2024-01-01T09:00:00+09:00',last_active_at:null,
    is_suspended:false,is_deleted:false,is_withdrawn:false,
    meta:{source_site:'cplotto',import_batch:b,legacy_source_sha256:sha,imported:true,legacy_idx:idx,
      reco_paused:true,reco_pause_reason:'legacy_import_review',legacy_consent_review_required:true,
      legacy_agree_sms_yn:'N',legacy_account_flags:{...flags}},...overrides }
}
function payment(b, m, overrides = {}) {
  return {id:`pay_${randomUUID()}`,member_id:m.id,product_id:'legacy_cplotto_goldplus',amount:1000,method:'manual',status:'approved',
    period_start:'2024-01-01T00:00:00+09:00',period_end:'2027-01-01T00:00:00+09:00',depositor_name:null,
    paid_at:'2024-01-01T00:00:00+09:00',created_at:'2024-01-01T00:00:00+09:00',
    meta:{source_site:'cplotto',import_batch:b,legacy_idx:++serial,legacy_source_sha256:sha,
      legacy_user_idx:m.meta.legacy_idx,legacy_item_code:'goldplus',legacy_status:'success'},...overrides}
}
async function call(b, members, payments, counts=[members.length,payments.length,payments.reduce((a,p)=>a+p.amount,0)]) {
  return (await db.query('SELECT public.admin_import_cplotto_review_batch($1,$2,$3,$4,$5,$6) AS result',
    [b,JSON.stringify(members),JSON.stringify(payments),...counts])).rows[0].result
}
async function snapshot() {
  const tables = ['members','payments','logs','products','sms_sends','bets','assignments','staff','teams','site_settings']
  const result = {}
  for (const table of tables) result[table]=(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]') AS rows FROM public.${table} x`)).rows[0].rows
  result.auth=(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') AS rows FROM auth.users x`)).rows[0].rows
  return result
}
async function rejectsUnchanged(b, members, payments, counts, code) {
  const previous = await snapshot()
  await assert.rejects(call(b,members,payments,counts), code ? {code} : undefined)
  assert.deepEqual(await snapshot(), previous)
}
async function asOwner(callback) {
  await db.exec('RESET ROLE')
  try { return await callback() } finally { await db.exec('SET ROLE service_role') }
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
    CREATE FUNCTION public.member_operating_site(public.members) RETURNS text LANGUAGE sql IMMUTABLE
      AS $$ SELECT coalesce(nullif(btrim($1.meta->>'source_site'),''),'pluslotto') $$;
    GRANT USAGE ON SCHEMA public,auth TO service_role,anon,authenticated;
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT SELECT ON auth.users TO service_role;
    INSERT INTO products(id,name,grade_granted,is_active) VALUES
      ('legacy_cplotto_goldplus','합성 과거상품','goldp',false),
      ('legacy_cplotto_vipgold','합성 과거상품','vip',false),
      ('legacy_cplotto_first','합성 과거상품','royal',false);
    INSERT INTO members(id,user_id,name,phone,meta) VALUES
      ('native','native','합성 기존고객','01011112222','{"source_site":"pluslotto","unchanged":true}');`)
  await db.exec(duplicateGuard)
  await db.exec(`CREATE TRIGGER members_admin_ops BEFORE INSERT OR UPDATE ON public.members
    FOR EACH ROW EXECUTE FUNCTION public.enforce_member_admin_ops();`)
  await db.exec(sql)
  await db.exec('SET ROLE service_role')
})
after(()=>db.close())

test('add-only repeat migration preserves data and grants only actual service_role', async()=>{
  const previous = await snapshot()
  await asOwner(async()=>{ await db.exec(sql); await db.exec(sql) })
  assert.deepEqual(await snapshot(), previous)
  const f=(await db.query(`SELECT prosecdef,proconfig FROM pg_proc
    WHERE oid='public.admin_import_cplotto_review_batch(text,jsonb,jsonb,integer,integer,bigint)'::regprocedure`)).rows[0]
  assert.equal(f.prosecdef,false)
  assert.ok(f.proconfig.includes('search_path=""'))
  assert.ok(f.proconfig.includes('lock_timeout=3s'))
  assert.ok(f.proconfig.includes('statement_timeout=60s'))
  for (const role of ['anon','authenticated']) {
    await asOwner(async()=>{
      await db.exec(`SET ROLE ${role}`)
      const b=batch()
      await assert.rejects(call(b,[member(b)],[]),{code:'42501'})
    })
  }
  await asOwner(async()=>{
    const b=batch()
    await assert.rejects(call(b,[member(b)],[]),{code:'42501'})
  })
})
test('same-phone other-site contracts remain byte-for-byte unchanged; exact payment links and receipt',async()=>{
  const b=batch(),m=[member(b,{phone:'01011112222'}),member(b)],p=[payment(b,m[0]),payment(b,m[0]),payment(b,m[1])]
  const previous=await snapshot()
  const result=await call(b,m,p)
  assert.equal(result.members,2);assert.equal(result.payments,3);assert.equal(result.amount,3000)
  assert.equal(result.held_members,2);assert.equal(result.atomic,true);assert.equal(result.legacy_source_sha256,sha)
  assert.match(result.payload_md5,/^[a-f0-9]{32}$/)
  const next=await snapshot()
  assert.deepEqual(next.members.find(r=>r.id==='native'),previous.members.find(r=>r.id==='native'))
  for (const t of ['products','sms_sends','bets','assignments','staff','teams','site_settings','auth']) assert.deepEqual(next[t],previous[t])
  for(const record of m) {
    const stored=next.members.find(r=>r.id===record.id)
    assert.deepEqual(stored.meta,record.meta)
    assert.equal(stored.assigned_staff_id,null);assert.equal(stored.team_id,null)
  }
  assert.deepEqual(next.logs.at(-1).meta,result)
  await rejectsUnchanged(b,m,p,undefined,'23505')
})
for (const [kind, phone] of Object.entries({domestic:d=>d,dashed:d=>`${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`,
  international:d=>`+82 ${d.slice(1)}`,international00:d=>`0082 ${d.slice(1)}`,international0:d=>`+82 (0)${d.slice(1)}`,international000:d=>`0082 (0)${d.slice(1)}`})) {
  test(`same-site ${kind} phone conflicts cannot mark or overwrite any existing row`,async()=>{
    const b=batch(),m=member(b)
    await asOwner(()=>db.query(`INSERT INTO members(id,user_id,name,phone,meta)
      VALUES($1,$1,'합성 기존 일행', $2,'{"source_site":"cplotto","unchanged":true}')`,[`existing-${randomUUID()}`,phone(m.phone)]))
    await rejectsUnchanged(b,[m],[payment(b,m)],undefined,'23505')
  })
}
test('payload duplicate IDs, phones, login IDs and source identities are rejected unchanged',async()=>{
  for (const key of ['id','phone','user_id','legacy_idx']) {
    const b=batch(),m=[member(b),member(b)]
    if(key==='legacy_idx') m[1].meta.legacy_idx=m[0].meta.legacy_idx
    else m[1][key]=m[0][key]
    await rejectsUnchanged(b,m,[],undefined,'22023')
  }
  const b=batch(),m=member(b),p=payment(b,m)
  await rejectsUnchanged(b,[m],[p,{...p,id:`pay_${randomUUID()}`}],undefined,'22023')
  await rejectsUnchanged(b,[m],[p,{...p,meta:{...p.meta,legacy_idx:++serial}}],undefined,'22023')
})
test('all-sites existing login and ID collisions plus same-site source keys are rejected',async()=>{
  let b=batch(),m=member(b,{user_id:'native'})
  await rejectsUnchanged(b,[m],[],undefined,'23505')
  b=batch();m=member(b)
  await asOwner(()=>db.query(`INSERT INTO members(id,user_id,name,phone,meta) VALUES($1,$2,'합성 기존', '01012340000','{}')`,[m.id,`other-${++serial}`]))
  await rejectsUnchanged(b,[m],[],undefined,'23505')
  b=batch();m=member(b)
  await asOwner(()=>db.query(`INSERT INTO members(id,user_id,name,phone,meta) VALUES($1,$1,'합성 기존','01012340001',$2)`,
    [`other-${++serial}`,JSON.stringify({source_site:'cplotto',legacy_idx:m.meta.legacy_idx})]))
  await rejectsUnchanged(b,[m],[],undefined,'23505')
})
test('provenance, holds, consent evidence and operator exclusion fail closed',async()=>{
  for(const change of [
    {reco_paused:'true'},{reco_paused:false},{source_site:'pluslotto'},{imported:false},
    {legacy_source_sha256:'0'.repeat(64)},{legacy_agree_sms_yn:null},{legacy_account_flags:{...flags,groupTeamYN:'Y'}},
    {legacy_account_flags:{}},{weekly_recos:[]},{legacy_consent_review_required:false},
    {reco_pause_reason:null},{legacy_idx:0},{import_batch:'wrong'},{password:'credential-must-not-load'},
  ]) {
    const b=batch(),m=member(b);m.meta={...m.meta,...change}
    await rejectsUnchanged(b,[m],[],undefined,'22023')
  }
})
test('status flags, supplied assignments, invalid phone and unknown columns are rejected',async()=>{
  for(const change of [{status:'suspended'},{assigned_staff_id:'staff-other'},{team_id:'team-other'},
    {is_deleted:'false'},{phone:'+821011112222'},{role:'admin'},{grade:'free'}]) {
    const b=batch(),m=member(b,change)
    await rejectsUnchanged(b,[m],[],undefined,'22023')
  }
  const b=batch(),m=member(b,{status:'suspended',is_suspended:true})
  assert.equal((await call(b,[m],[])).held_members,1)
})
test('payment source/link/product/status/staff and totals are validated before inserts',async()=>{
  const b=batch(),m=member(b),p=payment(b,m)
  await rejectsUnchanged(b,[m],[p],[1,1,999],'22023')
  await rejectsUnchanged(b,[m],[p],[2,1,1000],'22023')
  for(const change of [{member_id:'native'},{product_id:'legacy_lotto815_first'},{product_id:'legacy_cplotto_first'},
    {status:'cancelled'},{amount:-1},{amount:'1000'},{staff_id:'staff-admin'},{pg_provider:'unexpected'}]) {
    await rejectsUnchanged(b,[m],[{...p,...change}],undefined,'22023')
  }
  for(const change of [{legacy_user_idx:0},{legacy_status:'cancel'},{source_site:'lotto815'},
    {legacy_source_sha256:'0'.repeat(64)},{legacy_item_code:'unknown'},{import_batch:'wrong'}]) {
    await rejectsUnchanged(b,[m],[{...p,meta:{...p.meta,...change}}],undefined,'22023')
  }
})
test('existing payment ID and same-site source-key conflicts reject a different batch',async()=>{
  const first=batch(),existing=member(first),oldPayment=payment(first,existing)
  await call(first,[existing],[oldPayment])
  for(const key of ['id','legacy_idx']) {
    const b=batch(),m=member(b),p=payment(b,m)
    if(key==='id') p.id=oldPayment.id
    else p.meta.legacy_idx=oldPayment.meta.legacy_idx
    await rejectsUnchanged(b,[m],[p],undefined,'23505')
  }
})
test('bounded envelope rejects empty or oversized batches and bad batch provenance',async()=>{
  const b=batch(),m=member(b),p=payment(b,m)
  for(const counts of [[0,0,0],[101,1,1000],[1,1001,1000],[1,1,-1]]) await rejectsUnchanged(b,[m],[p],counts,'22023')
  await rejectsUnchanged('cplotto-review-20260917-1',[m],[p],undefined,'22023')
  await rejectsUnchanged(b,[],[],undefined,'22023')
})
test('maximum 100-member and 1000-payment batch is complete with no automatic actions',async()=>{
  const b=batch(),members=Array.from({length:100},()=>member(b))
  const payments=members.flatMap(m=>Array.from({length:10},()=>payment(b,m)))
  const previous=await snapshot()
  const receipt=await call(b,members,payments)
  assert.equal(receipt.members,100);assert.equal(receipt.payments,1000)
  assert.equal(receipt.amount,1000000);assert.equal(receipt.held_members,100)
  const next=await snapshot()
  for(const t of ['sms_sends','bets','assignments','staff','teams','site_settings','auth']) assert.deepEqual(next[t],previous[t])
})
test('missing product FK failure rolls back member insertion',async()=>{
  const b=batch(),m=member(b),p=payment(b,m,{product_id:'legacy_cplotto_gold'})
  p.meta.legacy_item_code='gold'
  await rejectsUnchanged(b,[m],[p],undefined,'23503')
})
for (const mutation of ['skip','id','meta','sms','bet','assignment']) {
  test(`unexpected member trigger ${mutation} behavior rolls back all rows and side effects`,async()=>{
    const changes = {
      skip:`UPDATE public.members SET meta=meta || '{"accidental":true}' WHERE id='native'; RETURN NULL;`,
      id:`NEW.id=NEW.id || '-changed'; RETURN NEW;`,
      meta:`NEW.meta=NEW.meta || '{"accidental":true}'; RETURN NEW;`,
      sms:`INSERT INTO public.sms_sends(id,member_id) VALUES('synthetic-send',NEW.id); RETURN NEW;`,
      bet:`INSERT INTO public.bets(id,round_no,member_ref,numbers) VALUES('synthetic-bet',1,NEW.id,ARRAY[1,2,3,4,5,6]); RETURN NEW;`,
      assignment:`INSERT INTO public.assignments(id,member_id) VALUES('synthetic-assignment',NEW.id); RETURN NEW;`,
    }
    await asOwner(()=>db.exec(`INSERT INTO public.lotto_rounds(round_no,draw_date,numbers,bonus) VALUES(1,now(),ARRAY[1,2,3,4,5,6],7) ON CONFLICT DO NOTHING;
      CREATE OR REPLACE FUNCTION public.synthetic_member_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${changes[mutation]} END $$;
      CREATE TRIGGER synthetic_member_change ${['sms','bet','assignment'].includes(mutation)?'AFTER':'BEFORE'} INSERT ON public.members
        FOR EACH ROW EXECUTE FUNCTION public.synthetic_member_change();`))
    try {
      const b=batch(),m=[member(b),member(b)]
      // SMS/bet/assignment trigger uses one row to avoid conflicting synthetic fixture IDs.
      await rejectsUnchanged(b,['sms','bet','assignment'].includes(mutation)?m.slice(0,1):m,[],undefined,'P0001')
    } finally { await asOwner(()=>db.exec('DROP TRIGGER synthetic_member_change ON public.members')) }
  })
}
for (const mutation of ['skip','id','amount']) {
  test(`unexpected payment trigger ${mutation} behavior rolls back member and payment rows`,async()=>{
    const changes = {skip:'RETURN NULL;',id:"NEW.id=NEW.id || '-changed'; RETURN NEW;",amount:'NEW.amount=NEW.amount+1; RETURN NEW;'}
    await asOwner(()=>db.exec(`CREATE OR REPLACE FUNCTION public.synthetic_payment_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${changes[mutation]} END $$;
      CREATE TRIGGER synthetic_payment_change BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION public.synthetic_payment_change();`))
    try {
      const b=batch(),m=member(b)
      await rejectsUnchanged(b,[m],[payment(b,m)],undefined,'P0001')
    } finally { await asOwner(()=>db.exec('DROP TRIGGER synthetic_payment_change ON public.payments')) }
  })
}
