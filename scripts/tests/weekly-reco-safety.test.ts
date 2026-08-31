import assert from 'node:assert/strict'
import test from 'node:test'

import { kstDay, recoSafetyBlockReason } from '../../api/weekly-reco.ts'

test('KST 오늘보다 이전인 종료일은 무료/유료 공통 안전 게이트로 차단한다', () => {
  const today = '2026-08-31'

  assert.equal(recoSafetyBlockReason({ end_date: '2026-08-30' }, today), 'expired')
  assert.equal(recoSafetyBlockReason({ end_date: '2026-08-30 23:59:59' }, today), 'expired')
  assert.equal(recoSafetyBlockReason({ end_date: '2026-08-30T00:00:00+09:00' }, today), 'expired')
})

test('종료일 당일과 미래 회원은 계속 대상이 될 수 있다', () => {
  const today = '2026-08-31'

  assert.equal(recoSafetyBlockReason({ end_date: '2026-08-31' }, today), null)
  assert.equal(recoSafetyBlockReason({ end_date: '2026-09-01' }, today), null)
})

test('reco_paused=true는 종료일과 무관하게 항상 차단한다', () => {
  assert.equal(
    recoSafetyBlockReason({ reco_paused: true, end_date: '2027-12-31' }, '2026-08-31'),
    'paused',
  )
})

test('종료일이 없거나 유효하지 않으면 임의 만료 처리하지 않는다', () => {
  const today = '2026-08-31'

  assert.equal(recoSafetyBlockReason({}, today), null)
  assert.equal(recoSafetyBlockReason({ end_date: '' }, today), null)
  assert.equal(recoSafetyBlockReason({ end_date: '2026-02-30' }, today), null)
  assert.equal(recoSafetyBlockReason({ end_date: 'not-a-date' }, today), null)
})

test('자정 전후를 KST 날짜로 환산한다', () => {
  assert.equal(kstDay(Date.parse('2026-08-30T14:59:59.999Z')), '2026-08-30')
  assert.equal(kstDay(Date.parse('2026-08-30T15:00:00.000Z')), '2026-08-31')
})
