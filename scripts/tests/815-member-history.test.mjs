// Synthetic, in-memory PostgreSQL only. No credentials, network, or customer rows.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const db = new PGlite()
const load = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const migration = await load('20260910140000_legacy_815_member_history.sql')
const hash = 'a'.repeat(64)
let sequence = 100
async function as(role, id, fn) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id ?? ''])
  await db.exec(`SET ROLE ${role}`)
  try { return await fn() } finally { await db.exec('RESET ROLE') }
}
const users = {admin:1,manager:2,leader:3,rep:4,other:5}
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
  for(const [key,id] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users VALUES ($1)',[uuid(key)])
    await db.query('INSERT INTO staff(id,login_id,name,role,team_id,auth_user_id) VALUES ($1,$1,$1,$2,$3,$4)',
      [key,key==='other'?'rep':key,key==='other'?'t2':'t1',uuid(key)])
  }
  for (const [id,idx,team,staff] of [['m1',1,'t1','rep'],['m2',2,'t2','other'],['m3',3,'t1','manager']])
    await db.query('INSERT INTO members(id,user_id,name,team_id,assigned_staff_id,meta) VALUES ($1,$1,$1,$2,$3,$4)',
      [id,team,staff,JSON.stringify({source_site:'lotto815',legacy_idx:idx,reco_paused:true})])
  await db.exec(migration)
})
after(()=>db.close())
test('replay preserves members, current RLS, and never populates operational queues',async()=>{
  const before=(await db.query('SELECT jsonb_agg(to_jsonb(m)) AS data FROM members m')).rows
  const policy=(await db.query("SELECT qual,with_check FROM pg_policies WHERE tablename='members'")).rows
  await db.exec(migration)
  for(const kind of ['memos','sms','wins']) await as('service_role',null,()=>insert(kind))
  assert.deepEqual((await db.query('SELECT jsonb_agg(to_jsonb(m)) AS data FROM members m')).rows,before)
  assert.deepEqual((await db.query("SELECT qual,with_check FROM pg_policies WHERE tablename='members'")).rows,policy)
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
test('new history narrows wide leader policy; private memo requires actual assignment or admin',async()=>{
  await insert('memos',{legacy_idx:900,source_team_open_yn:'N',source_author_idx:'9007199254740993'})
  await insert('memos',{legacy_idx:901,source_team_open_yn:null})
  for(const kind of ['memos','sms','wins']) await insert(kind,{member_id:'m2',source_user_idx:2})
  for(const kind of ['memo','sms','win']) {
    await as('authenticated',uuid('leader'),async()=>{
      assert.equal((await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n,3)
      assert.equal((await page(kind,'m2')).rows.length,0)
      assert.ok((await page(kind)).rows.length>0)
    })
    await as('authenticated',uuid('rep'),async()=>assert.equal((await page(kind,'m2')).rows.length,0))
  }
  for(const key of ['admin','manager','leader','rep','other']) await as('authenticated',uuid(key),async()=>{
    const ids=(await page('memo')).rows.map(r=>r.legacy_idx)
    assert.equal(ids.includes('900'),['admin','rep'].includes(key))
    assert.equal(ids.includes('901'),['admin','rep'].includes(key))
    if(key==='admin') assert.equal((await page('memo')).rows.find(r=>r.legacy_idx==='900').source_author_idx,'9007199254740993')
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
