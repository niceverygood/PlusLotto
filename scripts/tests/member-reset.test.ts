import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import tsCompiler from 'typescript'
import * as resetHelpers from '../../src/lib/memberReset.ts'
import { resetMemberIds, planMemberReset, hasResetRecoRound, assertNoResetRecoRound, parseMemberResetResult, memberResetError } from '../../src/lib/memberReset.ts'
import type { Member } from '../../src/types/db.ts'
const ts = '2026-10-06T01:00:00Z'
function member(): Member {
  return { id: 'synthetic-member', user_id: 'synthetic-user', name: 'Synthetic', nickname: null, phone: '',
    grade: 'gold', status: 'active', tendency: 'x', consult_status: '승인', inflow_code: 'keep', inflow_type: 'keep',
    assigned_staff_id: 'synthetic-staff', team_id: 'synthetic-team', memo: 'old memo', win_history: 'old win', outcall_done: true,
    registered_at: '2020-01-01T00:00:00Z', last_active_at: ts, is_suspended: false, is_deleted: false, is_withdrawn: false,
    meta: { source_site: 'lotto815', legacy_user_id: 'original', reco_paused: true, reco_pause_reason: 'legacy_import_review',
      weekly_reco_count: 2, weekly_reco_day: 3, win_sms_rounds: [1244], unrelated: { original: true },
      weekly_recos: [{ round_no: 1245, issued_at: ts, sets: [[1,2,3,4,5,6]], extra: 'keep' }, { round_no: '1244', sets: [[7,8,9,10,11,12]] }],
      memos: [{ body: 'call memo', author: 'author', consult_status: '부재' }], reset_memos: [{ body: 'earlier' }], win_records: [{ round_no: 1244 }] } }
}
test('reset removes only active issue display and preserves private raw issue originals and consent/source metadata', () => {
  const m = member(), before = structuredClone(m)
  const result = planMemberReset(m, 'admin', 'operation', ts)
  assert.deepEqual(m, before)
  assert.deepEqual(result.member.meta.weekly_recos, [])
  assert.deepEqual(result.archive.issues, before.meta.weekly_recos)
  assert.notEqual(result.archive.issues, before.meta.weekly_recos)
  assert.equal(result.member.grade, 'free'); assert.equal(result.member.assigned_staff_id, null)
  for (const key of ['source_site','legacy_user_id','reco_paused','reco_pause_reason','weekly_reco_count','weekly_reco_day','win_sms_rounds','unrelated']) {
    assert.deepEqual(result.member.meta[key], before.meta[key])
  }
  assert.equal((result.member.meta.reset_memos as unknown[]).length, 2)
  assert.equal(hasResetRecoRound([result.archive], m.id, 1245), true)
  assert.equal(hasResetRecoRound([result.archive], m.id, 1244), true)
  assert.equal(hasResetRecoRound([result.archive], 'another-contract', 1245), false)
  assert.equal(hasResetRecoRound([result.archive], m.id, 1246), false)
  assert.throws(() => assertNoResetRecoRound([result.archive], ['another-contract', m.id], 1245), /다시 발급/)
})
test('all selected member history is preflighted before committing a reset', () => {
  for (const issue of [null, {}, { round_no: 0 }, { round_no: '01245' }, { round_no: 2147483648 }]) {
    const m = member(); m.meta.weekly_recos = [issue]
    assert.throws(() => planMemberReset(m, 'admin', 'op', ts), /이력/)
  }
  for (const key of ['weekly_recos','memos','reset_memos']) {
    const m = member(); m.meta[key] = null
    assert.throws(() => planMemberReset(m, 'admin', 'op', ts), /이력/)
  }
})
test('memo fallback and repeated reset do not duplicate old issues or lose originals', () => {
  const m = member(); delete m.meta.memos
  const first = planMemberReset(m, 'admin', 'op1', ts)
  assert.equal((first.member.meta.reset_memos as {body:string}[])[1].body, 'old memo')
  const second = planMemberReset(first.member, 'admin', 'op2', ts)
  assert.equal(second.archive.issues.length, 0)
  assert.equal(hasResetRecoRound([first.archive, second.archive], m.id, 1245), true)
  assert.deepEqual(second.member.meta.reset_memos, first.member.meta.reset_memos)
})
test('RPC scope and response are exact and bounded; malformed or partial success is never accepted', () => {
  assert.deepEqual(resetMemberIds(['b','a']), ['a','b'])
  for (const ids of [[], ['a','a'], [''], Array.from({length:501}, (_,i)=>String(i))]) assert.throws(() => resetMemberIds(ids))
  assert.deepEqual(parseMemberResetResult({member_ids:['a','b'], repeated:true}, ['b','a']), ['a','b'])
  for (const result of [null, {member_ids:['a'],repeated:false}, {member_ids:['a','b']}, {member_ids:['a','a'],repeated:true}]) {
    assert.throws(() => parseMemberResetResult(result, ['a','b']))
  }
  assert.match(memberResetError({message:'RESET_DELIVERY_UNRESOLVED'}).message, /접수 결과/)
})
test('live adapter makes one exact-scope atomic RPC and never falls back after an RPC failure', async () => {
  const source = readFileSync(new URL('../../src/features/members/supa.ts', import.meta.url), 'utf8')
  const compiled = tsCompiler.transpileModule(source, { compilerOptions: { module: tsCompiler.ModuleKind.CommonJS, target: tsCompiler.ScriptTarget.ES2020 } }).outputText
  const calls: {name:string; args:Record<string,unknown>}[] = []
  let fail = false
  const exports: Record<string, unknown> = {}
  const sandbox = { exports, require: (name: string) => {
    if (name === '@/lib/memberReset') return resetHelpers
    if (name === '@/lib/supabase') return { supabase: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({name,args})
        return fail ? {data:null,error:{message:'RESET_DELIVERY_UNRESOLVED'}} : {data:{member_ids:['a','b'],repeated:false},error:null}
      },
      from: () => { throw new Error('per-member table updates are forbidden') },
    } }
    return {}
  } }
  vm.runInNewContext(compiled, sandbox)
  const reset = exports.resetMembers as (ids:string[], operationId:string)=>Promise<string[]>
  assert.deepEqual(await reset(['b','a'], 'test-operation'), ['a','b'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'admin_reset_members')
  assert.equal(JSON.stringify(calls[0].args), JSON.stringify({p_member_ids:['a','b'],p_operation_id:'test-operation'}))
  fail = true
  await assert.rejects(reset(['b','a'], 'test-operation'), /접수 결과/)
  assert.equal(calls.length, 2)
  const ui = readFileSync(new URL('../../src/features/members/bulk.tsx', import.meta.url), 'utf8')
  assert.match(ui, /화면의 발급번호/); assert.match(ui, /결제·문자 접수 이력은 보존/)
})
