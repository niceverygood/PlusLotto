// Synthetic local Postgres: no credentials, customer data, network or SMS.
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite')
const dataDir = await mkdtemp(join(tmpdir(),'lotto-sync-pglite-'))
let db = new PGlite(dataDir)
const migration = await readFile(new URL('../../supabase/migrations/20261003135703_durable_lotto_sync.sql',import.meta.url),'utf8')
const schema = await readFile(new URL('../../supabase/migrations/0001_schema.sql',import.meta.url),'utf8')
const uid='10000000-0000-0000-0000-000000000001'
const numbers=[1,13,18,26,34,38]
let serial=100
let expected
async function owner(fn) { await db.exec('RESET ROLE'); try { return await fn() } finally { await db.exec('SET ROLE service_role') } }
async function rpc(name,args=[],values=[]) { return (await db.query(`SELECT public.${name}(${args.join(',')}) result`,values)).rows[0].result }
function round(n) { return {round_no:n,draw_date:new Date(Date.UTC(2002,11,7)+(n-1)*604800000).toISOString(),numbers,bonus:25,prize_1:1600000000,prize_2:60000000,prize_3:1200000,total_sales:123000000000} }
async function start(n,q=false) { return rpc('lotto_sync_start',['$1::jsonb','$2'],[JSON.stringify(round(n)),q]) }
async function batch(n=100) { return rpc('lotto_sync_batch',['$1'],[n]) }
async function member(id,n,sets=[numbers],meta={}) {
 await db.query(`INSERT INTO public.members(id,user_id,name,phone,grade,meta) VALUES($1,$1,'합성회원','01000000000','goldp',$2::jsonb)`,[id,JSON.stringify({weekly_recos:[{round_no:n,sets}],...meta})])
}
async function getMember(id) { return (await db.query('SELECT meta,win_history FROM public.members WHERE id=$1',[id])).rows[0] }
async function drain() { for(let i=0;i<50;i++) {const b=await batch(); if(b.status==='idle')return; if(!b.ok)throw Error(JSON.stringify(b))} throw Error('not drained') }
async function admin(fn,role='admin') { return owner(async()=>{await db.query('UPDATE public.staff SET role=$1::public.role,is_active=true',[role]); await db.exec(`SET request.jwt.claim.sub='${uid}'; SET ROLE authenticated`); try{return await fn()}finally{await db.exec('RESET ROLE; RESET request.jwt.claim.sub')}}) }
before(async()=>{
 await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 GRANT USAGE ON SCHEMA public,auth TO service_role,anon,authenticated;`)
 await db.exec(schema)
 await db.exec(`ALTER TABLE public.site_settings ADD COLUMN win_sms jsonb;
 INSERT INTO auth.users VALUES('${uid}'); INSERT INTO public.staff(id,login_id,name,role,auth_user_id) VALUES('staff','staff','검수','admin','${uid}');
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;
 INSERT INTO public.site_settings(id,sms,win_sms,win_messages) VALUES(1,'{"oneshot_enabled":true,"sender_no":"0200000000"}','{"enabled":true,"paid":true,"free":false,"ranks":[1,2,3,4,5]}','[{"rank":1,"body":"합성 당첨안내"}]');`)
 await db.exec(migration)
 await db.exec('SET ROLE service_role')
 expected=(await db.query('SELECT lotto_sync_private.expected_round() n')).rows[0].n
})
after(async()=>{await db.close(); await rm(dataDir,{recursive:true,force:true})})

test('service-only mutations and active admin/manager read health; no PII',async()=>{
 const h=await rpc('lotto_sync_health');assert.equal(h.schema_version,1);assert.equal(h.expected_round,expected);assert.equal(h.max_round,0);assert.equal(h.jobs.length,0)
 for(const role of ['anon','authenticated']) await owner(async()=>{
  await db.exec(`SET ROLE ${role}`)
  await assert.rejects(start(1),{code:'42501'}); await assert.rejects(batch(),{code:'42501'}); await assert.rejects(rpc('lotto_sync_claim_sms'),{code:'42501'});await assert.rejects(rpc('lotto_sync_health'),{code:'42501'});
  await assert.rejects(db.query('SELECT * FROM public.lotto_sync_work'),{code:'42501'})
 })
 for(const r of ['admin','manager']) assert.equal((await admin(()=>rpc('lotto_sync_health'),r)).schema_version,1)
 await admin(async()=>{ await assert.rejects(rpc('lotto_sync_health'),{code:'42501'});await assert.rejects(rpc('lotto_sync_request_recount',['1']),{code:'42501'}) },'rep')
 await owner(async()=>{await db.exec(`UPDATE public.staff SET role='admin',is_active=false; SET request.jwt.claim.sub='${uid}'; SET ROLE authenticated`);await assert.rejects(rpc('lotto_sync_health'),{code:'42501'});await db.exec('RESET ROLE; RESET request.jwt.claim.sub')})
})

test('invalid official balls/date/prize are rejected before round writes',async()=>{
 for(const patch of [{numbers:[1,1,2,3,4,5]},{bonus:1},{draw_date:'2002-12-08T00:00:00Z'},{prize_1:-1},{round_no:expected+1}]) await assert.rejects(rpc('lotto_sync_start',['$1::jsonb'],[JSON.stringify({...round(1),...patch})]),{code:'22023'})
 assert.equal((await db.query('SELECT count(*)::int n FROM public.lotto_rounds')).rows[0].n,0)
})

test('existing1244 is never automatically reopened or queued for SMS',async()=>{
 await db.query(`INSERT INTO public.lotto_rounds(round_no,draw_date,numbers,bonus,prize_1,prize_2,prize_3,total_sales,confirmed_at) VALUES(1244,$1,$2,25,1600000000,60000000,1200000,123000000000,now())`,[round(1244).draw_date,numbers])
 const before=(await db.query('SELECT * FROM public.lotto_rounds WHERE round_no=1244')).rows[0]
 assert.deepEqual(await start(1244,true),{ok:true,created:false,round_no:1244,status:'existing'})
 assert.deepEqual((await db.query('SELECT * FROM public.lotto_rounds WHERE round_no=1244')).rows[0],before)
 assert.equal((await db.query('SELECT count(*)::int n FROM public.lotto_sync_jobs')).rows[0].n,0)
 await assert.rejects(rpc('lotto_sync_start',['$1::jsonb'],[JSON.stringify({...round(1244),numbers:[2,13,18,26,34,38]})]),{code:'23505'})
})

test('stable snapshot, first issue semantics, restart, metadata merge, complete after final batch',async()=>{
 const n=++serial
 await member('a',n,[numbers,[1,13,18,26,34,25],[1,13,18,26,34,40],[1,13,18,26,41,42],[1,13,18,41,42,43]],{reco_paused:true,reco_pause_reason:'legacy_import_review',win_records:[{round_no:n+1,source:'reco',combo_index:1,rank:4,prize:50000},{custom:'preserved'},null,{rank:5}]})
 await member('b',n,[[2,3,4,5,6,7]])
 await db.query(`UPDATE public.members SET meta=jsonb_set(meta,'{weekly_recos}',meta->'weekly_recos'||$1::jsonb) WHERE id='a'`,[JSON.stringify([{round_no:n,sets:[[1,1,1,1,1,1]]}])])
 await start(n,true)
 assert.equal((await db.query('SELECT confirmed_at FROM public.lotto_rounds WHERE round_no=$1',[n])).rows[0].confirmed_at,null)
 await member('late',n)
 await db.query(`UPDATE public.members SET meta=meta||'{"staff_edit":"kept","win_sms_rounds":[99]}',win_history=$1 WHERE id='a'`,[`${n+1}회 4등`])
 const first=await batch(1);assert.equal(first.status,'running');assert.equal(first.remaining,1)
 await writeFile('/tmp/pluslotto-durable-health-contract.json',JSON.stringify(await rpc('lotto_sync_health')), {mode:0o600})
 assert.equal((await getMember('a')).win_history,`${n+1}회 4등`)
 const m=(await getMember('a')).meta;assert.equal(m.staff_edit,'kept');assert.equal(m.reco_paused,true);assert.deepEqual(m.win_sms_rounds,[99]);assert.ok(m.win_records.some(e=>e?.custom==='preserved'));assert.equal(m.win_records.filter(e=>e?.round_no===n).length,5)
 assert.equal((await start(n)).created,false)
 await db.close(); db=new PGlite(dataDir); await db.exec('SET ROLE service_role')
 const last=await batch(1);assert.equal(last.status,'complete');assert.equal(last.winners,1)
 await writeFile('/tmp/pluslotto-durable-health-complete-contract.json',JSON.stringify(await rpc('lotto_sync_health')), {mode:0o600})
 assert.ok((await db.query('SELECT confirmed_at FROM public.lotto_rounds WHERE round_no=$1',[n])).rows[0].confirmed_at)
 assert.equal((await batch()).status,'idle');assert.equal((await getMember('late')).win_history,null)
 const h=await rpc('lotto_sync_health');assert.deepEqual(h.jobs.find(j=>j.round_no===n).rank_counts,{'1':1,'2':1,'3':1,'4':1,'5':1});assert.equal(h.sms.pending,0)
})

test('invalid nonwinner rolls entire batch back then resumes after exact snapshot repair',async()=>{
 const n=++serial
 await member('rollback_a',n);await member('rollback_b',n,[[2,2,3,4,5,6]])
 await start(n)
 const before=await getMember('rollback_a')
 const b=await batch();assert.equal(b.ok,false);assert.equal(b.error,'RECO_INVALID');assert.equal(b.processed,0)
 assert.deepEqual(await getMember('rollback_a'),before)
 assert.equal((await db.query('SELECT done,status FROM public.lotto_sync_jobs WHERE round_no=$1',[n])).rows[0].done,0)
 assert.equal((await db.query('SELECT count(*)::int n FROM public.lotto_sync_work WHERE round_no=$1 AND done',[n])).rows[0].n,0)
 await db.query(`UPDATE public.lotto_sync_work SET issue=$1::jsonb WHERE round_no=$2 AND target_id='rollback_b'`,[JSON.stringify({round_no:n,sets:[[2,3,4,5,6,7]]}),n])
 const done=await batch();assert.equal(done.status,'complete');assert.equal(done.winners,1)
})

test('explicit manager recount includes bets and removes only this round reco records with no SMS',async()=>{
 const n=1244
 await member('recount',n,[numbers],{win_records:[{round_no:n,source:'reco',combo_index:1,rank:5},{round_no:n,source:'bet',combo_index:1,rank:4},{round_no:100,source:'reco',combo_index:1,rank:5}],reco_paused:true})
 await db.query(`INSERT INTO public.bets(id,round_no,numbers) VALUES('bet',1244,$1)`,[numbers])
 await admin(()=>rpc('lotto_sync_request_recount',['$1'],[n]),'manager')
 const b=await batch();assert.equal(b.status,'complete');assert.equal(b.winners,1)
 const bet=(await db.query(`SELECT rank,prize FROM public.bets WHERE id='bet'`)).rows[0];assert.equal(bet.rank,1);assert.equal(Number(bet.prize),1600000000)
})

test('tick success/failure remains observable and sanitized',async()=>{
 await rpc('lotto_sync_record_tick',['false',"'FETCH_FAIL customer@secret'"])
 let h=await rpc('lotto_sync_health');assert.equal(h.last_error,'FETCH_FAILcustomersecret');assert.ok(h.last_attempt_at)
 await rpc('lotto_sync_record_tick',['true'])
 h=await rpc('lotto_sync_health');assert.equal(h.last_error,null);assert.ok(h.last_success_at)
 assert.ok(!JSON.stringify(h).includes('01000000000'));assert.ok(!JSON.stringify(h).includes('합성회원'))
})

test('manual repeated recount deduplicates, replaces nonwins, preserves other records and holds',async()=>{
 await admin(()=>rpc('lotto_sync_request_recount',['1244']))
 assert.equal((await admin(()=>rpc('lotto_sync_request_recount',['1244']))).status,'pending')
 await batch()
 let m=await getMember('recount');assert.equal(m.meta.win_records.filter(e=>e.round_no===1244&&e.source==='reco').length,1)
 await db.query(`UPDATE public.members SET meta=jsonb_set(meta,'{weekly_recos}',$1::jsonb) WHERE id='recount'`,[JSON.stringify([{round_no:1244,sets:[[2,3,4,5,6,7]]}])])
 await admin(()=>rpc('lotto_sync_request_recount',['1244']))
 await batch()
 m=await getMember('recount');assert.equal(m.meta.win_records.filter(e=>e.round_no===1244&&e.source==='reco').length,0)
 assert.equal(m.meta.win_records.filter(e=>e.source==='bet').length,1);assert.equal(m.meta.win_records.filter(e=>e.round_no===100).length,1);assert.equal(m.meta.reco_paused,true)
 assert.equal((await db.query(`SELECT count(*)::int n FROM public.lotto_sync_sms_outbox WHERE round_no=1244`)).rows[0].n,0)
})

test('invalid bet rolls back work and remains unconfirmed until reviewed correction',async()=>{
 await db.query(`UPDATE public.bets SET numbers=ARRAY[1,1,2,3,4,5] WHERE id='bet'`)
 await admin(()=>rpc('lotto_sync_request_recount',['1244']))
 const bad=await batch();assert.equal(bad.status,'blocked');assert.equal(bad.error,'BET_INVALID')
 assert.equal((await db.query('SELECT confirmed_at FROM public.lotto_rounds WHERE round_no=1244')).rows[0].confirmed_at,null)
 await db.query(`UPDATE public.bets SET numbers=$1 WHERE id='bet'`,[numbers])
 assert.equal((await batch()).status,'complete')
})

test('health includes old blocked jobs even with more than20 new complete jobs',async()=>{
 const n=++serial
 await member('old_blocked',n,[[1,1,2,3,4,5]])
 await start(n);assert.equal((await batch()).status,'blocked')
 // Synthetic complete jobs stand for old history; production migration creates none.
 for(let i=500;i<522;i++){await start(i);await db.query(`UPDATE public.lotto_sync_jobs SET status='complete' WHERE round_no=$1`,[i])}
 const h=await rpc('lotto_sync_health');assert.equal(h.jobs.find(j=>j.round_no===n).status,'blocked');assert.ok(h.jobs.length>=21)
 await db.query(`UPDATE public.lotto_sync_work SET issue=$1::jsonb WHERE round_no=$2 AND target_id='old_blocked'`,[JSON.stringify({round_no:n,sets:[numbers]}),n]);await drain()
})

async function clearExpectedFixture() {
 await db.exec(`DELETE FROM public.lotto_sync_sms_outbox; DELETE FROM public.lotto_sync_work WHERE round_no=${expected}; DELETE FROM public.lotto_sync_jobs WHERE round_no=${expected}; DELETE FROM public.bets WHERE round_no=${expected}; DELETE FROM public.lotto_rounds WHERE round_no=${expected}; DELETE FROM public.members; DELETE FROM public.sms_sends;`)
}

test('SMS claim commits manualguard+receipt before provider and never reclaims ambiguous/failed outcomes',async()=>{
 await clearExpectedFixture()
 for(const id of ['send_accepted','send_failed','send_unknown','send_crash','send_hold','send_withdrawn','send_disabled','send_prior']) await member(id,expected,[numbers],{keep:'value',...(id==='send_hold'?{reco_paused:true,reco_pause_reason:'legacy_import_review'}:{}),...(id==='send_prior'?{win_sms_rounds:[expected]}:{})})
 await db.exec(`UPDATE public.members SET is_withdrawn=true WHERE id='send_withdrawn'`)
 await start(expected,true)
 await drain()
 assert.equal((await rpc('lotto_sync_health')).sms.pending,8)
 await db.exec(`UPDATE public.members SET is_suspended=true WHERE id='send_disabled'`)
 const claims=await rpc('lotto_sync_claim_sms',['10']);assert.equal(claims.length,4)
 assert.equal((await rpc('lotto_sync_claim_sms',['10'])).length,0)
 for(const c of claims) {
  const m=(await getMember(c.member_id)).meta;assert.equal(m.keep,'value');assert.ok(m.win_sms_rounds.includes(expected));assert.equal(c.member.meta.weekly_recos,undefined)
  const log=(await db.query('SELECT status FROM public.sms_sends WHERE id=$1',[`sms_lotto_outbox_${c.id}`])).rows[0];assert.equal(log.status,'접수확인필요(요청중)')
 }
 for(const status of ['accepted','failed','unknown']) {
  const c=claims.find(c=>c.member_id===`send_${status}`)
  const finish=()=>rpc('lotto_sync_finish_sms',['$1','$2::uuid','$3','$4::jsonb'],[c.id,c.claim_token,status,JSON.stringify({code:status==='failed'?'D179':'NET',body:'합성 문자 본문',cmid:`synthetic-${status}`,httpStatus:200})])
  assert.equal((await finish()).repeated,false);assert.equal((await finish()).repeated,true)
  const log=(await db.query('SELECT status,body FROM public.sms_sends WHERE id=$1',[`sms_lotto_outbox_${c.id}`])).rows[0]
  assert.equal(log.body,'합성 문자 본문');assert.equal(log.status.startsWith('실패'),false)
  const receipt=(await db.query('SELECT provider_receipt_id,provider_http_status FROM public.lotto_sync_sms_outbox WHERE id=$1',[c.id])).rows[0];assert.equal(receipt.provider_receipt_id,`synthetic-${status}`);assert.equal(receipt.provider_http_status,200)
  if(status==='accepted')assert.equal(log.status,'발송완료');else assert.ok(log.status.startsWith('접수확인필요'))
 }
 const h=await rpc('lotto_sync_health');assert.equal(h.sms.claimed,1);assert.equal(h.sms.accepted,1);assert.equal(h.sms.failed,1);assert.equal(h.sms.unknown,1);assert.equal(h.sms.skipped,4)
 await db.close();db=new PGlite(dataDir);await db.exec('SET ROLE service_role')
 assert.deepEqual(await rpc('lotto_sync_claim_sms',['10']),[])
 for(const id of ['send_hold','send_withdrawn','send_disabled'])assert.equal((await getMember(id)).meta.win_sms_rounds,undefined)
 assert.equal((await db.query('SELECT confirmed_at IS NOT NULL confirmed FROM public.lotto_rounds WHERE round_no=$1',[expected])).rows[0].confirmed,true)
})

test('SMS claim transaction rollback leaves both claim and guard untouched when receipt fails',async()=>{
 await db.exec(`UPDATE public.lotto_sync_sms_outbox SET status='pending',claim_token=NULL WHERE member_id='send_crash'; UPDATE public.members SET meta=meta-'win_sms_rounds' WHERE id='send_crash'`)
 // Existing same receipt forces unique violation after member+outbox updates, proving full atomic rollback.
 const before=await getMember('send_crash')
 await assert.rejects(rpc('lotto_sync_claim_sms',['10']),{code:'23505'})
 assert.deepEqual(await getMember('send_crash'),before)
 const q=(await db.query(`SELECT status,claim_token FROM public.lotto_sync_sms_outbox WHERE member_id='send_crash'`)).rows[0];assert.equal(q.status,'pending');assert.equal(q.claim_token,null)
 await db.exec(`UPDATE public.lotto_sync_sms_outbox SET status='unknown' WHERE member_id='send_crash'`)
})

test('manual recount cancels unclaimed SMS; never creates retroactive SMS',async()=>{
 await db.exec(`UPDATE public.lotto_sync_sms_outbox SET status='pending' WHERE member_id='send_crash'`)
 await admin(()=>rpc('lotto_sync_request_recount',['$1'],[expected]))
 await drain()
 assert.equal((await db.query(`SELECT status,result_code FROM public.lotto_sync_sms_outbox WHERE member_id='send_crash'`)).rows[0].result_code,'RECOUNT_NOSMS')
 assert.deepEqual(await rpc('lotto_sync_claim_sms',['10']),[])
 assert.equal((await db.query('SELECT queue_sms FROM public.lotto_sync_jobs WHERE round_no=$1',[expected])).rows[0].queue_sms,false)
})

test('88 schema without win_sms can aggregate but cannot queue or claim any SMS',async()=>{
 await clearExpectedFixture()
 await owner(()=>db.exec('ALTER TABLE public.site_settings DROP COLUMN win_sms'))
 await member('88_synthetic',expected)
 await start(expected,true)
 const b=await batch();assert.equal(b.status,'complete');assert.equal(b.winners,1)
 assert.equal((await rpc('lotto_sync_health')).sms.pending,0);assert.deepEqual(await rpc('lotto_sync_claim_sms'),[])
 assert.equal((await db.query('SELECT count(*)::int n FROM public.sms_sends')).rows[0].n,0)
 assert.equal((await getMember('88_synthetic')).meta.win_sms_rounds,undefined)
})

test('corrected member data only refreshes frozen blocked snapshot on explicit authorized recount',async()=>{
 const n=++serial
 await member('fix_review',n,[[1,1,2,3,4,5]])
 await start(n);assert.equal((await batch()).error,'RECO_INVALID')
 await db.query(`UPDATE public.members SET meta=jsonb_set(meta,'{weekly_recos}',$1::jsonb) WHERE id='fix_review'`,[JSON.stringify([{round_no:n,sets:[numbers]}])])
 assert.equal((await batch()).error,'RECO_INVALID') // automatic retry never silently changes the captured input
 assert.equal((await admin(()=>rpc('lotto_sync_request_recount',['$1'],[n]))).status,'pending')
 assert.equal((await batch()).status,'complete')
 assert.equal((await getMember('fix_review')).meta.win_records[0].rank,1)
 assert.equal((await db.query('SELECT queue_sms FROM public.lotto_sync_jobs WHERE round_no=$1',[n])).rows[0].queue_sms,false)
})

test('overlapping duplicate calls progress once and preserve completed tallies',async()=>{
 const n=++serial
 for(let i=0;i<3;i++)await member(`overlap_${i}`,n)
 const s=await Promise.all([start(n),start(n)]);assert.equal(s.filter(x=>x.created).length,1)
 const b=await Promise.all([batch(1),batch(1),batch(1)]);assert.deepEqual(b.map(x=>x.remaining),[2,1,0])
 const j=(await db.query('SELECT total,done,winners FROM public.lotto_sync_jobs WHERE round_no=$1',[n])).rows[0];assert.deepEqual(j,{total:3,done:3,winners:3})
 assert.equal((await batch()).status,'idle')
 for(let i=0;i<3;i++)assert.equal((await getMember(`overlap_${i}`)).meta.win_records.length,1)
 // PGlite serializes a local connection; real PostgreSQL cross-connection exclusion is enforced by advisory+row locks in SQL.
 assert.ok(migration.includes('pg_advisory_xact_lock(8141244,0)'))
 assert.ok(migration.includes('ORDER BY kind,target_id LIMIT p_limit FOR UPDATE'))
})

test('manual recount preserves bet member win history, stable index and metadata across batches',async()=>{
 const n=++serial
 await start(n);await batch() // new round complete with no candidates
 await member('bet_only',9999,[],{win_records:[{round_no:90,rank:4,source:'reco',combo_index:1},{custom:'bet-preserve'}],reco_paused:true})
 await db.query(`INSERT INTO public.bets(id,round_no,member_ref,numbers) VALUES('bet_a',$1,'bet_only',$2),('bet_b',$1,'bet_only',ARRAY[1,13,18,26,34,25]),('bet_c',$1,'bet_only',ARRAY[2,3,4,5,6,7])`,[n,numbers])
 await admin(()=>rpc('lotto_sync_request_recount',['$1'],[n]))
 assert.equal((await batch(1)).status,'running')
 await db.query(`UPDATE public.members SET meta=meta||'{"review_note":"keep"}' WHERE id='bet_only'`)
 await drain()
 let m=await getMember('bet_only');assert.equal(m.meta.reco_paused,true);assert.equal(m.meta.review_note,'keep');assert.ok(m.meta.win_records.some(e=>e.custom==='bet-preserve'))
 assert.deepEqual(m.meta.win_records.filter(e=>e.source==='bet').map(e=>[e.combo_index,e.rank]),[[1,1],[2,2]])
 const before=m.meta.win_records
 await admin(()=>rpc('lotto_sync_request_recount',['$1'],[n]));await drain()
 assert.deepEqual((await getMember('bet_only')).meta.win_records,before)
 await db.query(`UPDATE public.bets SET numbers=ARRAY[2,3,4,5,6,7] WHERE id IN ('bet_a','bet_b')`)
 await admin(()=>rpc('lotto_sync_request_recount',['$1'],[n]));await drain()
 m=await getMember('bet_only');assert.equal(m.meta.win_records.filter(e=>e.source==='bet').length,0);assert.equal(m.win_history,'90회 4등')
})

test('bet first prize stays summary when same round recommendation is fourth prize or loses',async()=>{
 const n=++serial
 await member('mixed',n,[[1,13,18,26,41,42]])
 await start(n);await drain()
 await db.query(`INSERT INTO public.bets(id,round_no,member_ref,numbers) VALUES('bet_mixed',$1,'mixed',$2)`,[n,numbers])
 await admin(()=>rpc('lotto_sync_request_recount',['$1'],[n]));await drain()
 assert.equal((await getMember('mixed')).win_history,`${n}회 1등 (2건)`)
 await db.query(`UPDATE public.members SET meta=jsonb_set(meta,'{weekly_recos}',$1::jsonb) WHERE id='mixed'`,[JSON.stringify([{round_no:n,sets:[[2,3,4,5,6,7]]}])])
 await admin(()=>rpc('lotto_sync_request_recount',['$1'],[n]));await drain()
 assert.equal((await getMember('mixed')).win_history,`${n}회 1등`)
})
