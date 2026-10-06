import assert from 'node:assert/strict'
import test from 'node:test'
import { clearManualRecoIntent, persistManualRecoIntent, readManualRecoIntent, reserveManualRecoIntent, type ManualRecoIntent } from '../../src/lib/manualRecoIntent.ts'
import { readRecommendationOperation, RecommendationRequestError, requestRecommendation } from '../../src/lib/recoRequest.ts'

const intent: ManualRecoIntent = { operationId:'b5a2f14b-e014-4b79-9e5f-83f86d7a4704',actorId:'staff-test',memberId:'member-test',setCount:1,alsoSms:true }
const otherId='c5a2f14b-e014-4b79-9e5f-83f86d7a4704'
function storage() {const map=new Map<string,string>();return {map,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v)},removeItem:(k:string)=>{map.delete(k)}}}
const operation={id:intent.operationId,status:'accepted',set_count:1,also_sms:true,round_no:1245,canStartNew:true}
const good={ok:true,smsSent:1,smsFail:0,reviewRequired:0,operation,results:[{member_id:intent.memberId,status:'issued',round_no:1245,sets:[[1,2,3,4,5,6]],sms_outcome:'accepted'}]}
const reply=(data:unknown,status=200):typeof fetch=>async()=>new Response(JSON.stringify(data),{status})

test('persistent intent contains identity and count only and survives reload',()=>{const s=storage();persistManualRecoIntent(intent,s);assert.deepEqual(readManualRecoIntent(intent.actorId,intent.memberId,s),intent);assert.deepEqual(Object.keys(JSON.parse([...s.map.values()][0])).sort(),['actorId','alsoSms','memberId','operationId','setCount'].sort())})
test('second intent cannot replace unresolved one; another member is separate',()=>{const s=storage();persistManualRecoIntent(intent,s);assert.throws(()=>persistManualRecoIntent({...intent,operationId:otherId},s),/이전 수동/);persistManualRecoIntent({...intent,memberId:'member-other',operationId:otherId},s);assert.equal(s.map.size,2)})
test('stale completion cannot clear another operation',()=>{const s=storage();persistManualRecoIntent(intent,s);assert.throws(()=>clearManualRecoIntent({...intent,operationId:otherId},s));assert.equal(s.map.size,1);clearManualRecoIntent(intent,s);assert.equal(s.map.size,0)})
test('corrupt stored intent fails closed',()=>{const s=storage();persistManualRecoIntent(intent,s);s.map.set([...s.map.keys()][0],'{broken');assert.throws(()=>readManualRecoIntent(intent.actorId,intent.memberId,s));assert.throws(()=>persistManualRecoIntent({...intent,operationId:otherId},s))})
test('new explicit manual request sends same UUID and exact additional count once',async()=>{let calls=0;const got=await requestRecommendation(intent,'token',async(_url,options)=>{calls++;assert.deepEqual(JSON.parse(String(options?.body)),{memberIds:[intent.memberId],mode:'manual',dryRun:false,alsoSms:true,setCount:1,operationId:intent.operationId});return new Response(JSON.stringify(good))});assert.equal(calls,1);assert.equal(got.operation?.id,intent.operationId)})
test('same manual UUID is never regenerated after network ambiguity',async()=>{let calls=0;await assert.rejects(requestRecommendation(intent,'token',async()=>{calls++;throw Error('connection lost')}));assert.equal(calls,1);assert.equal(intent.operationId,operation.id)})
test('manual status is dryRun read-only and carries original immutable intent',async()=>{await readRecommendationOperation(intent,'token',async(_url,options)=>{assert.deepEqual(JSON.parse(String(options?.body)),{memberIds:[intent.memberId],mode:'manual',dryRun:true,operationId:intent.operationId,setCount:1,alsoSms:true});return new Response(JSON.stringify({ok:true,operation}))})})
test('not found, claimed, rejected and unknown never allow new intent',async()=>{for(const status of ['not_found','claimed','rejected','unknown']){const op=await readRecommendationOperation(intent,'token',reply({ok:true,operation:{...operation,status,canStartNew:false}}));assert.equal(op.canStartNew,false);await assert.rejects(readRecommendationOperation(intent,'token',reply({ok:true,operation:{...operation,status,canStartNew:true}})))}})
test('wrong UUID/count/SMS or round cannot be accepted',async()=>{for(const op of [{...operation,id:otherId},{...operation,set_count:2},{...operation,also_sms:false},{...operation,round_no:1244}])await assert.rejects(requestRecommendation(intent,'token',reply({...good,operation:op})))})
test('manual response exact additional set count required',async()=>{await assert.rejects(requestRecommendation({...intent,setCount:2},'token',reply({...good,operation:{...operation,set_count:2}})))})
test('401/500 never prove a request unissued',async()=>{for(const status of [401,500])await assert.rejects(requestRecommendation(intent,'token',reply({ok:false},status)),(error:unknown)=>error instanceof RecommendationRequestError&&!error.confirmedNotIssued)})
test('confirmed non-issuance requires explicit exact operation proof',async()=>{await assert.rejects(requestRecommendation(intent,'token',reply({ok:false,code:'HELD',confirmedNotIssued:true,operationId:otherId},423)),(error:unknown)=>error instanceof RecommendationRequestError&&!error.confirmedNotIssued);await assert.rejects(requestRecommendation(intent,'token',reply({ok:false,code:'HELD',confirmedNotIssued:true,operationId:intent.operationId},423)),(error:unknown)=>error instanceof RecommendationRequestError&&error.confirmedNotIssued)})
test('no SMS issued outcome is separately accepted',async()=>{const op={...operation,status:'not_requested',also_sms:false};const result=await requestRecommendation({...intent,alsoSms:false},'token',reply({...good,smsSent:0,operation:op,results:[{...good.results[0],sms_outcome:'not_requested'}]}));assert.equal(result.operation?.status,'not_requested')})

