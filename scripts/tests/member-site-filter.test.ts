import assert from 'node:assert/strict'
import test from 'node:test'
import { filterMembers } from '../../src/features/members/views.ts'
import type { Member } from '../../src/types/db.ts'

function member(id: string, meta: Member['meta'], patch: Partial<Member> = {}): Member {
  return {
    id, user_id: id, name: id, nickname: null, phone: '', grade: 'free', status: 'active',
    tendency: null, consult_status: '신규', inflow_code: null, inflow_type: null,
    assigned_staff_id: null, team_id: null, memo: null, win_history: null, outcall_done: false,
    registered_at: '2026-09-09T00:00:00Z', last_active_at: null,
    is_suspended: false, is_deleted: false, is_withdrawn: false, meta, ...patch,
  }
}

const members = [
  member('existing', {}),
  member('blank', { source_site: '  ' }),
  member('explicit', { source_site: 'pluslotto' }),
  member('815-free', { source_site: 'lotto815' }),
  member('815-paid', { source_site: 'lotto815' }, { grade: 'gold', assigned_staff_id: 'staff-1' }),
  member('info', { source_site: 'infolotto' }),
  member('unmapped', { source_site: 'unmapped-legacy-site' }),
]
const ctx = { now: Date.parse('2026-09-09T03:00:00Z'), staffRoleById: {} }

test('출처가 비어 있는 기존 회원과 명시된 플러스로또 회원을 함께 조회한다', () => {
  assert.deepEqual(filterMembers(members, { sourceSite: 'pluslotto' }, ctx).map((m) => m.id),
    ['existing', 'blank', 'explicit'])
})

test('815 사이트 필터는 등급과 담당자 필터를 함께 적용한다', () => {
  assert.deepEqual(filterMembers(members, {
    sourceSite: 'lotto815', grade: 'gold', assignedStaffId: 'staff-1',
  }, ctx).map((m) => m.id), ['815-paid'])
  assert.equal(filterMembers(members, { sourceSite: 'infolotto', grade: 'gold' }, ctx).length, 0)
})

test('전체 사이트에서는 아직 대응되지 않은 원본 사이트도 누락하지 않는다', () => {
  assert.equal(filterMembers(members, { sourceSite: 'all' }, ctx).length, members.length)
  assert.equal(filterMembers(members, {}, ctx).length, members.length)
})

test('사이트 선택을 바꿔도 원본 회원이나 출처가 변경되지 않는다', () => {
  const before = structuredClone(members)
  for (const sourceSite of ['pluslotto', 'lotto815', 'infolotto', 'all'] as const) {
    filterMembers(members, { sourceSite, search: '815' }, ctx)
  }
  assert.deepEqual(members, before)
})

test('다른 사이트의 동일 유입코드는 사이트 내 중복 건수에 포함하지 않는다', () => {
  const rows = [
    member('native', {}, { inflow_code: 'shared-code' }),
    member('815', { source_site: 'lotto815' }, { inflow_code: 'shared-code' }),
  ]
  assert.equal(filterMembers(rows, { sourceSite: 'all', dupInflow: 'all' }, ctx).length, 2)
  assert.equal(filterMembers(rows, { sourceSite: 'lotto815', dupInflow: 'all' }, ctx).length, 0)
  // 등록 시 기존 회원에 기록하는 중복 시도 표시는 계속 조회되어야 한다.
  rows[1].meta.dup_phone = true
  assert.deepEqual(filterMembers(rows, { sourceSite: 'lotto815', dupPhone: true }, ctx).map((m) => m.id), ['815'])
})
