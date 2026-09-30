// Synthetic local PostgreSQL only. No source archive, network, credentials or real customer data.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const sql = await readFile(new URL('../../supabase/migrations/20260930061627_atomic_best_review_import.sql', import.meta.url), 'utf8')
const schema = await readFile(new URL('../../supabase/migrations/0001_schema.sql', import.meta.url), 'utf8')
const duplicateGuard = (await readFile(new URL('../../supabase/migrations/20260914032636_atomic_815_collision_import.sql', import.meta.url), 'utf8')).split('CREATE OR REPLACE FUNCTION public.admin_import_815_collision_batch')[0]
const sha = '433ce78f8e86966cc948282d59fd3c165afc2da3a9a52a8df720408d1d5d9818'
const flags = Object.fromEntries(['groupSystemYN','groupAdminYN','groupPartnerYN','groupSalesYN','groupSecondSalesYN','groupStaffYN','groupDummyYN','groupTeamAdmYN','groupTeamYN'].map(k=>[k,'N']))
let serial = 0
const batch = () => `best-review-20260930-${++serial}`
function member(b, overrides = {}) {
  const idx = ++serial
  return { id:`mem_${randomUUID()}`,user_id:`local-${idx}`,name:'합성 테스트',nickname:null,
    phone:`01099${String(idx).padStart(6,'0')}`,grade:'goldp',status:'active',consult_status:'신규',outcall_done:false,
    inflow_code:null,inflow_type:null,memo:null,registered_at:'2024-01-01T09:00:00+09:00',last_active_at:null,
    is_suspended:false,is_deleted:false,is_withdrawn:false,
    meta:{source_site:'best',import_batch:b,legacy_source_sha256:sha,imported:true,legacy_idx:idx,legacy_level_num:2,legacy_status:'normal',
      reco_paused:true,reco_pause_reason:'legacy_import_review',legacy_consent_review_required:true,
      legacy_agree_sms_yn:'N',legacy_account_flags:{...flags}},...overrides }
}
function payment(b, m, overrides = {}) {
  return {id:`pay_${randomUUID()}`,member_id:m.id,product_id:'legacy_best_premium',amount:1000,method:'manual',status:'approved',
    period_start:'2024-01-01T00:00:00+09:00',period_end:'2027-01-01T00:00:00+09:00',depositor_name:null,
    paid_at:'2024-01-01T00:00:00+09:00',created_at:'2024-01-01T00:00:00+09:00',
    meta:{source_site:'best',import_batch:b,legacy_idx:++serial,legacy_source_sha256:sha,
      legacy_user_idx:m.meta.legacy_idx,legacy_item_code:'premium',legacy_status:'success',legacy_item_won:1000,
      legacy_payment_method_code:'officeCredit',legacy_payment_method_review_required:false},...overrides}
}
async function call(b, members, payments, counts=[members.length,payments.length,payments.reduce((a,p)=>a+p.amount,0)]) {
  return (await db.query('SELECT public.admin_import_best_review_batch($1,$2,$3,$4,$5,$6) AS result',
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
  await db.exec(await readFile(new URL('../../supabase/migrations/20260916025359_legacy_payment_unknown_method.sql',import.meta.url),'utf8'))
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
      ('legacy_best_premium','합성 과거상품','goldp',false),
      ('legacy_best_vip','합성 과거상품','vip',false);
    INSERT INTO public.members(id,user_id,name,phone,meta) VALUES
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
    WHERE oid='public.admin_import_best_review_batch(text,jsonb,jsonb,integer,integer,bigint)'::regprocedure`)).rows[0]
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
  assert.equal(result.protected_existing_members,1);assert.equal(result.protected_existing_payments,0);assert.equal(result.protected_existing_full_rows_unchanged,true)
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
test('source rows with a blank original name are preserved for review', async()=>{
  const b=batch(), m=member(b,{name:''}), p=payment(b,m)
  const receipt=await call(b,[m],[p])
  assert.equal(receipt.members,1)
  assert.equal((await db.query('SELECT name FROM public.members WHERE id=$1',[m.id])).rows[0].name,'')
})
for (const [kind, phone] of Object.entries({domestic:d=>d,dashed:d=>`${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`,
  international:d=>`+82 ${d.slice(1)}`,international00:d=>`0082 ${d.slice(1)}`,international0:d=>`+82 (0)${d.slice(1)}`,international000:d=>`0082 (0)${d.slice(1)}`})) {
  test(`same-site ${kind} phone conflicts cannot mark or overwrite any existing row`,async()=>{
    const b=batch(),m=member(b)
    await asOwner(()=>db.query(`INSERT INTO public.members(id,user_id,name,phone,meta)
      VALUES($1,$1,'합성 기존 프리미엄', $2,'{"source_site":"best","unchanged":true}')`,[`existing-${randomUUID()}`,phone(m.phone)]))
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
  await asOwner(()=>db.query(`INSERT INTO public.members(id,user_id,name,phone,meta) VALUES($1,$2,'합성 기존', '01012340000','{}')`,[m.id,`other-${++serial}`]))
  await rejectsUnchanged(b,[m],[],undefined,'23505')
  b=batch();m=member(b)
  await asOwner(()=>db.query(`INSERT INTO public.members(id,user_id,name,phone,meta) VALUES($1,$1,'합성 기존','01012340001',$2)`,
    [`other-${++serial}`,JSON.stringify({source_site:'best',legacy_idx:m.meta.legacy_idx})]))
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
  m.meta.legacy_status='block'
  assert.equal((await call(b,[m],[])).held_members,1)
})
test('payment source/link/product/status/staff and totals are validated before inserts',async()=>{
  const b=batch(),m=member(b),p=payment(b,m)
  await rejectsUnchanged(b,[m],[p],[1,1,999],'22023')
  await rejectsUnchanged(b,[m],[p],[2,1,1000],'22023')
  for(const change of [{member_id:'native'},{product_id:'legacy_lotto815_first'},{product_id:'legacy_best_royal'},
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
  await rejectsUnchanged('best-review-20260917-1',[m],[p],undefined,'22023')
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
  const b=batch(),m=member(b),p=payment(b,m,{product_id:'legacy_best_royal'})
  p.meta.legacy_item_code='royal'
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

test('source grades and statuses map exactly; no payment is required for a source member',async()=>{
  for(const [level,grade] of [[0,'simple'],[1,'free'],[2,'goldp'],[3,'vip'],[4,'royal'],[6,'vip']]) {
    const b=batch(),m=member(b,{grade});m.meta.legacy_level_num=level
    assert.equal((await call(b,[m],[])).held_members,1)
    const wrong=member(batch(),{grade:'royal'});wrong.meta.legacy_level_num=level
    if(grade!=='royal')await rejectsUnchanged(wrong.meta.import_batch,[wrong],[],undefined,'22023')
  }
  for(const [source,status] of Object.entries({normal:'active',standby:'active',end:'active',block:'suspended',remove:'deleted',leave:'withdrawn'})) {
    const b=batch(),m=member(b,{status,is_suspended:status==='suspended',is_deleted:status==='deleted',is_withdrawn:status==='withdrawn'})
    m.meta.legacy_status=source
    assert.equal((await call(b,[m],[])).members,1)
  }
  for(const change of [{legacy_status:''},{legacy_status:null},{legacy_status:'unknown'},{legacy_level_num:5},{legacy_level_num:null}]) {
    const b=batch(),m=member(b);Object.assign(m.meta,change)
    await rejectsUnchanged(b,[m],[],undefined,'22023')
  }
})

test('known payment methods map strictly and zero-amount source records are retained',async()=>{
  for(const [code,method] of Object.entries({siteCredit:'pg',officeCredit:'manual',siteBank:'bank'})) {
    const b=batch(),m=member(b),p=payment(b,m,{method,amount:0})
    Object.assign(p.meta,{legacy_payment_method_code:code,legacy_item_won:0})
    const result=await call(b,[m],[p]);assert.equal(result.amount,0);assert.equal(result.payments,1)
    assert.equal((await db.query('SELECT amount,method FROM payments WHERE id=$1',[p.id])).rows[0].method,method)
  }
})

test('unmapped payment methods preserve original code as unknown, never guessed manual or PG',async()=>{
  for(const code of ['', 'unmapped-original-code']) {
    const b=batch(),m=member(b),p=payment(b,m,{method:'unknown'})
    Object.assign(p.meta,{legacy_payment_method_code:code,legacy_payment_method_review_required:true})
    for(const change of [
      {...p,method:'manual'}, {...p,method:'pg'},
      {...p,meta:{...p.meta,legacy_payment_method_review_required:false}},
      {...p,meta:{...p.meta,legacy_payment_method_code:null}},
      {...p,meta:{...p.meta,legacy_payment_method_code:'officeCredit'}},
    ])await rejectsUnchanged(b,[m],[change],undefined,'22023')
    assert.equal((await call(b,[m],[p])).payments,1)
    const row=(await db.query('SELECT method,meta FROM payments WHERE id=$1',[p.id])).rows[0]
    assert.equal(row.method,'unknown');assert.equal(row.meta.legacy_payment_method_code,code)
    assert.equal(row.meta.legacy_payment_method_review_required,true)
  }
})

for(const mutation of ['member-memo','member-phone','payment-amount','payment-member','new-peer','new-payment']) {
  test(`existing same-phone contract protection rejects ${mutation} trigger effects`,async()=>{
    const b=batch(),m=member(b),peer=`peer-${++serial}`,oldPay=`old-pay-${serial}`
    await asOwner(async()=>{
      await db.query(`INSERT INTO public.members(id,user_id,name,phone,meta) VALUES($1,$1,'합성 다른 사이트 계약',$2,'{"source_site":"pluslotto"}')`,[peer,m.phone])
      await db.query(`INSERT INTO public.payments(id,member_id,amount,method,status) VALUES($1,$2,77,'bank','approved')`,[oldPay,peer])
      const changes={
        'member-memo':`UPDATE public.members SET memo='unwanted-trigger-change' WHERE id='${peer}';`,
        'member-phone':`UPDATE public.members SET phone='01055556666' WHERE id='${peer}';`,
        'payment-amount':`UPDATE public.payments SET amount=amount+1 WHERE id='${oldPay}';`,
        'payment-member':`UPDATE public.payments SET member_id='native' WHERE id='${oldPay}';`,
        'new-peer':`INSERT INTO public.members(id,user_id,name,phone,meta) VALUES('unexpected-${peer}','unexpected-${peer}','합성 부수계약',NEW.phone,'{"source_site":"infolotto"}');`,
        'new-payment':`INSERT INTO public.payments(id,member_id,amount,method,status) VALUES('unexpected-${oldPay}','${peer}',1,'bank','approved');`,
      }
      await db.exec(`CREATE OR REPLACE FUNCTION public.synthetic_peer_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.meta->>'source_site'='best' THEN ${changes[mutation]} END IF; RETURN NEW; END $$;
        CREATE TRIGGER synthetic_peer_change AFTER INSERT ON public.members FOR EACH ROW EXECUTE FUNCTION public.synthetic_peer_change();`)
    })
    try { await rejectsUnchanged(b,[m],[payment(b,m)],undefined,'P0001') }
    finally {await asOwner(()=>db.exec('DROP TRIGGER synthetic_peer_change ON public.members'))}
  })
}

for(const mutation of ['skip','meta','sms','member','payment']) {
  test(`receipt trigger ${mutation} effects cannot return a false successful batch`,async()=>{
    const b=batch(),m=member(b),p=payment(b,m)
    const changes={
      skip:'RETURN NULL;',meta:`NEW.meta=NEW.meta || '{"changed":true}'; RETURN NEW;`,
      sms:`INSERT INTO public.sms_sends(id,member_id) VALUES('receipt-send','${m.id}'); RETURN NEW;`,
      member:`UPDATE public.members SET meta=meta || '{"changed":true}' WHERE id='${m.id}'; RETURN NEW;`,
      payment:`UPDATE public.payments SET amount=amount+1 WHERE id='${p.id}'; RETURN NEW;`,
    }
    await asOwner(()=>db.exec(`CREATE OR REPLACE FUNCTION public.synthetic_log_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${changes[mutation]} END $$;
      CREATE TRIGGER synthetic_log_change BEFORE INSERT ON public.logs FOR EACH ROW EXECUTE FUNCTION public.synthetic_log_change();`))
    try {await rejectsUnchanged(b,[m],[p],undefined,'P0001')}
    finally {await asOwner(()=>db.exec('DROP TRIGGER synthetic_log_change ON public.logs'))}
  })
}

test('four reviewed products seed inactive, never overwrites existing source or other-site products',async()=>{
  const isolated=new PGlite()
  try {
    await isolated.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)')
    await isolated.exec(schema)
    await isolated.exec(`INSERT INTO products(id,name,price,duration_months,grade_granted,is_active)
      VALUES('existing-product','기존 상품',700,3,'goldp',true)`)
    const seed=await readFile(new URL('../../supabase/migrations/20260930061917_best_review_products.sql',import.meta.url),'utf8')
    const prior=(await isolated.query(`SELECT * FROM products WHERE id='existing-product'`)).rows
    await isolated.exec(seed)
    const first=(await isolated.query('SELECT * FROM products ORDER BY id')).rows
    await isolated.exec(seed)
    assert.deepEqual((await isolated.query('SELECT * FROM products ORDER BY id')).rows,first)
    assert.deepEqual((await isolated.query(`SELECT * FROM products WHERE id='existing-product'`)).rows,prior)
    const products=first.filter(r=>r.id.startsWith('legacy_best_'))
    assert.equal(products.length,4);assert.ok(products.every(r=>r.is_active===false))
    assert.deepEqual(products.map(r=>[r.id,r.price,r.duration_months,r.grade_granted]),[
      ['legacy_best_premium',431900,18,'goldp'],['legacy_best_royal',4900000,36,'royal'],
      ['legacy_best_unbalance',999000,36,'vip'],['legacy_best_vip',6160000,36,'vip']])
    await isolated.exec(`UPDATE products SET price=1 WHERE id='legacy_best_premium'`)
    const changed=(await isolated.query('SELECT * FROM products ORDER BY id')).rows
    await assert.rejects(isolated.exec(seed),{code:'23505'})
    assert.deepEqual((await isolated.query('SELECT * FROM products ORDER BY id')).rows,changed)
  } finally {await isolated.close()}
})

test('all four source products link to their own best products without changing source price',async()=>{
  await asOwner(()=>db.exec(`INSERT INTO products(id,name,grade_granted,is_active) VALUES
    ('legacy_best_royal','합성 과거상품','royal',false),('legacy_best_unbalance','합성 과거상품','vip',false)`))
  for(const code of ['premium','vip','royal','unbalance']) {
    const b=batch(),m=member(b),p=payment(b,m,{product_id:`legacy_best_${code}`,amount:123})
    Object.assign(p.meta,{legacy_item_code:code,legacy_item_won:123})
    assert.equal((await call(b,[m],[p])).amount,123)
    assert.equal((await db.query('SELECT amount FROM payments WHERE id=$1',[p.id])).rows[0].amount,123)
  }
})

test('extra payment for a newly inserted contract rolls back even without import metadata',async()=>{
  const b=batch(),m=member(b),p=payment(b,m)
  await asOwner(()=>db.exec(`CREATE OR REPLACE FUNCTION public.synthetic_extra_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${p.id}' THEN INSERT INTO public.payments(id,member_id,amount,method,status)
      VALUES('extra-payment','${m.id}',0,'bank','approved'); END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_extra_payment AFTER INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION public.synthetic_extra_payment();`))
  try {await rejectsUnchanged(b,[m],[p],undefined,'P0001')}
  finally {await asOwner(()=>db.exec('DROP TRIGGER synthetic_extra_payment ON public.payments'))}
})
