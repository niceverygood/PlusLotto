import assert from 'node:assert/strict'
import test from 'node:test'
import { filterMembers } from '../../src/features/members/views.ts'
import type { Member } from '../../src/types/db.ts'

// 2차담당자(실장) 필터 — 현장 10/14 "필터링에서도 2차담당자로 검색".
function member(id: string, primary: string | null, secondary: string | null | undefined): Member {
  return {
    id, user_id: id, name: id, nickname: null, phone: '01000000000', grade: 'goldp', status: 'active',
    tendency: null, consult_status: null, inflow_code: null, inflow_type: null, assigned_staff_id: primary,
    secondary_staff_id: secondary, team_id: null, memo: null, win_history: null, outcall_done: false,
    registered_at: '2026-10-01T00:00:00Z', last_active_at: null, is_suspended: false, is_deleted: false,
    is_withdrawn: false, meta: {},
  }
}
const rows = [member('a', 'rep1', 'lead1'), member('b', 'rep1', 'lead2'), member('c', 'rep2', null), member('d', 'rep2', undefined)]
const ctx = { now: new Date('2026-10-14T00:00:00Z'), staffRoleById: {} }
const ids = (filter: Parameters<typeof filterMembers>[1]) => filterMembers(rows, filter, ctx as never).map((m) => m.id)

test('secondary assignee filter matches exactly and combines with primary assignee', () => {
  assert.deepEqual(ids({ secondaryStaffId: 'lead1' }), ['a'])
  assert.deepEqual(ids({ secondaryStaffId: 'lead2', assignedStaffId: 'rep1' }), ['b'])
  assert.deepEqual(ids({ secondaryStaffId: 'lead2', assignedStaffId: 'rep2' }), [])
})

test('hasSecondary separates members with and without a secondary (missing field counts as none)', () => {
  assert.deepEqual(ids({ hasSecondary: true }), ['a', 'b'])
  assert.deepEqual(ids({ hasSecondary: false }), ['c', 'd'])
  assert.deepEqual(ids({}), ['a', 'b', 'c', 'd'])
})
