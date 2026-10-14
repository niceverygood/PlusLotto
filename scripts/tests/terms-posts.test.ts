import assert from 'node:assert/strict'
import test from 'node:test'
import { kstToday, termsGradeLabel, termsGradesForSite, termsPostStates } from '../../src/lib/termsPosts.ts'

// 사이트별 약관 게시판(현장 10/14) — 고객 화면의 현행/시행예정/이전 표시 규칙.
const post = (id: string, grade: 'vip' | null, effective_on: string, created_at = '2026-10-01T00:00:00Z') =>
  ({ id, grade, effective_on, created_at })

test('the newest effective post per scope is current; future posts are scheduled; the rest are previous', () => {
  const posts = [
    post('g1', 'vip', '2026-01-01'), post('g2', 'vip', '2026-10-01'), post('g3', 'vip', '2026-12-01'),
    post('c1', null, '2025-06-01'), post('c2', null, '2026-03-01'),
  ]
  const s = termsPostStates(posts, '2026-10-14')
  assert.equal(s.get('g2'), 'current')
  assert.equal(s.get('g3'), 'scheduled')
  assert.equal(s.get('g1'), 'previous')
  assert.equal(s.get('c2'), 'current') // 공통은 등급 전용과 따로 본다
  assert.equal(s.get('c1'), 'previous')
})

test('same effective date: the later registration wins; effective today counts as current', () => {
  const s = termsPostStates([
    post('a', 'vip', '2026-10-14', '2026-10-14T01:00:00Z'), post('b', 'vip', '2026-10-14', '2026-10-14T02:00:00Z'),
  ], '2026-10-14')
  assert.equal(s.get('b'), 'current')
  assert.equal(s.get('a'), 'previous')
})

test('KST date boundary and per-site grade labels', () => {
  assert.equal(kstToday(new Date('2026-10-13T15:30:00Z')), '2026-10-14') // 한국 자정 이후
  assert.equal(kstToday(new Date('2026-10-13T14:30:00Z')), '2026-10-13')
  assert.deepEqual(termsGradesForSite('pluslotto'), ['goldp', 'ruby', 'vip', 'royal', 'free'])
  assert.deepEqual(termsGradesForSite('infolotto'), ['goldp', 'vip', 'royal'])
  assert.equal(termsGradeLabel('infolotto', 'goldp'), '베이직 · 실버')
  assert.equal(termsGradeLabel('pluslotto', null), '공통(전 등급)')
})
