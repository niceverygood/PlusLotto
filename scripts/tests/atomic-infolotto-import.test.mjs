// Synthetic local PostgreSQL only. No source archive, network, credentials or real customer data.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const sql = await readFile(new URL('../../supabase/migrations/20260916025401_atomic_infolotto_review_import.sql', import.meta.url), 'utf8')
const schema = await readFile(new URL('../../supabase/migrations/0001_schema.sql', import.meta.url), 'utf8')
const duplicateGuard = (await readFile(new URL('../../supabase/migrations/20260914032636_atomic_815_collision_import.sql', import.meta.url), 'utf8')).split('CREATE OR REPLACE FUNCTION public.admin_import_815_collision_batch')[0]
const sha = 'dd452000cbd766cfbeec43cae1421f053bb93f6481ce31436d3ba68f03f3fde4'
const flags = Object.fromEntries(['groupSystemYN','groupAdminYN','groupPartnerYN','groupSalesYN','groupSecondSalesYN','groupStaffYN','groupDummyYN','groupTeamAdmYN','groupTeamYN'].map(k=>[k,'N']))
let serial = 0
const batch = () => `infolotto-review-20260916-${++serial}`
function member(b, overrides = {}) {
  const idx = ++serial
  return { id:`mem_${randomUUID()}`,user_id:`local-${idx}`,name:'합성 테스트',nickname:null,
    phone:`01099${String(idx).padStart(6,'0')}`,grade:'goldp',status:'active',consult_status:'신규',outcall_done:false,
    inflow_code:null,inflow_type:null,memo:null,registered_at:'2024-01-01T09:00:00+09:00',last_active_at:null,
    is_suspended:false,is_deleted:false,is_withdrawn:false,
    meta:{source_site:'infolotto',import_batch:b,legacy_source_sha256:sha,imported:true,legacy_idx:idx,
      reco_paused:true,reco_pause_reason:'legacy_import_review',legacy_consent_review_required:true,
      legacy_agree_sms_yn:'N',legacy_account_flags:{...flags}},...overrides }
}
function payment(b, m, overrides = {}) {
  return {id:`pay_${randomUUID()}`,member_id:m.id,product_id:'legacy_infolotto_basic',amount:1000,method:'manual',status:'approved',
    period_start:'2024-01-01T00:00:00+09:00',period_end:'2027-01-01T00:00:00+09:00',depositor_name:null,
    paid_at:'2024-01-01T00:00:00+09:00',created_at:'2024-01-01T00:00:00+09:00',
    meta:{source_site:'infolotto',import_batch:b,legacy_idx:++serial,legacy_source_sha256:sha,
      legacy_user_idx:m.meta.legacy_idx,legacy_item_code:'basic',legacy_status:'success',legacy_item_won:1000,
      legacy_payment_method_code:'officeCredit',legacy_payment_method_review_required:false},...overrides}
}
async function call(b, members, payments, counts=[members.length,payments.length,payments.reduce((a,p)=>a+p.amount,0)]) {
  return (await db.query('SELECT public.admin_import_infolotto_review_batch($1,$2,$3,$4,$5,$6) AS result',
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
      ('legacy_infolotto_basic','합성 과거상품','goldp',false),
      ('legacy_infolotto_smart','합성 과거상품','vip',false);
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
    WHERE oid='public.admin_import_infolotto_review_batch(text,jsonb,jsonb,integer,integer,bigint)'::regprocedure`)).rows[0]
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
    await asOwner(()=>db.query(`INSERT INTO members(id,user_id,name,phone,meta)
      VALUES($1,$1,'합성 기존 인포', $2,'{"source_site":"infolotto","unchanged":true}')`,[`existing-${randomUUID()}`,phone(m.phone)]))
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
    [`other-${++serial}`,JSON.stringify({source_site:'infolotto',legacy_idx:m.meta.legacy_idx})]))
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
  for(const change of [{member_id:'native'},{product_id:'legacy_lotto815_first'},{product_id:'legacy_infolotto_signature'},
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
  await rejectsUnchanged('infolotto-review-20260917-1',[m],[p],undefined,'22023')
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
  const b=batch(),m=member(b),p=payment(b,m,{product_id:'legacy_infolotto_signature'})
  p.meta.legacy_item_code='signature'
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

const historyLoad = name => readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8')
const historyTables=['legacy_member_memos','legacy_member_sms','legacy_member_wins']
const historyMemberIds={lotto815:'history-lotto815',cplotto:'history-cplotto',infolotto:'history-infolotto',unsupported:'history-unsupported'}
function historyRow(table,site,overrides={}) {
  const row={source_site:site,legacy_idx:7700001,source_user_idx:7700002,member_id:historyMemberIds[site],
    source_insert_datetime:'2026-08-20 09:30:00',source_update_datetime:null,
    archive_sha256:sha,prepared_record_sha256:'a'.repeat(64),import_batch:'infolotto-history-local'}
  if(table==='legacy_member_memos')Object.assign(row,{body:'합성 비공개 메모',source_team_open_yn:'N'})
  if(table==='legacy_member_sms')Object.assign(row,{contents_type:'autoPick',body_policy:'body_preserved',body:'합성 과거 조합 1,2,3,4,5,6'})
  if(table==='legacy_member_wins')Object.assign(row,{round_no:1237,rank:5,prize:5000,numbers:[1,2,3,4,5,6],source_pick_string:'|1|2|3|4|5|6|'})
  return {...row,...overrides}
}
async function addHistory(table,site,overrides={}) {
  const row=historyRow(table,site,overrides),fields=Object.keys(row)
  return db.query(`INSERT INTO public.${table}(${fields.join(',')}) VALUES(${fields.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,Object.values(row))
}
async function historySnapshot() {
  const result={}
  for(const table of historyTables)result[table]=(await db.query(`SELECT jsonb_agg(to_jsonb(h) ORDER BY source_site,legacy_idx) AS rows FROM public.${table} h`)).rows[0].rows
  result.policies=(await db.query(`SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE tablename IN ('legacy_member_memos','legacy_member_sms','legacy_member_wins') ORDER BY tablename,policyname`)).rows
  result.functions=(await db.query(`SELECT proname,prosecdef,proconfig,md5(prosrc) AS body_md5 FROM pg_proc WHERE proname IN ('member_legacy_history_page','legacy_history_check_member_source','legacy_history_preserve_member_identity') ORDER BY proname`)).rows
  result.grants=(await db.query(`SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN ('legacy_member_memos','legacy_member_sms','legacy_member_wins') ORDER BY table_name,grantee,privilege_type`)).rows
  result.queues={sms:(await db.query('SELECT count(*) AS n FROM sms_sends')).rows[0].n,bets:(await db.query('SELECT count(*) AS n FROM bets')).rows[0].n}
  return result
}
test('infolotto history extension preserves existing 815/cplotto rows, RLS, RPCs and write grants',async()=>{
  await asOwner(async()=>{
    await db.exec(`CREATE FUNCTION public.app_team() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
      CREATE OR REPLACE FUNCTION public.app_role() RETURNS text LANGUAGE sql AS $$ SELECT nullif(current_setting('test.app_role',true),'') $$;
      CREATE OR REPLACE FUNCTION public.app_staff_id() RETURNS text LANGUAGE sql AS $$ SELECT nullif(current_setting('test.staff_id',true),'') $$;
      GRANT SELECT ON public.members TO authenticated;
      INSERT INTO staff(id,login_id,name,role) VALUES('history-owner','history-owner','합성 담당자','rep');`)
    await db.exec(await historyLoad('20260910140000_legacy_815_member_history.sql'))
    await db.exec(await historyLoad('20260914052203_legacy_history_leader_review_access.sql'))
    await db.exec(await historyLoad('20260916020038_cplotto_member_history.sql'))
    await db.exec(await historyLoad('20260916020233_validate_cplotto_member_history.sql'))
    for(const site of ['lotto815','cplotto','infolotto','unsupported']) {
      await db.query(`INSERT INTO members(id,user_id,name,phone,assigned_staff_id,meta)
        VALUES($1,$1,'합성 이력 고객',$2,'history-owner',$3)`,
        [historyMemberIds[site],'01017700002',JSON.stringify({source_site:site,legacy_idx:7700002,reco_paused:true})])
    }
  })
  for(const table of historyTables)for(const site of ['lotto815','cplotto'])await addHistory(table,site)
  for(const table of historyTables)await assert.rejects(addHistory(table,'infolotto'),{code:'23514'})
  const previous=await historySnapshot()
  await asOwner(async()=>{
    const extension=await historyLoad('20260916024915_infolotto_member_history.sql')
    const validate=await historyLoad('20260916024918_validate_infolotto_member_history.sql')
    await db.exec(extension)
    assert.deepEqual((await db.query(`SELECT convalidated FROM pg_constraint WHERE conname IN ('legacy_member_memos_source_site_check','legacy_member_sms_source_site_check','legacy_member_wins_source_site_check')`)).rows.map(r=>r.convalidated),[false,false,false])
    await db.exec(validate)
    await db.exec(extension);await db.exec(validate)
    const constraints=(await db.query(`SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname IN ('legacy_member_memos_source_site_check','legacy_member_sms_source_site_check','legacy_member_wins_source_site_check')`)).rows
    assert.equal(constraints.length,3)
    for(const row of constraints){assert.equal(row.convalidated,true);assert.match(row.definition,/lotto815.*cplotto.*infolotto/)}
  })
  assert.deepEqual(await historySnapshot(),previous)
  for(const table of historyTables)await addHistory(table,'infolotto')
  for(const table of historyTables) {
    assert.equal((await db.query(`SELECT count(*) AS n FROM public.${table} WHERE legacy_idx=7700001`)).rows[0].n,3)
    await assert.rejects(addHistory(table,'infolotto'),{code:'23505'})
    await assert.rejects(addHistory(table,'infolotto',{legacy_idx:7700003,member_id:historyMemberIds.cplotto}),{code:'23503'})
    await assert.rejects(addHistory(table,'infolotto',{legacy_idx:7700003,source_user_idx:7700003}),{code:'23503'})
    await assert.rejects(addHistory(table,'unsupported'),{code:'23514'})
  }
})
test('infolotto private history is available to admin/manager/leader and assigned rep only',async()=>{
  for(const role of ['admin','manager','leader','rep']) {
    await asOwner(async()=>{
      await db.query(`SELECT set_config('test.app_role',$1,false),set_config('test.staff_id','history-owner',false)`,[role])
      await db.exec('SET ROLE authenticated')
      for(const [kind,table] of [['memo','legacy_member_memos'],['sms','legacy_member_sms'],['win','legacy_member_wins']]) {
        const result=(await db.query('SELECT public.member_legacy_history_page($1,$2) AS page',[historyMemberIds.infolotto,kind])).rows[0].page
        assert.equal(result.rows.length,1);assert.equal(result.rows[0].source_site,'infolotto')
        await assert.rejects(addHistory(table,'infolotto',{legacy_idx:7700004}),{code:'42501'})
        await assert.rejects(db.query(`UPDATE public.${table} SET import_batch='changed' WHERE source_site='infolotto'`),{code:'42501'})
      }
      await db.exec('RESET ROLE')
    })
  }
  await asOwner(async()=>{
    await db.query(`SELECT set_config('test.app_role','rep',false),set_config('test.staff_id','somebody-else',false)`)
    await db.exec('SET ROLE authenticated')
    for(const kind of ['memo','sms','win'])assert.equal((await db.query('SELECT public.member_legacy_history_page($1,$2) AS page',[historyMemberIds.infolotto,kind])).rows[0].page.rows.length,0)
    await db.exec('RESET ROLE');await db.exec('SET ROLE anon')
    await assert.rejects(db.query('SELECT public.member_legacy_history_page($1,$2)',[historyMemberIds.infolotto,'memo']),{code:'42501'})
    await db.exec('RESET ROLE')
    await assert.rejects(db.exec(`UPDATE members SET meta=meta || '{"source_site":"cplotto"}' WHERE id='history-infolotto'`),{code:'23503'})
    await assert.rejects(db.exec(`DELETE FROM members WHERE id='history-infolotto'`),error=>error?.code==='23503'||error?.code==='23001')
  })
  for(const table of historyTables) {
    await assert.rejects(db.exec(`UPDATE public.${table} SET import_batch='changed' WHERE source_site='infolotto'`),{code:'42501'})
    await assert.rejects(db.exec(`DELETE FROM public.${table} WHERE source_site='infolotto'`),{code:'42501'})
  }
})

test('unknown payment method preserves missing source evidence and cannot masquerade as manual/PG',async()=>{
  const b=batch(),m=member(b),p=payment(b,m,{method:'unknown'})
  p.meta.legacy_payment_method_code='';p.meta.legacy_payment_method_review_required=true
  for(const changed of [
    {...p,method:'manual'}, {...p,method:'pg'},
    {...p,meta:{...p.meta,legacy_payment_method_review_required:false}},
    {...p,meta:{...p.meta,legacy_payment_method_code:'officeCredit'}},
  ])await rejectsUnchanged(b,[m],[changed],undefined,'22023')
  const result=await call(b,[m],[p]);assert.equal(result.payments,1)
  const row=(await db.query('SELECT method,meta FROM payments WHERE id=$1',[p.id])).rows[0]
  assert.equal(row.method,'unknown');assert.equal(row.meta.legacy_payment_method_code,'');assert.equal(row.meta.legacy_payment_method_review_required,true)
  await asOwner(async()=>{
    await db.exec(await historyLoad('20260916025359_legacy_payment_unknown_method.sql'))
    const labels=(await db.query(`SELECT enumlabel FROM pg_enum WHERE enumtypid='public.payment_method'::regtype ORDER BY enumsortorder`)).rows.map(r=>r.enumlabel)
    assert.deepEqual(labels,['bank','manual','pg','unknown'])
  })
})
test('only exact original family record may keep NULL product; no guessed grade or product is created',async()=>{
  const b=batch(),m=member(b);m.meta.legacy_idx=838538
  const p=payment(b,m,{product_id:null,amount:212000})
  Object.assign(p.meta,{legacy_idx:37371,legacy_item_code:'family',legacy_item_name:'패밀리',legacy_item_option_level:'5',
    legacy_exp_month:20,legacy_exp_day:0,legacy_payment_reco_count:10,legacy_item_won:212000})
  for(const change of [{legacy_idx:37372},{legacy_item_name:'guessed-name'},{legacy_item_option_level:'2'},
    {legacy_exp_month:18},{legacy_exp_day:1},{legacy_payment_reco_count:5},{legacy_item_won:0}]) {
    await rejectsUnchanged(b,[m],[{...p,meta:{...p.meta,...change}}],undefined,'22023')
  }
  await rejectsUnchanged(b,[m],[{...p,product_id:'legacy_infolotto_basic'}],undefined,'22023')
  const wrongBasic=payment(b,m,{product_id:null});await rejectsUnchanged(b,[m],[wrongBasic],undefined,'22023')
  const previous=await snapshot()
  assert.equal((await call(b,[m],[p])).payments,1)
  const row=(await db.query('SELECT product_id,amount,meta FROM payments WHERE id=$1',[p.id])).rows[0]
  assert.equal(row.product_id,null);assert.equal(row.amount,212000);assert.deepEqual(row.meta,p.meta)
  const next=await snapshot();assert.deepEqual(next.products,previous.products)
  assert.equal(next.members.find(r=>r.id===m.id).grade,m.grade)
})
test('review product seed adds only three inactive known products, replays safely and never overwrites',async()=>{
  const isolated=new PGlite()
  try {
    await isolated.exec('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)')
    await isolated.exec(schema)
    await isolated.exec(`INSERT INTO products(id,name,price,duration_months,grade_granted,is_active)
      VALUES('existing-product','기존 타 사이트 상품',700,3,'goldp',true),
      ('legacy_infolotto_basic','인포로또 베이직',431900,18,'goldp',false)`)
    const previous=(await isolated.query(`SELECT * FROM products WHERE id='existing-product'`)).rows
    const seed=await historyLoad('20260916025553_infolotto_review_products.sql')
    await isolated.exec(seed)
    const first=(await isolated.query('SELECT * FROM products ORDER BY id')).rows
    await isolated.exec(seed)
    assert.deepEqual((await isolated.query('SELECT * FROM products ORDER BY id')).rows,first)
    assert.deepEqual((await isolated.query(`SELECT * FROM products WHERE id='existing-product'`)).rows,previous)
    const infolotto=first.filter(r=>r.id.startsWith('legacy_infolotto_'))
    assert.equal(infolotto.length,3);assert.ok(infolotto.every(r=>r.is_active===false))
    assert.ok(!first.some(r=>r.id==='legacy_infolotto_family'))
    await isolated.exec(`UPDATE products SET price=999 WHERE id='legacy_infolotto_basic'`)
    const conflict=(await isolated.query('SELECT * FROM products ORDER BY id')).rows
    await assert.rejects(isolated.exec(seed),{code:'23505'})
    assert.deepEqual((await isolated.query('SELECT * FROM products ORDER BY id')).rows,conflict)
  } finally {await isolated.close()}
})
