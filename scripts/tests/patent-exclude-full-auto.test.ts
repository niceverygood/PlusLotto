import assert from 'node:assert/strict'
import test from 'node:test'
import { generatePatentSets as apiGenerate, PATENT_FULL_AUTO_FROM_ROUND as API_FROM } from '../../api/weekly-reco.ts'
import { generatePatentSets as appGenerate, PATENT_FULL_AUTO_FROM_ROUND as APP_FROM } from '../../src/lib/lottoPatentExclude.ts'
import type { LottoRound } from '../../src/types/db.ts'

// 결정적 합성 회차(실제 당첨번호 아님) — 같은 입력이면 두 사본이 같은 결과를 내야 한다.
function rounds(last: number): LottoRound[] {
  let seed = 20261008
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const out: LottoRound[] = []
  for (let r = 1; r <= last; r++) {
    const picked = new Set<number>()
    while (picked.size < 7) picked.add(1 + Math.floor(rnd() * 45))
    const [bonus, ...numbers] = [...picked]
    out.push({ round_no: r, draw_date: '2026-01-01', numbers: numbers.sort((a, b) => a - b), bonus } as unknown as LottoRound)
  }
  return out
}

const manual = { fixed: [], excluded: [1, 2, 3, 44, 45] }
const EXPECTED = { before: { goldp: 5, vip: 8, royal: 12 }, after: { goldp: 7, vip: 12, royal: 15 } } as const

test('전부 자동 시작 회차는 1246회이고 두 사본이 같은 값을 쓴다', () => {
  assert.equal(API_FROM, 1246)
  assert.equal(APP_FROM, API_FROM)
})

test('1245회까지는 기존대로 자동 5·8·12개 + 수동 제외를 합쳐 적용한다', () => {
  const data = rounds(1244) // 다음 회차 = 1245
  for (const grade of ['goldp', 'vip', 'royal'] as const) {
    const r = apiGenerate(data, grade, manual, 5, 7)
    assert.equal(r.targetRound, 1245)
    assert.equal(r.autoExcluded.length, EXPECTED.before[grade], grade)
    for (const n of manual.excluded) assert.ok(r.excluded.includes(n), `${grade}: 수동 제외 ${n} 유지`)
  }
})

test('1246회부터 실버 7·골드 12·다이아 15개를 전부 자동 선정하고 수동 제외는 쓰지 않는다', () => {
  const data = rounds(1245) // 다음 회차 = 1246
  for (const grade of ['goldp', 'vip', 'royal'] as const) {
    const r = apiGenerate(data, grade, manual, 5, 7)
    assert.equal(r.targetRound, 1246)
    assert.equal(r.autoExcluded.length, EXPECTED.after[grade], grade)
    assert.deepEqual(r.excluded, [...r.autoExcluded].sort((a, b) => a - b), `${grade}: 최종 제외 = 자동 제외`)
    assert.equal(r.pool.length, 45 - EXPECTED.after[grade])
    assert.ok(r.sets.length > 0)
    for (const set of r.sets) {
      assert.equal(set.length, 6)
      for (const n of set) assert.ok(!r.excluded.includes(n), `${grade}: 제외수 ${n}가 조합에 들어감`)
    }
  }
})

test('수동 고정수는 1246회 이후에도 그대로 존중되고 제외되지 않는다', () => {
  const data = rounds(1245)
  const r = apiGenerate(data, 'royal', { fixed: [7], excluded: [8] }, 5, 7)
  assert.ok(!r.excluded.includes(7))
  assert.equal(r.autoExcluded.length, 15)
  for (const set of r.sets) assert.ok(set.includes(7))
})

test('자동발송(api)과 화면(src) 사본은 같은 입력에 같은 제외수를 낸다', () => {
  for (const last of [1244, 1245]) {
    const data = rounds(last)
    for (const grade of ['goldp', 'vip', 'royal'] as const) {
      const a = apiGenerate(data, grade, manual, 3, 11)
      const b = appGenerate(data, grade, manual, 3, 11)
      assert.deepEqual(a.autoExcluded, b.autoExcluded, `${last} ${grade}`)
      assert.deepEqual(a.excluded, b.excluded, `${last} ${grade}`)
      assert.equal(a.window, b.window)
      assert.deepEqual(a.sets, b.sets)
    }
  }
})