test('only durable blocked proof unlocks a never-issued operation',async()=>{const blocked={...operation,status:'blocked',code:'HELD',confirmedNotIssued:true};assert.equal((await readRecommendationOperation(intent,'token',reply({ok:true,operation:blocked}))).canStartNew,true);await assert.rejects(readRecommendationOperation(intent,'token',reply({ok:true,operation:{...blocked,confirmedNotIssued:false}})))})

test('another tab confirming the same terminal receipt makes cleanup idempotent',()=>{const s=storage();persistManualRecoIntent(intent,s);clearManualRecoIntent(intent,s);clearManualRecoIntent(intent,s);assert.equal(s.map.size,0)})

test('execution replay of a blocked intent shows reason and permits a new confirmation only with exact proof',async()=>{await assert.rejects(requestRecommendation(intent,'token',reply({ok:true,results:[],operation:{...operation,status:'blocked',code:'HELD',confirmedNotIssued:true}})),(error:unknown)=>error instanceof RecommendationRequestError&&error.confirmedNotIssued&&error.message.includes('보류'));await assert.rejects(requestRecommendation(intent,'token',reply({ok:true,results:[],operation:{...operation,id:otherId,status:'blocked',code:'HELD',confirmedNotIssued:true}})),(error:unknown)=>!(error instanceof RecommendationRequestError&&error.confirmedNotIssued))})

test('confirmed blocked intent cannot unlock while another request remains unresolved',async()=>{await assert.rejects(requestRecommendation(intent,'token',reply({ok:true,results:[],operation:{...operation,status:'blocked',code:'HELD',confirmedNotIssued:true,canStartNew:false}})),(error:unknown)=>error instanceof RecommendationRequestError&&error.confirmedNotIssued&&!error.canStartNew);await assert.rejects(requestRecommendation(intent,'token',reply({ok:false,code:'HELD',operationId:intent.operationId,confirmedNotIssued:true},423)),(error:unknown)=>error instanceof RecommendationRequestError&&error.confirmedNotIssued&&!error.canStartNew)})


test('concurrent confirmation intents serialize before a UUID is created', async () => {
  const s = storage()
  let tail: Promise<unknown> = Promise.resolve()
  let uuidCalls = 0
  const originals = new Map(['navigator', 'crypto', 'localStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_key: string, fn: () => Promise<unknown>) => {
      const next = tail.then(fn); tail = next.catch(() => undefined); return next
    } } } })
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: () => { uuidCalls++; return intent.operationId } } })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: s })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
    const input = { actorId: intent.actorId, memberId: intent.memberId, setCount: 1, alsoSms: true }
    const results = await Promise.allSettled([reserveManualRecoIntent(input), reserveManualRecoIntent(input)])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.equal(uuidCalls, 1)
    assert.deepEqual(readManualRecoIntent(intent.actorId, intent.memberId, s), intent)
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
test('storage failure never produces an executable intent', () => {
  const failing = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
  assert.throws(() => persistManualRecoIntent(intent, failing), /quota/)
  const lost = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  assert.throws(() => persistManualRecoIntent(intent, lost), /이전 수동/)
})
