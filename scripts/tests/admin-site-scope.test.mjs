/**
 * Runs only in an in-memory PostgreSQL instance; cannot connect to production.
 * npm install --prefix /tmp/pluslotto-site-scope-pgtest @electric-sql/pglite@0.5.8
 * PGLITE_MODULE=/tmp/pluslotto-site-scope-pgtest/node_modules/@electric-sql/pglite/dist/index.js \
 *   node --test scripts/tests/admin-site-scope.test.mjs
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'

const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const migration = new URL('../../supabase/migrations/20260909001521_admin_site_scope.sql', import.meta.url)
const rollback = new URL('../sql/admin-site-scope.rollback.sql', import.meta.url)
const smoke = new URL('../sql/verify-admin-site-scope.sql', import.meta.url)
const schema = new URL('../../supabase/migrations/0001_schema.sql', import.meta.url)
const baseline = new Map()
const unscopedCalls = [
  ['admin_dashboard',''],['admin_nav_badges',''],['admin_member_facets',''],['admin_member_search',"'',50"],
  ['admin_members_page',''],['admin_payment_counts',''],['admin_payments_page',''],
  ['admin_revenue',"'real','2026-09-09','2026-09-10'"],['admin_revenue_calendar',"'2026-09-01'"],
  ['admin_revenue_day_payments',"'2026-09-09'"],['admin_stats_snapshot',"'signup','2026-09-09','2026-09-10'"],
  ['admin_consult_report',"'staff','week','2026-09-09','2026-09-10'"],
]
const ids = {
  admin: '00000000-0000-0000-0000-000000000001',
  manager: '00000000-0000-0000-0000-000000000002',
  leader: '00000000-0000-0000-0000-000000000003',
  rep: '00000000-0000-0000-0000-000000000004',
}

async function asRole(role = 'admin') {
  await db.exec('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [ids[role] ?? ''])
  await db.exec(`SET ROLE ${role === 'anon' ? 'anon' : 'authenticated'}`)
}
async function value(sql, params = []) {
  return (await db.query(sql, params)).rows[0].value
}
async function rpc(name, args = '') {
  return value(`SELECT public.${name}(${args}) AS value`)
}

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
  `)
  await db.exec(await readFile(schema, 'utf8'))
  await db.exec(`
    ALTER TABLE members ADD COLUMN consult_status text;
    ALTER TABLE payments ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
    CREATE FUNCTION public.canonical_inflow_type(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT v $$;
    CREATE FUNCTION app_role() RETURNS role LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT role FROM staff WHERE auth_user_id=auth.uid()
    $$;
    CREATE FUNCTION app_staff_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT id FROM staff WHERE auth_user_id=auth.uid()
    $$;
    CREATE FUNCTION app_team() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT team_id FROM staff WHERE auth_user_id=auth.uid()
    $$;
    CREATE FUNCTION app_can_see_member(mid text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
      SELECT EXISTS (SELECT 1 FROM members WHERE id=mid AND (
        app_role() IN ('admin','manager','leader') OR (app_role()='rep' AND assigned_staff_id=app_staff_id())
      ))
    $$;
    ALTER TABLE members ENABLE ROW LEVEL SECURITY;
    CREATE POLICY members_rw ON members TO authenticated USING (
      app_role() IN ('admin','manager','leader') OR (app_role()='rep' AND assigned_staff_id=app_staff_id())
    );
    ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY payments_rw ON payments TO authenticated USING (app_can_see_member(member_id));
    ALTER TABLE logs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY logs_select ON logs FOR SELECT TO authenticated USING (app_role()='admin');
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
    INSERT INTO auth.users SELECT ('00000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid FROM generate_series(1,4) i;
    INSERT INTO staff(id,login_id,name,role,auth_user_id) VALUES
      ('admin','admin','관리자','admin','${ids.admin}'),
      ('manager','manager','실장','manager','${ids.manager}'),
      ('leader','leader','팀장','leader','${ids.leader}'),
      ('rep','rep','담당자','rep','${ids.rep}'),
      ('other','other','다른 담당자','rep',NULL);
    INSERT INTO products(id,name,grade_granted) VALUES ('product','상품','gold');
    INSERT INTO members(id,user_id,name,grade,assigned_staff_id,inflow_code,meta) VALUES
      ('native','native','기존회원','gold','rep','DUP','{}'),
      ('blank','blank','빈출처회원','gold','manager','B','{"source_site":"  "}'),
      ('explicit','explicit','명시플러스회원','gold','rep','C','{"source_site":"pluslotto"}'),
      ('815','815','815회원','gold','rep','DUP','{"source_site":"lotto815"}'),
      ('815other','815other','815타담당회원','gold','other','E','{"source_site":"lotto815"}'),
      ('info','info','인포회원','gold','rep','F','{"source_site":"infolotto"}'),
      ('cp','cp','일행회원','gold','rep','G','{"source_site":"cplotto"}'),
      ('unknown','unknown','알수없는출처','gold','other','H','{"source_site":"futurelotto"}');
    INSERT INTO payments(id,member_id,product_id,amount,method,status,staff_id,paid_at,created_at,meta)
    SELECT 'payment_' || m.id, m.id,'product',v.amount,
      CASE WHEN m.id='815' THEN 'bank'::payment_method ELSE 'pg'::payment_method END,
      'approved',m.assigned_staff_id,
      CASE WHEN m.id='815' THEN NULL ELSE '2026-09-08 15:30:00+00'::timestamptz END,
      '2026-09-08 15:30:00+00','{}'
    FROM members m JOIN (VALUES ('native',100),('blank',200),('explicit',300),('815',400),
      ('815other',500),('info',600),('cp',700),('unknown',800)) v(id,amount) ON m.id=v.id;
    -- Over 1,000 rows prove daily aggregates do not inherit PostgREST row caps.
    INSERT INTO payments(id,member_id,product_id,amount,method,status,staff_id,paid_at,created_at)
    SELECT 'bulk_' || i, '815','product',1,'pg','approved','rep','2026-09-09 01:00:00+00','2026-09-09 01:00:00+00'
    FROM generate_series(1,1005) i;
    INSERT INTO payments(id,member_id,amount,method,status) VALUES
      ('wait_native','native',90,'bank','wait'),('wait_815','815',80,'bank','wait');
    INSERT INTO inquiries(id,member_id,title) VALUES ('q_native','native','질문'),('q_815','815','질문'),('q_orphan',NULL,'질문');
    INSERT INTO logs(id,kind,actor,action,target_id,meta,created_at) VALUES
      ('log_native','admin','rep','member.update','native','{"patch":{"consult_status":"가망"}}','2026-09-09 01:00:00+00'),
      ('log_815','admin','rep','member.update','815','{"patch":{"consult_status":"가망"}}','2026-09-09 01:00:00+00');
  `)
  // The rollback file is the captured production baseline. Install it first to prove
  // default-argument compatibility rather than comparing the new implementation to itself.
  await db.exec(await readFile(rollback, 'utf8'))
  await asRole()
  for (const [name,args] of unscopedCalls) baseline.set(name,await rpc(name,args))
  await db.exec('RESET ROLE')
  await db.exec(await readFile(migration, 'utf8'))
  await db.exec("INSERT INTO daily_work_count(day,head_count) VALUES ('2026-09-09',7),('2026-09-10',8)")
  await asRole()
})
after(async () => db.close())

test('native missing/blank/explicit source and unknown data retain distinct scopes', async () => {
  await asRole()
  for (const [site, count] of [['pluslotto',3],['lotto815',2],['infolotto',1],['cplotto',1]]) {
    const page = await rpc('admin_members_page', `p_filter => '{"sourceSite":"${site}"}'`)
    const facets = await rpc('admin_member_facets', `p_source_site => '${site}'`)
    const search = await rpc('admin_member_search', `p_source_site => '${site}'`)
    assert.equal(page.total, count)
    assert.equal(facets.counts.all, count)
    assert.equal(search.length, count)
  }
  assert.equal((await rpc('admin_members_page')).total, 8)
  assert.deepEqual(await rpc('admin_dashboard'), await rpc('admin_dashboard', 'NULL'))
  assert.equal((await rpc('admin_member_facets')).counts['dup-all'], 2)
  assert.equal((await rpc('admin_members_page', `p_filter => '{"dupInflow":"all","sourceSite":"lotto815"}'`)).total, 0)
  assert.equal((await rpc('admin_member_facets', `p_source_site => 'lotto815'`)).counts['dup-all'], 0)
})

test('all site-sensitive RPCs reject unknown inputs even without matching rows', async () => {
  await asRole()
  const calls = [
    ['admin_dashboard', "'invalid'"], ['admin_nav_badges', "'invalid'"],
    ['admin_member_facets', "NULL,'invalid'"], ['admin_member_search', "'none',20,'invalid'"],
    ['admin_payment_counts', "'invalid'"], ['admin_members_page', `'{"sourceSite":"invalid"}'`],
    ['admin_payments_page', `'{"sourceSite":"invalid"}'`],
    ['admin_revenue', "'real','2026-09-09','2026-09-09','staff','invalid'"],
    ['admin_revenue_calendar', "'2026-09-01','real','invalid'"],
    ['admin_revenue_day_payments', "'2026-09-09','real','invalid'"],
    ['admin_stats_snapshot', "'signup','2026-09-09','2026-09-09','invalid'"],
    ['admin_consult_report', "'staff','week','2026-09-09','2026-09-09','invalid'"],
    ['admin_revenue_daily_summary', "'2026-09-09','2026-09-09','invalid'"],
  ]
  for (const [name,args] of calls) await assert.rejects(rpc(name,args), { code: '22023' })
})

test('payments and summaries follow members even if a new payment has no source metadata', async () => {
  await asRole()
  const page = await rpc('admin_payments_page', `'{"sourceSite":"lotto815"}'`)
  assert.equal(page.total, 1008)
  assert.equal((await rpc('admin_payment_counts', "'lotto815'")).approved, 1007)
  assert.equal((await rpc('admin_payment_counts', "'pluslotto'")).all, 4)
  const dashboard = await rpc('admin_dashboard', "'lotto815'")
  assert.equal(dashboard.kpis.paymentWaitAmount, 80)
  assert.equal(dashboard.kpis.noOutcall, 2)
  assert.deepEqual(await rpc('admin_nav_badges', "'lotto815'"), { support:3, payments:1 })
  assert.deepEqual(await rpc('admin_nav_badges'), { support:3, payments:2 })
})

test('revenue calendar, day details, report and daily summary agree across KST boundary and >1000 rows', async () => {
  await asRole()
  const report = await rpc('admin_revenue', "'real','2026-09-09','2026-09-09','staff','lotto815'")
  const calendar = await rpc('admin_revenue_calendar', "'2026-09-01','real','lotto815'")
  const payments = await rpc('admin_revenue_day_payments', "'2026-09-09','real','lotto815'")
  const daily = await rpc('admin_revenue_daily_summary', "'2026-09-09','2026-09-10','lotto815'")
  assert.equal(report.summary.total, 1905)
  assert.equal(report.summary.count, 1007)
  assert.equal(report.summary.conversions, 2)
  assert.equal(calendar.monthTotal, 1905)
  assert.equal(calendar.monthCount, payments.length)
  assert.equal(payments.reduce((sum,p) => sum+p.amount,0), 1905)
  assert.deepEqual(daily, [{day:'2026-09-09',headCount:0,leaderTotal:1905,managerTotal:0,cardTotal:1505,bankTotal:400,total:1905,count:1007}])
  const all = await rpc('admin_revenue_daily_summary', "'2026-09-09','2026-09-10'")
  assert.equal(all[0].headCount,8)
  assert.equal(all[0].total,0)
  assert.equal(all[1].headCount,7)
  assert.equal(all[1].total,4605)
  assert.equal((await rpc('admin_revenue', "'team','2026-09-09','2026-09-09','staff','pluslotto'")).summary.total,200)
})

test('stats and consultation events respect the chosen site', async () => {
  await asRole()
  const stats = await rpc('admin_stats_snapshot', "'signup','2020-01-01','2030-01-01','lotto815'")
  assert.equal(stats.total,2)
  const consult = await rpc('admin_consult_report', "'staff','week','2026-09-09','2026-09-09','lotto815'")
  assert.equal(consult.reduce((sum,r) => sum+r.total,0),1)
  // Existing payment-stat semantics use paid_at only; source scope does not change recognition rules.
  const paymentStats = await rpc('admin_stats_snapshot', "'payment','2026-09-09','2026-09-09','lotto815'")
  assert.equal(paymentStats.total,1505)
})

test('rep ownership RLS is retained and privileged revenue calls reject rep/anon', async () => {
  await asRole('rep')
  assert.equal((await rpc('admin_members_page', `'{"sourceSite":"lotto815"}'`)).total,1)
  assert.equal((await rpc('admin_payment_counts', "'lotto815'")).all,1007)
  assert.equal((await rpc('admin_dashboard', "'lotto815'")).kpis.noOutcall,1)
  for (const [name,args] of [
    ['admin_revenue', "'real','2026-09-09','2026-09-09'"],
    ['admin_revenue_calendar', "'2026-09-01'"],
    ['admin_revenue_day_payments', "'2026-09-09'"],
    ['admin_revenue_daily_summary', "'2026-09-09','2026-09-09'"],
  ]) await assert.rejects(rpc(name,args),{code:'42501'})
  for (const role of ['manager','leader']) {
    await asRole(role)
    assert.equal((await rpc('admin_revenue', "'real','2026-09-09','2026-09-09','staff','lotto815'")).summary.total,1905)
  }
  await asRole('anon')
  await assert.rejects(rpc('admin_dashboard'),{code:'42501'})
  await assert.rejects(rpc('admin_revenue_daily_summary', "'2026-09-09','2026-09-09'"),{code:'42501'})
  await asRole('unmapped')
  await assert.rejects(rpc('admin_revenue_daily_summary', "'2026-09-09','2026-09-09'"),{code:'42501'})
})

test('migration keeps source rows and creates no ambiguous RPC overloads', async () => {
  await asRole()
  assert.equal(Number(await value('SELECT count(*) AS value FROM members')),8)
  assert.equal(Number(await value('SELECT count(*) AS value FROM payments')),1015)
  const overloads = await db.query(`SELECT proname,count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND proname ~ '^admin_(dashboard|nav_badges|member_facets|member_search|payment_counts|revenue|stats_snapshot|consult_report)'
    GROUP BY proname HAVING count(*)>1`)
  assert.deepEqual(overloads.rows,[])
  const guards = await db.query(`SELECT proname,prosecdef,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND proname IN ('admin_dashboard','admin_revenue','admin_revenue_daily_summary')`)
  assert.equal(guards.rows.find(r=>r.proname==='admin_dashboard').prosecdef,false)
  for (const row of guards.rows.filter(r=>r.proname!=='admin_dashboard')) {
    assert.equal(row.prosecdef,true)
    assert.ok(row.proconfig.includes('search_path=""'))
  }
})

test('unscoped callers retain the captured production response', async () => {
  await asRole()
  for (const [name,args] of unscopedCalls) assert.deepEqual(await rpc(name,args),baseline.get(name),name)
})

test('computed field matches RPC normalization under RLS and inlines for the source index', async () => {
  await asRole()
  const direct = await db.query("SELECT id,public.member_operating_site(m) AS site FROM members m WHERE public.member_operating_site(m)='pluslotto' ORDER BY id")
  assert.deepEqual(direct.rows.map(r=>r.id),['blank','explicit','native'])
  assert.ok(direct.rows.every(r=>r.site==='pluslotto'))
  await db.exec('SET enable_seqscan = off')
  const rows = await db.query("EXPLAIN (FORMAT JSON) SELECT id FROM members m WHERE public.member_operating_site(m)='lotto815'")
  assert.doesNotMatch(JSON.stringify(rows.rows),/member_operating_site\(m/)
  // PostgreSQL can keep non-leakproof JSON/text expressions above an RLS barrier.
  // The index is available for guarded SECURITY DEFINER revenue queries (table owner).
  await db.exec('RESET ROLE')
  const privilegedPlan = await db.query("EXPLAIN (FORMAT JSON) SELECT id FROM members m WHERE public.member_operating_site(m)='lotto815'")
  assert.match(JSON.stringify(privilegedPlan.rows),/members_operating_site_registered_idx/)
  await db.exec('RESET enable_seqscan')
  await asRole('rep')
  assert.equal(Number(await value("SELECT count(*) AS value FROM members m WHERE public.member_operating_site(m)='lotto815'")),1)
})

test('post-deploy smoke script is read-only and rollback restores RPCs without removing workforce data', async () => {
  await db.exec('RESET ROLE')
  await db.exec(await readFile(smoke,'utf8'))
  await db.exec(await readFile(rollback,'utf8'))
  await asRole()
  for (const [name,args] of unscopedCalls) assert.deepEqual(await rpc(name,args),baseline.get(name),name)
  assert.equal(Number(await value('SELECT count(*) AS value FROM daily_work_count')),2)
  assert.equal(Number(await value('SELECT count(*) AS value FROM members')),8)
})
