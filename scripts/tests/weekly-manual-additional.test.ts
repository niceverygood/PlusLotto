import test from 'node:test'
import assert from 'node:assert/strict'
import handler, { parseRecoRequest, recoSkipReason, recoContextProblem, scanRecoSms } from '../../api/weekly-reco.ts'

type Row = { id: string; grade: string; name: string; phone: string; registered_at: string; assigned_staff_id: string | null; status: string; is_deleted: boolean; is_withdrawn: boolean; is_suspended: boolean; meta: Record<string, unknown> }
type Ledger = { id: string; token: string; status: string; member: Row; issue: Record<string, unknown>; shouldSend: boolean; receipt?: Record<string, unknown> }
function member(id: string, site = 'lotto815'): Row {
  return { id, grade: 'gold', name: 'synthetic', phone: '01000000001', registered_at: '2020-01-01T00:00:00Z', assigned_staff_id: 'test-staff', status: 'active', is_deleted: false, is_withdrawn: false, is_suspended: false,
    meta: { source_site: site, weekly_reco_day: 2, weekly_reco_count: 1, reco_paused: false, reco_pause_reason: null, end_date: '2027-12-31', weekly_recos: [] } }
}
interface Options { resetArchived?: boolean; resetArchiveUnavailable?: boolean; nullMeta?: boolean; rows?: Row[]; concurrent?: boolean; changeHold?: boolean; loseClaim?: boolean; finishFails?: boolean; provider?: 'accepted' | 'rejected' | 'unknown' | 'empty'; role?: string; inactiveStaff?: boolean; smsEnabled?: boolean; commonSenderBlank?: boolean; missingSiteSender?: boolean }
async function fixture(options: Options, work: (s: {
  rows: Row[]; ledger: Map<string, Ledger>; sends: Record<string, unknown>[]; writes: string[]; requests: string[]; logs: Record<string, unknown>[];
  invoke: (body?: Record<string, unknown>, query?: Record<string, unknown>, auth?: string) => Promise<{ status: number; body: Record<string, unknown> }>
}) => Promise<void>) {
  const oldFetch = globalThis.fetch, oldNow = Date.now
  const env = { CRON_SECRET: 'synthetic-secret', SUPABASE_URL: 'https://synthetic-reco.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key', SELF_BASE_URL: 'https://synthetic-reco.invalid' }
  const oldEnv = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env); Date.now = () => Date.parse('2026-10-06T00:30:00Z')
  const rows = options.rows ?? [member('test-a')], ledger = new Map<string, Ledger>(), sends: Record<string, unknown>[] = [], writes: string[] = [], requests: string[] = [], logs: Record<string, unknown>[] = []
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const operations = new Map<string, Record<string, unknown>>()
  let scans = 0, release: (() => void) | undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url), method = init?.method ?? 'GET'
    requests.push(method + ' ' + url.pathname)
    if (url.origin === 'https://synthetic-reco.invalid') {
      if (url.pathname === '/api/send-sms') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        assert.ok([...ledger.values()].some(e=>e.member.id===body.member_id && e.status==='claimed'), 'provider only after claim')
        sends.push(body)
        if (options.provider === 'unknown') throw new Error('synthetic response lost')
        if (options.provider === 'empty') return json({ ok: false, code: '' })
        if (options.provider === 'rejected') return json({ ok: false, code: 'D179' })
        return json({ ok: true, code: '0', cmid: 'synthetic-receipt' })
      }
      if (url.pathname === '/api/weekly-reco' && url.searchParams.get('audit') === '1') return json({ ok: true })
    }
    assert.equal(url.origin, 'https://synthetic-reco.supabase.co', 'all real network forbidden')
    if (url.pathname === '/auth/v1/user') return json({ id: 'synthetic-auth' })
    const table = url.pathname.replace('/rest/v1/', '')
    if (table === 'staff') return json({ id: 'test-staff', role: options.role ?? 'admin', is_active: !options.inactiveStaff })
    if (table === 'site_settings') {
      if (method !== 'GET') { writes.push(table); return json(null) }
      return json({ id: 1, lotto_exclude: { fixed: [], excluded: [] }, weekly_free_reco: { enabled: true, set_count: 1, logic_ratio: 0, paid_sms: true }, sms: { oneshot_enabled: options.smsEnabled !== false, sender_no: options.commonSenderBlank ? '' : '0212340000', by_site: { lotto815: { sender_no: options.missingSiteSender ? '' : '0212340001' }, infolotto: { sender_no: '0212340002' }, cplotto: { sender_no: '0212340003' }, best: { sender_no: '0212340004' } } } })
    }
    if (table === 'sms_templates') return json({ body: '$brand No. $round\n$num' })
    if (table === 'lotto_rounds') return json([{ round_no: 1244, draw_date: '2026-10-03', numbers: [1,2,3,4,5,6], bonus: 7 }])
    if (table === 'members') {
      assert.equal(method, 'GET', 'no stale full-meta client update')
      const idFilter = url.searchParams.get('id'), ids = idFilter?.startsWith('in.(') ? idFilter.slice(4,-1).split(',').map(id => id.replaceAll('"','')) : undefined
      if (idFilter?.startsWith('eq.')) return json(rows.find(r=>r.id===idFilter.slice(3)) ?? null)
      const snap = structuredClone(rows.filter(r => r.status === 'active' && !r.is_deleted && !r.is_withdrawn && !r.is_suspended && (!ids || ids.includes(r.id))))
      scans++; if (options.concurrent && scans <= 2) { if (scans === 2) release?.(); await barrier }
      return json(options.nullMeta ? snap.map(r => ({ ...r, meta: null })) : snap)
    }
    if (table === 'member_reco_reset_archive') return options.resetArchiveUnavailable ? json({message:'unavailable'},503) : json(options.resetArchived ? [{operation_id:'synthetic-operation',member_id:rows[0].id,issues:[{round_no:1245}]}] : [])
    if (table === 'reco_manual_operations') return json(operations.get(url.searchParams.get('id')?.slice(3) ?? '') ?? null)
    if (table === 'reco_issue_ledger') {
      const id=url.searchParams.get('manual_request_id')?.slice(3)
      if (id) { const entry=ledger.get(id); return json(entry ? {status:entry.status,issue:entry.issue,should_send:entry.shouldSend} : null) }
      return json([...ledger.values()].filter(e=>['claimed','unknown','rejected'].includes(e.status)).map(e=>({id:e.id})))
    }
    if (table === 'rpc/reco_issue_manual_claim') {
      writes.push('manual-claim')
      const p=JSON.parse(String(init?.body)) as Record<string, unknown>, id=String(p.p_operation_id), row=rows.find(r=>r.id===p.p_member_id)
      assert.ok(row)
      if (operations.has(id)) return json({ok:true,claimed:false,status:'claimed',reason:'OPERATION_EXISTS'})
      const op={id,member_id:row.id,actor_id:p.p_actor,round_no:p.p_round_no,set_count:p.p_set_count,also_sms:p.p_also_sms,status:'claimed',reason:null as string|null}
      operations.set(id,op)
      if (options.changeHold || row.meta.reco_paused) {
        op.status='blocked';op.reason='HELD'
        return json({ok:true,claimed:false,status:'blocked',reason:'HELD',confirmedNotIssued:true,operationId:id})
      }
      const entry:Ledger={id:'claim-'+id,token:'token-'+id,member:row,status:'claimed',issue:{...p.p_issue as Record<string,unknown>,manual_request_id:id},shouldSend:p.p_also_sms===true}
      ledger.set(id,entry);row.meta={...row.meta,weekly_recos:[entry.issue,...row.meta.weekly_recos as unknown[]]}
      if(options.loseClaim) throw new Error('synthetic lost claim')
      return json({ok:true,claimed:true,status:'claimed',claim_id:entry.id,claim_token:entry.token,member:structuredClone(row),issue:entry.issue,should_send:entry.shouldSend})
    }
    if (table === 'rpc/reco_issue_claim') {
      writes.push('claim')
      const p = JSON.parse(String(init?.body)) as Record<string, unknown>, row = rows.find(r => r.id === p.p_member_id)
      assert.ok(row)
      assert.equal(p.p_expected_grade, row.grade); assert.equal(p.p_expected_phone, row.phone)
      if (options.changeHold) row.meta = { ...row.meta, reco_paused: true, field_edit: 'preserve' }
      if (JSON.stringify(row.meta) !== JSON.stringify(p.p_expected_meta)) return json({ ok: true, claimed: false, status: 'review_required', reason: 'META_CHANGED' })
      if (ledger.has(row.id)) return json({ ok: true, claimed: false, status: 'skipped', reason: 'ALREADY_CLAIMED' })
      if (row.meta.reco_paused) return json({ ok: true, claimed: false, status: 'skipped', reason: 'HELD' })
      const issue = p.p_issue as Record<string, unknown>
      const entry: Ledger = { id: 'claim-' + row.id, token: 'token-' + row.id, member: row, status: 'claimed', issue, shouldSend: p.p_also_sms === true }
      ledger.set(row.id, entry); row.meta = { ...row.meta, weekly_recos: [issue] }
      if (options.loseClaim) throw new Error('synthetic claim response lost after commit')
      return json({ ok: true, claimed: true, status: 'claimed', claim_id: entry.id, claim_token: entry.token, member: { ...structuredClone(row), ...(options.nullMeta ? { meta: null } : {}) }, issue, should_send: entry.shouldSend })
    }
    if (table === 'rpc/reco_issue_finish') {
      writes.push('finish')
      if (options.finishFails) return json({ code: 'SYNTHETIC_RECEIPT_FAILURE' }, 500)
      const p = JSON.parse(String(init?.body)) as Record<string, unknown>, entry = [...ledger.values()].find(x => x.id === p.p_claim_id)
      assert.ok(entry); assert.equal(entry.token, p.p_claim_token)
      entry.status = String(p.p_outcome); entry.receipt = p.p_receipt as Record<string, unknown>
      return json({ ok: true, status: entry.status, outcome: entry.status, repeated: false })
    }
    if (table === 'logs') { writes.push('logs'); logs.push(JSON.parse(String(init?.body)) as Record<string,unknown>); return json(null) }
    throw new Error('Unexpected synthetic request: ' + table)
  }
  const invoke = async (body?: Record<string, unknown>, query: Record<string, unknown> = {}, auth = 'Bearer synthetic-secret') => {
    const result = { status: 0, body: {} as Record<string, unknown> }
    const response = { status(n: number) { result.status = n; return this }, json(value: Record<string, unknown>) { result.body = value; return this } }
    await handler({ method: body ? 'POST' : 'GET', headers: { authorization: auth }, query, body }, response)
    return result
  }
  try { await work({ rows, ledger, sends, writes, requests, logs, invoke }) } finally {
    globalThis.fetch = oldFetch; Date.now = oldNow
    for (const [k,v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

const op1='10000000-0000-4000-8000-000000000001',op2='10000000-0000-4000-8000-000000000002'
const payload=(id=op1)=>({memberIds:['test-a'],mode:'manual',operationId:id,setCount:1,alsoSms:true})
const auth='Bearer staff-token'

test('new operation UUID requires exact single manual scope and explicit quantity/SMS intent',()=>{
  for(const body of [{...payload(),mode:'scheduled'},{...payload(),operationId:'bad'},{...payload(),setCount:undefined},{...payload(),alsoSms:undefined}])
    assert.throws(()=>parseRecoRequest({method:'POST',body}))
  assert.equal(parseRecoRequest({method:'POST',body:payload()}).operationId,op1)
  assert.equal(parseRecoRequest({method:'POST',body:{memberIds:['test-a'],mode:'manual'}}).operationId,undefined)
})
test('new deliberate manual appends after existing round; replay is receipt lookup only; new UUID is separate',async()=>{
 await fixture({rows:[{...member('test-a'),meta:{...member('test-a').meta,weekly_recos:[{round_no:1245,sets:[[7,8,9,10,11,12]]}]}}]},async s=>{
  const first=await s.invoke(payload(),{},auth)
  assert.equal(first.body.smsSent,1);assert.equal((first.body.operation as Record<string,unknown>).status,'accepted')
  const writes=s.writes.length
  const replay=await s.invoke(payload(),{},auth)
  assert.equal((replay.body.operation as Record<string,unknown>).status,'accepted');assert.equal(s.writes.length,writes);assert.equal(s.sends.length,1)
  const second=await s.invoke(payload(op2),{},auth);assert.equal(second.body.smsSent,1);assert.equal(s.sends.length,2)
  assert.equal((s.rows[0].meta.weekly_recos as unknown[]).length,3)
 })
})
test('receipt status not_found is read-only and never unlocks a delayed original intent',async()=>{
 await fixture({},async s=>{
  const r=await s.invoke({...payload(),dryRun:true},{},auth)
  assert.deepEqual(r.body.operation,{id:op1,status:'not_found',set_count:1,also_sms:true,canStartNew:false})
  assert.equal(s.writes.length,0);assert.equal(s.sends.length,0)
 })
})
test('cron secret cannot invoke explicit additional manual flow',async()=>{
 await fixture({},async s=>{assert.equal((await s.invoke(payload())).status,403);assert.equal(s.writes.length,0)})
})
test('same operation with changed quantity or SMS intent conflicts before new provider call',async()=>{
 await fixture({},async s=>{
  await s.invoke(payload(),{},auth)
  assert.equal((await s.invoke({...payload(),setCount:2},{},auth)).status,409)
  assert.equal((await s.invoke({...payload(),alsoSms:false,dryRun:true},{},auth)).status,409)
  assert.equal(s.sends.length,1)
 })
})
test('persisted blocked request proves no issue and remains blocked after metadata changed',async()=>{
 await fixture({changeHold:true},async s=>{
  const r=await s.invoke(payload(),{},auth)
  assert.equal(r.body.confirmedNotIssued,true);assert.equal(r.body.operationId,op1)
  assert.equal((r.body.operation as Record<string,unknown>).status,'blocked')
  const count=s.writes.length;await s.invoke(payload(),{},auth)
  assert.equal(s.writes.length,count);assert.equal(s.sends.length,0)
 })
})
test('lost claim or failed finish is never resent and remains locked on status lookup',async()=>{
 for(const opts of [{loseClaim:true},{finishFails:true}]) await fixture(opts,async s=>{
  await s.invoke(payload(),{},auth)
  const before=s.sends.length,r=await s.invoke({...payload(),dryRun:true},{},auth)
  assert.equal((r.body.operation as Record<string,unknown>).status,'claimed')
  assert.equal((r.body.operation as Record<string,unknown>).canStartNew,false)
  await s.invoke(payload(),{},auth);assert.equal(s.sends.length,before)
 })
})
test('rep cannot inspect another member operation',async()=>{
 await fixture({role:'rep',rows:[{...member('test-a'),assigned_staff_id:'different'}]},async s=>{
  assert.equal((await s.invoke({...payload(),dryRun:true},{},auth)).status,403);assert.equal(s.writes.length,0)
 })
})

// A different unresolved operation must keep a rejected intent from opening a new one.
test('blocked intent remains locked while another receipt for the member and round is unresolved',async()=>{
 await fixture({changeHold:true},async s=>{
  s.ledger.set('older',{id:'older',token:'older',status:'unknown',member:s.rows[0],issue:{round_no:1245},shouldSend:true})
  const r=await s.invoke(payload(),{},auth)
  assert.equal((r.body.operation as Record<string,unknown>).status,'blocked')
  assert.equal((r.body.operation as Record<string,unknown>).confirmedNotIssued,true)
  assert.equal((r.body.operation as Record<string,unknown>).canStartNew,false)
  assert.equal(s.sends.length,0)
 })
})

test('additional manual SMS success cannot hide a missing or failed automatic receipt',async()=>{
 const query={
  select:(_fields:string)=>query,eq:(_field:string,_value:string)=>query,
  gte:(_field:string,_value:string)=>query,order:(_field:string)=>query,
  limit:(_page:number)=>Promise.resolve({error:null,data:[
   {id:'1',member_id:'a',status:'발송완료',meta:{manual_request_id:op1}},
   {id:'2',member_id:'a',status:'실패(D179)',meta:{}},
   {id:'3',member_id:'legacy',status:'발송완료',meta:null},
  ]}),
 }
 const result=await scanRecoSms({from:(_table:string)=>query},'2026-10-06T00:00:00Z',10)
 assert.deepEqual([...result.ok],['legacy']);assert.deepEqual([...result.fail],['a'])
})
