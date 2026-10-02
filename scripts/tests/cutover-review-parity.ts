/** Read-only parity check between the exported cron gate and a private review snapshot. */
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { recoSkipReason, expectsComboSms } from '../../api/weekly-reco'

interface Row {
  id: string
  grade: string
  phone: string | null
  source_site: string
  is_suspended: boolean
  is_deleted: boolean
  is_withdrawn: boolean
  reco_paused: boolean | null
  reco_pause_reason: string | null
  weekly_reco_day: number | null
  weekly_reco_count: number | null
  end_date: string | null
  assessment: { day: number | null; first_date: string | null; verdict: string }
}
const [inputPath] = process.argv.slice(2)
assert(inputPath, 'Pass selected-members.private.json; contents never printed')
const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as Row[]
const mismatches: number[] = []
rows.forEach((row, index) => {
  const importHold = row.reco_paused === true && row.reco_pause_reason === 'legacy_import_review'
  const meta = { ...row, reco_paused: importHold ? false : row.reco_paused }
  const skip = recoSkipReason({ grade: row.grade, meta }, {
    today: row.assessment.day ?? 2,
    todayKst: row.assessment.first_date ?? '2026-10-06',
    autoEnabled: true,
    paidSmsOn: true,
    force: false,
    targetRound: -1,
  })
  const eligible = row.is_suspended === false && row.is_deleted === false && row.is_withdrawn === false && skip === null
  const expectsSms = eligible && expectsComboSms(row, { paidSmsOn: true })
  if (expectsSms !== (row.assessment.verdict === '회원 조건 충족')) mismatches.push(index)
})
assert.deepEqual(mismatches, [], 'Review verdict differs from current cron gate; sample positions only')

const base = { grade: 'goldp', meta: { weekly_reco_day: 2 } }
const ctx = { today: 2, todayKst: '2026-10-06', force: false, autoEnabled: true, paidSmsOn: true, targetRound: -1 }
assert.equal(recoSkipReason({ ...base, meta: { ...base.meta, end_date: '2026-10-06' } }, ctx), null)
assert.equal(recoSkipReason({ ...base, meta: { ...base.meta, end_date: '2026-10-05' } }, ctx), 'expired')
assert.equal(recoSkipReason({ ...base, meta: { ...base.meta, end_date: '2026-02-30' } }, ctx), null)
assert.equal(recoSkipReason({ ...base, meta: { ...base.meta, weekly_reco_count: 0 } }, ctx), 'count-zero')
assert.equal(recoSkipReason({ ...base, meta: { ...base.meta, reco_paused: true } }, { ...ctx, force: true }), 'paused')
assert.equal(recoSkipReason({ grade: 'goldp', meta: {} }, ctx), 'day')
console.log(JSON.stringify({ checkedSamples: rows.length, parity: 'PASS', cronBoundaryCases: 6, externalWrites: 0 }))
