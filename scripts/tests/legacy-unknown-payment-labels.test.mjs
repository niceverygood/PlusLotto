// Synthetic in-memory PostgreSQL only; no source archive, customer data, or network.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const load = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const labels = await load('20260916030000_legacy_unknown_payment_labels.sql')
const ids = Object.fromEntries(['admin','manager','leader','rep'].map((role,index)=>[role,`00000000-0000-0000-0000-${String(index+1).padStart(12,'0')}`]))
const sourceSites = ['pluslotto','lotto815','cplotto','infolotto']
const baseline = new Map()
const signatures = ['admin_dashboard(text)','admin_stats_snapshot(text,date,date,text)',
  'admin_revenue(text,date,date,text,text)','admin_revenue_day_payments(date,text,text)']
let rowsBefore, guardsBefore
async function role(name='admin') {
  await db.exec('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[ids[name]??''])
  await db.exec(`SET ROLE ${name==='anon'?'anon':'authenticated'}`)
}
async function rpc(name,args) {return (await db.query(`SELECT public.${name}(${args}) AS result`)).rows[0].result}
const calls = site => [
  ['admin_dashboard',`'${site}'`],
  ['admin_stats_snapshot',`'payment','2026-09-16','2026-09-16','${site}'`],
  ['admin_revenue',`'real','2026-09-16','2026-09-16','pg','${site}'`],
  ['admin_revenue_day_payments',`'2026-09-16','real','${site}'`],
]
async function snapshot() {return (await db.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM members m) AS members,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) AS payments,
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM products p) AS products,
  (SELECT count(*) FROM sms_sends) AS sends,
  (SELECT count(*) FROM assignments) AS assignments`)).rows}
async function guards() {
  return (await db.query(`SELECT oid::regprocedure::text AS signature,prosecdef,proconfig,proacl
    FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY oid::regprocedure::text`,[signatures])).rows
}
before(async()=>{
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;`)
  await db.exec(await load('0001_schema.sql'))
  await db.exec(await load('20260916025359_legacy_payment_unknown_method.sql'))
  await db.exec(`ALTER TABLE members ADD COLUMN consult_status text;
    ALTER TABLE payments ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
    CREATE FUNCTION public.canonical_inflow_type(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT v $$;
    CREATE FUNCTION app_role() RETURNS role LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT role FROM staff WHERE auth_user_id=auth.uid() $$;
    CREATE FUNCTION app_staff_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT id FROM staff WHERE auth_user_id=auth.uid() $$;
    CREATE FUNCTION app_team() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT team_id FROM staff WHERE auth_user_id=auth.uid() $$;
    CREATE FUNCTION app_can_see_member(mid text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS(SELECT 1 FROM members WHERE id=mid AND (app_role() IN ('admin','manager','leader')
        OR (app_role()='rep' AND assigned_staff_id=app_staff_id()))) $$;
    ALTER TABLE members ENABLE ROW LEVEL SECURITY;
    CREATE POLICY members_rw ON members TO authenticated USING(app_role() IN ('admin','manager','leader')
      OR (app_role()='rep' AND assigned_staff_id=app_staff_id()));
    ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY payments_rw ON payments TO authenticated USING(app_can_see_member(member_id));
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;`)
  for(const [name,id] of Object.entries(ids)) {
    await db.query('INSERT INTO auth.users VALUES($1)',[id])
    await db.query('INSERT INTO staff(id,login_id,name,role,auth_user_id) VALUES($1::text,$1::text,$1::text,$1::role,$2::uuid)',[name,id])
  }
  await db.exec(`INSERT INTO staff(id,login_id,name,role) VALUES('other','other','합성 타담당','rep');
    INSERT INTO products(id,name,grade_granted) VALUES('product','합성 기존상품','goldp');
    INSERT INTO members(id,user_id,name,grade,assigned_staff_id,meta) VALUES
      ('native','native','합성 플러스','goldp','rep','{}'),
      ('815','815','합성815','goldp','rep','{"source_site":"lotto815"}'),
      ('cp','cp','합성일행','goldp','rep','{"source_site":"cplotto"}'),
      ('info-own','info-own','합성인포본인','goldp','rep','{"source_site":"infolotto"}'),
      ('info-other','info-other','합성인포타인','goldp','other','{"source_site":"infolotto"}');
    INSERT INTO payments(id,member_id,product_id,amount,method,status,staff_id,paid_at,created_at,meta) VALUES
      ('native-pay','native','product',100,'manual','approved','rep','2026-09-16 09:00:00+09','2026-09-16 09:00:00+09','{}'),
      ('815-pay','815','product',200,'bank','approved','rep','2026-09-16 09:00:00+09','2026-09-16 09:00:00+09','{}'),
      ('cp-pay','cp','product',300,'pg','approved','rep','2026-09-16 09:00:00+09','2026-09-16 09:00:00+09','{}'),
      ('info-own-pay','info-own','product',400,'unknown','approved','rep','2026-09-16 09:00:00+09','2026-09-16 09:00:00+09','{"source_site":"infolotto"}'),
      ('info-zero-pay','info-own','product',0,'unknown','approved','rep','2026-09-16 09:00:00+09','2026-09-16 09:00:00+09','{"source_site":"infolotto"}'),
      ('info-family','info-other',NULL,600,'unknown','approved','other','2026-09-16 09:00:00+09','2026-09-16 09:00:00+09',
        '{"source_site":"infolotto","legacy_item_code":"family","legacy_item_name":"패밀리"}'),
      ('info-manual','info-other','product',700,'manual','approved','other','2026-09-16 09:00:00+09','2026-09-16 09:00:00+09','{"source_site":"infolotto"}');
    INSERT INTO payments(id,member_id,amount,method,status,created_at) VALUES
      ('info-own-wait','info-own',17,'unknown','wait','2026-09-16 09:00:00+09'),
      ('info-other-wait','info-other',23,'unknown','wait','2026-09-16 09:00:00+09');`)
  await db.exec(await readFile(new URL('../sql/admin-site-scope.rollback.sql',import.meta.url),'utf8'))
  await db.exec(await load('20260909001521_admin_site_scope.sql'))
  await role()
  for(const site of sourceSites.slice(0,3)) for(const [name,args] of calls(site)) baseline.set(`${site}/${name}`,await rpc(name,args))
  // The prior fallback mislabels a new enum as manual; this proves the regression target.
  assert.equal((await rpc(...calls('infolotto')[1])).methods.find(r=>r.key==='m:unknown').label,'수기')
  await db.exec('RESET ROLE')
  rowsBefore=await snapshot();guardsBefore=await guards()
  await db.exec(labels)
  await role()
})
after(()=>db.close())
test('unknown is separate from manual in dashboard, stats and revenue with exact totals including zero',async()=>{
  await role()
  const dashboard=await rpc(...calls('infolotto')[0])
  assert.equal(dashboard.kpis.paymentWaitAmount,40)
  assert.equal(dashboard.pendingPayment.length,2)
  assert.ok(dashboard.pendingPayment.every(row=>row.methodLabel==='이전자료 미기재'))
  for(const [name,args] of [calls('infolotto')[1],calls('infolotto')[2]]) {
    const result=await rpc(name,args),breakdown=result.methods??result.breakdown
    assert.equal(result.total??result.summary.total,1700)
    const unknown=breakdown.find(r=>r.key==='m:unknown'),manual=breakdown.find(r=>r.key==='m:manual')
    assert.equal(unknown.label,'이전자료 미기재');assert.equal(unknown.value??unknown.amount,1000);assert.equal(unknown.count,3)
    assert.equal(manual.label,'수기');assert.equal(manual.value??manual.amount,700);assert.equal(manual.count,1)
  }
})
test('NULL-product historical family retains its original name and separate group without inventing a grade',async()=>{
  await role()
  const stats=await rpc(...calls('infolotto')[1])
  const product=stats.products.find(p=>p.key==='infolotto:legacy:family')
  assert.deepEqual(product,{key:'infolotto:legacy:family',label:'패밀리 (이전상품)',value:600,count:1})
  const details=await rpc(...calls('infolotto')[3])
  assert.equal(details.find(p=>p.id==='info-family').productName,'패밀리 (이전상품)')
  assert.equal(details.find(p=>p.id==='info-family').method,'unknown')
  const report=await rpc('admin_revenue',"'real','2026-09-16','2026-09-16','product','infolotto'")
  const family=report.breakdown.find(p=>p.key==='infolotto:legacy:family')
  assert.ok(family);assert.equal(family.label,'패밀리 (이전상품)');assert.equal(family.amount,600)
  assert.equal((await db.query("SELECT product_id FROM payments WHERE id='info-family'")).rows[0].product_id,null)
})
test('known sites preserve prior RPC responses and no site absorbs infolotto amounts',async()=>{
  await role()
  for(const site of sourceSites.slice(0,3)) for(const [name,args] of calls(site)) assert.deepEqual(await rpc(name,args),baseline.get(`${site}/${name}`))
  assert.equal((await rpc('admin_revenue',"'real','2026-09-16','2026-09-16','pg',NULL")).summary.total,2300)
  for(const [name,args] of calls('invalid')) await assert.rejects(rpc(name,args),{code:'22023'})
})
test('rep cannot see another customer through unknown labels or historical product fallback',async()=>{
  await role('rep')
  const dashboard=await rpc(...calls('infolotto')[0])
  assert.equal(dashboard.kpis.paymentWaitAmount,17)
  assert.deepEqual(dashboard.pendingPayment.map(r=>r.id),['info-own-wait'])
  const stats=await rpc(...calls('infolotto')[1])
  assert.equal(stats.total,400);assert.equal(stats.approvedCount,2)
  assert.ok(stats.products.every(p=>p.key!=='infolotto:legacy:family'))
  assert.equal(stats.methods.find(p=>p.key==='m:unknown').label,'이전자료 미기재')
  for(const [name,args] of calls('infolotto').slice(2)) await assert.rejects(rpc(name,args),{code:'42501'})
  for(const name of ['manager','leader']) {
    await role(name)
    assert.equal((await rpc(...calls('infolotto')[1])).total,1700)
    assert.equal((await rpc(...calls('infolotto')[2])).summary.total,1700)
  }
  await role('anon')
  for(const [name,args] of calls('infolotto')) await assert.rejects(rpc(name,args),{code:'42501'})
  await role('unmapped')
  for(const [name,args] of calls('infolotto').slice(2)) await assert.rejects(rpc(name,args),{code:'42501'})
  assert.equal((await rpc(...calls('infolotto')[1])).total,0)
})
test('reapplying labels preserves all rows, queues, function grants and security boundaries',async()=>{
  await db.exec('RESET ROLE');await db.exec(labels)
  assert.deepEqual(await snapshot(),rowsBefore)
  assert.deepEqual(await guards(),guardsBefore)
})
