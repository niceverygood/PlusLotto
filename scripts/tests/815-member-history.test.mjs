// Synthetic, in-memory PostgreSQL only. No credentials, network, or customer rows.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const load = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const migration = await load('20260910140000_legacy_815_member_history.sql')
const reviewAccess = await load('20260914052203_legacy_history_leader_review_access.sql')
const cplottoHistory = await load('20260916020038_cplotto_member_history.sql')
const validateCplottoHistory = await load('20260916020233_validate_cplotto_member_history.sql')
const hash = 'a'.repeat(64)
let sequence = 100
async function as(role, id, fn) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id ?? ''])
  await db.exec(`SET ROLE ${role}`)
  try { return await fn() } finally { await db.exec('RESET ROLE') }
}
const users = {admin:1,manager:2,leader:3,rep:4,other:5,leaderNoTeam:6,noStaff:7}
const uuid = key => `00000000-0000-0000-0000-${String(users[key]).padStart(12,'0')}`
async function insert(table, overrides={}) {
  const common = {source_site:'lotto815',legacy_idx:++sequence,source_user_idx:1,member_id:'m1',
    archive_sha256:hash,prepared_record_sha256:hash,import_batch:'synthetic-815',source_insert_datetime:'2026-08-31 18:01:02'}
  const fields = {memos:{body:'synthetic memo',source_team_open_yn:'Y'},
    sms:{contents_type:'autoPick',body_policy:'body_preserved',body:'synthetic recommendation'},
    wins:{round_no:1000,source_pick_string:'1|2|3|4|5|6',numbers:[1,2,3,4,5,6],rank:5,prize:5000}}
  const row={...common,...fields[table],...overrides}
  await db.query(`INSERT INTO public.legacy_member_${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row))
  return row
}
async function page(kind, member='m1',limit=50,cursor=null) {
  return (await db.query('SELECT public.member_legacy_history_page($1,$2,$3,$4,$5,$6) AS result',
    [member,kind,limit,cursor?.at ?? null,cursor?.idx ?? null,cursor?.round ?? null])).rows[0].result
}
before(async()=>{
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,service_role;`)
  await db.exec(await load('0001_schema.sql'))
  // Actual helpers and default grants, with the current widened members policy from 0016.
  await db.exec(await load('0002_rls.sql'))
  const perf=await load('0016_admin_read_performance.sql')
  await db.exec(perf.slice(perf.indexOf('drop policy if exists members_rw'),perf.indexOf('create or replace function app_can_see_member')))
  const sites=await load('20260909001521_admin_site_scope.sql')
  await db.exec(sites.slice(sites.indexOf('CREATE OR REPLACE FUNCTION public.member_operating_site'),sites.indexOf('CREATE INDEX IF NOT EXISTS members_operating_site')))
  await db.exec('GRANT SELECT,UPDATE ON public.members TO service_role;')
  await db.exec("INSERT INTO teams(id,name) VALUES ('t1','Team 1'),('t2','Team 2')")
  for(const key of Object.keys(users)) {
    await db.query('INSERT INTO auth.users VALUES ($1)',[uuid(key)])
    if(key==='noStaff') continue
    await db.query('INSERT INTO staff(id,login_id,name,role,team_id,auth_user_id) VALUES ($1,$1,$1,$2,$3,$4)',
      [key,key==='other'?'rep':key==='leaderNoTeam'?'leader':key,key==='leaderNoTeam'?null:key==='other'?'t2':'t1',uuid(key)])
  }
  for (const [id,idx,team,staff] of [['m1',1,'t1','rep'],['m2',2,'t2','other'],['m3',3,'t1','manager'],['m4',4,null,'admin']])
    await db.query('INSERT INTO members(id,user_id,name,team_id,assigned_staff_id,meta) VALUES ($1,$1,$1,$2,$3,$4)',
      [id,team,staff,JSON.stringify({source_site:'lotto815',legacy_idx:idx,reco_paused:true})])
  await db.exec(migration)
  await db.exec(reviewAccess)
})
after(()=>db.close())
test('replay preserves members, current RLS, and never populates operational queues',async()=>{
  const before=(await db.query('SELECT jsonb_agg(to_jsonb(m)) AS data FROM members m')).rows
  const policy=(await db.query("SELECT qual,with_check FROM pg_policies WHERE tablename='members'")).rows
  const historyPolicies=(await db.query("SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE tablename IN ('legacy_member_memos','legacy_member_sms','legacy_member_wins') ORDER BY tablename,policyname")).rows
  await db.exec(migration)
  await db.exec(reviewAccess)
  await db.exec(reviewAccess)
  for(const kind of ['memos','sms','wins']) await as('service_role',null,()=>insert(kind))
  assert.deepEqual((await db.query('SELECT jsonb_agg(to_jsonb(m)) AS data FROM members m')).rows,before)
  assert.deepEqual((await db.query("SELECT qual,with_check FROM pg_policies WHERE tablename='members'")).rows,policy)
  assert.deepEqual((await db.query("SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE tablename IN ('legacy_member_memos','legacy_member_sms','legacy_member_wins') ORDER BY tablename,policyname")).rows,historyPolicies)
  for(const table of ['sms_sends','bets','assignments'])
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0)
})
test('authenticated and anon cannot mutate; service is insert-only',async()=>{
  for(const table of ['memos','sms','wins']) {
    for(const role of ['anon','authenticated']) await as(role,uuid('admin'),async()=>{
      await assert.rejects(insert(table),{code:'42501'})
      for(const sql of [`UPDATE legacy_member_${table} SET import_batch='other'`,`DELETE FROM legacy_member_${table}`,`TRUNCATE legacy_member_${table}`])
        await assert.rejects(db.exec(sql),{code:'42501'})
    })
    await as('service_role',null,async()=>{
      await assert.rejects(db.exec(`UPDATE legacy_member_${table} SET import_batch='other'`),{code:'42501'})
      await assert.rejects(db.exec(`DELETE FROM legacy_member_${table}`),{code:'42501'})
    })
  }
  await as('anon',null,()=>assert.rejects(page('sms'),{code:'42501'}))
})
test('member source, source key, and composite win key are enforced',async()=>{
  for(const table of ['memos','sms','wins']) {
    for(const overrides of [{member_id:'missing'},{source_user_idx:99},{source_site:'infolotto'}])
      await as('service_role',null,()=>assert.rejects(insert(table,overrides),{code:'23503'}))
    const row=await insert(table)
    await assert.rejects(insert(table,row),{code:'23505'})
    if(table==='wins') await insert(table,{...row,round_no:1001})
  }
})
test('source mutation is blocked while ordinary member updates remain valid',async()=>{
  await as('authenticated',uuid('rep'),async()=>{
    await db.exec("UPDATE members SET name='updated',memo='normal',status='suspended',meta=meta||'{\"unrelated\":true}' WHERE id='m1'")
    await assert.rejects(db.exec("UPDATE members SET meta=meta||'{\"legacy_idx\":99}' WHERE id='m1'"),{code:'23503'})
    await assert.rejects(db.exec("UPDATE members SET meta=meta||'{\"source_site\":\"pluslotto\"}' WHERE id='m1'"),{code:'23503'})
  })
  await db.exec("UPDATE members SET meta=meta||'{\"legacy_idx\":30}' WHERE id='m3'")
  await db.exec("UPDATE members SET meta=meta||'{\"legacy_idx\":3}' WHERE id='m3'")
  await assert.rejects(db.exec("DELETE FROM members WHERE id='m1'"),{code:'23001'})
})
test('reviewers see all history across teams including private memos; reps remain assigned-only',async()=>{
  await insert('memos',{legacy_idx:900,source_team_open_yn:'N',source_author_idx:'9007199254740993'})
  await insert('memos',{legacy_idx:901,source_team_open_yn:null})
  for(const [member_id,source_user_idx] of [['m2',2],['m3',3],['m4',4]])
    for(const kind of ['memos','sms','wins']) await insert(kind,{member_id,source_user_idx})
  for(const key of ['admin','manager','leader','leaderNoTeam']) {
    await as('authenticated',uuid(key),async()=>{
      assert.equal((await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n,4)
      for(const kind of ['memo','sms','win'])
        for(const member of ['m1','m2','m3','m4']) assert.ok((await page(kind,member)).rows.length>0,`${key}/${kind}/${member}`)
      for(const table of ['memos','sms','wins'])
        assert.equal((await db.query(`SELECT count(DISTINCT member_id)::int AS n FROM legacy_member_${table}`)).rows[0].n,4)
    })
  }
  for(const key of ['admin','manager','leader','leaderNoTeam','rep','other']) await as('authenticated',uuid(key),async()=>{
    const ids=(await page('memo')).rows.map(r=>r.legacy_idx)
    assert.equal(ids.includes('900'),key!=='other')
    assert.equal(ids.includes('901'),key!=='other')
    if(key==='admin') assert.equal((await page('memo')).rows.find(r=>r.legacy_idx==='900').source_author_idx,'9007199254740993')
  })
  for(const [key,own] of [['rep','m1'],['other','m2']]) await as('authenticated',uuid(key),async()=>{
    for(const kind of ['memo','sms','win']) {
      assert.ok((await page(kind,own)).rows.length>0)
      for(const member of ['m1','m2','m3','m4'].filter(id=>id!==own)) assert.equal((await page(kind,member)).rows.length,0)
    }
    for(const table of ['memos','sms','wins'])
      assert.deepEqual((await db.query(`SELECT DISTINCT member_id FROM legacy_member_${table}`)).rows,[{member_id:own}])
  })
})
test('anonymous and authenticated callers without a staff mapping cannot read history',async()=>{
  for(const kind of ['memo','sms','win']) {
    await as('anon',null,()=>assert.rejects(page(kind),{code:'42501'}))
    for(const id of [null,uuid('noStaff')]) await as('authenticated',id,async()=>{
      assert.equal((await page(kind)).rows.length,0)
      assert.equal((await page(kind,'m4')).rows.length,0)
    })
  }
  await as('authenticated',uuid('noStaff'),async()=>{
    for(const table of ['memos','sms','wins'])
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM legacy_member_${table}`)).rows[0].n,0)
  })
})
test('invalid dates retain raw text without inventing today or timezone',async()=>{
  for(const [value,expected] of [['2024-02-29 18:01:02','2024-02-29 18:01:02'],['2025-02-29 18:01:02',null],['2025-01-01 24:00:00',null],['2025-01-01 23:59:60',null],['0000-00-00 00:00:00',null],['',null],[null,null]]) {
    const r=(await db.query('SELECT legacy_815_source_datetime($1)::text AS result',[value])).rows[0].result
    assert.equal(r,expected)
  }
})
test('unsafe SMS bodies and malformed numbers fail while omitted SMS metadata passes',async()=>{
  for(const values of [{contents_type:'userPwModify'}, {body:'password = secret'}, {body_policy:'unreviewed_type_omitted'}])
    await assert.rejects(insert('sms',values),{code:'23514'})
  await insert('sms',{contents_type:'admin',body_policy:'unreviewed_type_omitted',body:null})
  for(const numbers of [[],[1,1,3,4,5,6],[0,2,3,4,5,6],[1,2,3,4,5,46],[1,2,3,4,5,null]])
    await assert.rejects(insert('wins',{numbers}),{code:'23514'})
})
test('keyset pages preserve ties, null dates, composite keys, and large integer strings',async()=>{
  await insert('wins',{legacy_idx:'9007199254740993',source_insert_datetime:'0000-00-00 00:00:00'})
  await insert('wins',{legacy_idx:'9007199254740993',round_no:1002,source_insert_datetime:'0000-00-00 00:00:00'})
  await as('authenticated',uuid('admin'),async()=>{
    const seen=[];let cursor=null
    do {const p=await page('win','m1',2,cursor);seen.push(...p.rows.map(r=>`${r.legacy_idx}/${r.round_no}`));cursor=p.next_cursor} while(cursor)
    assert.equal(new Set(seen).size,seen.length)
    assert.ok(seen.includes('9007199254740993/1002'))
    const all=await page('win');assert.equal(all.rows.length,seen.length)
    assert.ok(all.rows.every(r=>typeof r.prize==='string' && typeof r.legacy_idx==='string'))
    for(const [kind,limit,cursor] of [[null,50,null],['bad',50,null],['win',0,null],['win',101,null],['win',1,{at:'2026-01-01',idx:'1',round:0}]])
      await assert.rejects(page(kind,'m1',limit,cursor),{code:'22023'})
  })
})
test('page index exists and read functions retain invoker boundaries',async()=>{
  for(const table of ['memos','sms','wins']) {
    const index=(await db.query('SELECT indexdef FROM pg_indexes WHERE indexname=$1',[`legacy_member_${table}_page_idx`])).rows[0].indexdef
    assert.match(index,/member_id.*COALESCE.*legacy_idx DESC/)
    assert.match((await db.query('SELECT indexdef FROM pg_indexes WHERE indexname=$1',[`legacy_member_${table}_import_batch_idx`])).rows[0].indexdef,/USING btree \(import_batch\)/)
  }
  const funcs=(await db.query("SELECT proname,prosecdef,proconfig FROM pg_proc WHERE proname IN ('member_legacy_history_page','legacy_history_check_member_source','legacy_history_preserve_member_identity')")).rows
  for(const f of funcs) {assert.equal(f.prosecdef,f.proname==='legacy_history_preserve_member_identity');assert.ok(f.proconfig.includes('search_path=""'))}
})

test('repeatable read preserves ordinary edits and refuses identity mutations with stale snapshots',async()=>{
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ')
  await db.exec("UPDATE members SET meta=meta||'{\"ordinary\":true}' WHERE id='m1'")
  await db.exec('COMMIT')
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ')
  await assert.rejects(db.exec("UPDATE members SET meta=meta||'{\"legacy_idx\":999}' WHERE id='m3'"),{code:'40001'})
  await db.exec('ROLLBACK')
})

test('cplotto extension preserves existing 815 rows, policies, grants, functions, and queues',async()=>{
  const state=async()=> (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM members m) AS members,
    (SELECT jsonb_agg(to_jsonb(h) ORDER BY source_site,legacy_idx) FROM legacy_member_memos h) AS memos,
    (SELECT jsonb_agg(to_jsonb(h) ORDER BY source_site,legacy_idx) FROM legacy_member_sms h) AS sms,
    (SELECT jsonb_agg(to_jsonb(h) ORDER BY source_site,legacy_idx,round_no) FROM legacy_member_wins h) AS wins,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p
      WHERE tablename LIKE 'legacy_member_%') AS policies,
    (SELECT jsonb_agg(to_jsonb(g) ORDER BY grantee,table_name,privilege_type) FROM information_schema.role_table_grants g
      WHERE table_name LIKE 'legacy_member_%') AS grants,
    (SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY proname) FROM pg_proc
      WHERE proname IN ('member_legacy_history_page','legacy_history_check_member_source','legacy_history_preserve_member_identity')) AS functions,
    (SELECT count(*) FROM sms_sends) AS queue_count,
    (SELECT count(*) FROM bets) AS bets_count`).then(r=>r.rows[0]))
  const before=await state()
  await db.exec(cplottoHistory)
  assert.deepEqual((await db.query(`SELECT convalidated FROM pg_constraint
    WHERE conname IN ('legacy_member_memos_source_site_check','legacy_member_sms_source_site_check','legacy_member_wins_source_site_check')`)).rows,
    [{convalidated:false},{convalidated:false},{convalidated:false}])
  await db.exec(validateCplottoHistory)
  await db.exec(cplottoHistory)
  await db.exec(validateCplottoHistory)
  assert.deepEqual(await state(),before)
  const constraints=(await db.query(`SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conname IN ('legacy_member_memos_source_site_check','legacy_member_sms_source_site_check','legacy_member_wins_source_site_check')`)).rows
  assert.equal(constraints.length,3)
  for(const constraint of constraints) {
    assert.equal(constraint.convalidated,true)
    assert.match(constraint.definition,/lotto815.*cplotto/)
  }
})

test('cplotto history has independent source keys and preserves all role boundaries',async()=>{
  for(const [id,idx,staff,site] of [['cp1',1,'rep','cplotto'],['cp2',2,'other','cplotto'],['cp3',3,'admin','cplotto'],['unsupported',1,'rep','infolotto']]) {
    await db.query('INSERT INTO members(id,user_id,name,assigned_staff_id,meta) VALUES ($1,$1,$1,$2,$3)',
      [id,staff,JSON.stringify({source_site:site,legacy_idx:idx,reco_paused:true})])
  }
  for(const table of ['memos','sms','wins']) {
    const sharedKey={legacy_idx:888888,source_user_idx:1}
    await as('service_role',null,()=>insert(table,sharedKey))
    const cp=await as('service_role',null,()=>insert(table,{...sharedKey,source_site:'cplotto',member_id:'cp1',...(table==='memos'?{source_team_open_yn:'N'}:{})}))
    await as('service_role',null,()=>assert.rejects(insert(table,cp),{code:'23505'}))
    for(const [member_id,source_user_idx] of [['cp2',2],['cp3',3]])
      await as('service_role',null,()=>insert(table,{source_site:'cplotto',member_id,source_user_idx}))
    for(const overrides of [{source_site:'cplotto',member_id:'m1'}, {source_site:'lotto815',member_id:'cp1'},
      {source_site:'cplotto',member_id:'cp1',source_user_idx:2}])
      await as('service_role',null,()=>assert.rejects(insert(table,overrides),{code:'23503'}))
    await as('service_role',null,()=>assert.rejects(insert(table,{source_site:'infolotto',member_id:'unsupported'}),{code:'23514'}))
    for(const role of ['anon','authenticated'])
      await as(role,role==='authenticated'?uuid('admin'):null,()=>assert.rejects(insert(table,{source_site:'cplotto',member_id:'cp1'}),{code:'42501'}))
  }
  for(const key of ['admin','manager','leader','leaderNoTeam']) await as('authenticated',uuid(key),async()=>{
    for(const kind of ['memo','sms','win']) for(const member of ['cp1','cp2','cp3']) {
      const result=await page(kind,member)
      assert.ok(result.rows.length>0,`${key}/${kind}/${member}`)
      assert.ok(result.rows.every(row=>row.source_site==='cplotto'))
    }
  })
  for(const [key,own,other] of [['rep','cp1','cp2'],['other','cp2','cp1']]) await as('authenticated',uuid(key),async()=>{
    for(const kind of ['memo','sms','win']) {
      assert.ok((await page(kind,own)).rows.length>0)
      assert.equal((await page(kind,other)).rows.length,0)
      assert.equal((await page(kind,'cp3')).rows.length,0)
    }
  })
  for(const kind of ['memo','sms','win']) {
    await as('anon',null,()=>assert.rejects(page(kind,'cp1'),{code:'42501'}))
    await as('authenticated',uuid('noStaff'),async()=>assert.equal((await page(kind,'cp1')).rows.length,0))
  }
  await assert.rejects(db.exec("UPDATE members SET meta=meta||'{\"source_site\":\"lotto815\"}' WHERE id='cp1'"),{code:'23503'})
  await assert.rejects(db.exec("DELETE FROM members WHERE id='cp1'"),{code:'23001'})
})
