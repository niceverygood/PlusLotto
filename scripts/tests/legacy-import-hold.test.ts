import assert from 'node:assert/strict'
import test from 'node:test'
import { assertNoLegacyImportHold, isLegacyImportHeld } from '../../src/lib/legacyImportHold.ts'

const held = { source_site: 'lotto815', reco_pause_reason: 'legacy_import_review', reco_paused: true }

test('이관 검수 보류는 세 이관 사이트에만 적용한다', () => {
  for (const source_site of ['lotto815', 'cplotto', 'infolotto']) {
    assert.equal(isLegacyImportHeld({ ...held, source_site }), true)
  }
  for (const source_site of ['pluslotto', 'lotto88', '', null]) {
    assert.equal(isLegacyImportHeld({ ...held, source_site }), false)
  }
})

test('일반 추천 정지 및 검수 후 명시적으로 해제한 회원은 별도 검수 보류가 아니다', () => {
  for (const meta of [null, undefined, {}, { reco_paused: true },
    { ...held, reco_pause_reason: 'operator_pause' }, { ...held, reco_paused: false },
    { ...held, reco_paused: 'true' }]) {
    assert.equal(isLegacyImportHeld(meta), false)
  }
})

test('혼합 선택은 누구에게도 발급·발송하기 전에 보류 오류를 낸다', () => {
  const ordinary = { meta: { source_site: 'pluslotto' } }
  assert.throws(() => assertNoLegacyImportHold([ordinary, { meta: held }]), /이관 검수 중/)
  assert.throws(() => assertNoLegacyImportHold([{ meta: held }, ordinary]), /이관 검수 중/)
  assert.doesNotThrow(() => assertNoLegacyImportHold([ordinary, { meta: { ...held, reco_paused: false } }]))
  assert.doesNotThrow(() => assertNoLegacyImportHold([]))
})
