import { z } from 'zod'
import { datetime } from '@/lib/format'

/** 원본 wall time은 Date의 잘못된 날짜 자동 보정 전에 검증한다. */
export function formatLegacySourceDatetime(value: string | null | undefined): string {
  if (!value) return datetime(null)
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (match) {
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]
      && hour <= 23 && minute <= 59 && second <= 59) {
      const formatted = datetime(value.replace(' ', 'T'))
      // 브라우저 시간대의 DST 공백에서도 원본 wall time을 다른 시각으로 바꾸지 않는다.
      return formatted === value.slice(0, 16) ? formatted : value.slice(0, 16)
    }
  }
  return `${value} (시각 확인 필요)`
}

export type LegacyHistoryKind = 'memo' | 'sms' | 'win'
const sourceKey = z.string().regex(/^[1-9]\d*$/)
const safeIntegerString = sourceKey.refine((v) => Number.isSafeInteger(Number(v)), '원본 숫자 범위를 확인해 주세요.')
const cursorSchema = z.object({ at: z.string().min(1), idx: safeIntegerString, round: z.number().int().min(0) })
const commonRow = z.object({ legacy_idx: sourceKey, source_insert_datetime: z.string().nullable() })
const memoRow = commonRow.extend({ body: z.string().nullable() })
const smsRow = commonRow.extend({
  body: z.string().nullable(), subject: z.string().nullable(), contents_type: z.string(),
  body_policy: z.enum(['body_preserved', 'credential_type_omitted', 'credential_pattern_omitted', 'unreviewed_type_omitted']),
})
const winRow = commonRow.extend({
  round_no: z.number().int().positive(), rank: z.number().int().min(1).max(5),
  numbers: z.array(z.number().int().min(1).max(45)).length(6).refine((v) => new Set(v).size === 6),
  prize: z.string().regex(/^\d+$/).refine((v) => Number.isSafeInteger(Number(v))),
})
export type LegacyHistoryCursor = z.infer<typeof cursorSchema>
export type LegacyHistoryRow =
  | (z.infer<typeof memoRow> & { kind: 'memo' })
  | (z.infer<typeof smsRow> & { kind: 'sms' })
  | (z.infer<typeof winRow> & { kind: 'win' })
export interface LegacyHistoryPage {
  rows: LegacyHistoryRow[]
  hasMore: boolean
  nextCursor: LegacyHistoryCursor | null
}

export function parseLegacyHistoryPage(kind: LegacyHistoryKind, input: unknown): LegacyHistoryPage {
  const page = z.object({ rows: z.array(z.unknown()).max(100), has_more: z.boolean(), next_cursor: cursorSchema.nullable() }).parse(input)
  if (page.has_more && (page.next_cursor === null || page.rows.length === 0)) throw new Error('과거 이력의 다음 페이지 정보를 확인해 주세요.')
  if (page.next_cursor && (kind === 'win' ? page.next_cursor.round <= 0 : page.next_cursor.round !== 0)) throw new Error('과거 이력의 페이지 정보가 올바르지 않습니다.')
  const rows: LegacyHistoryRow[] = page.rows.map((row) => {
    if (kind === 'memo') return { ...memoRow.parse(row), kind }
    if (kind === 'sms') return { ...smsRow.parse(row), kind }
    return { ...winRow.parse(row), kind }
  })
  const keys = rows.map((row) => `${row.legacy_idx}:${row.kind === 'win' ? row.round_no : ''}`)
  if (new Set(keys).size !== rows.length) throw new Error('과거 이력에 중복된 원본 키가 있습니다.')
  return { rows, hasMore: page.has_more, nextCursor: page.has_more ? page.next_cursor : null }
}

/** 이전 전산 당첨기록 요약(현장 10/14) — member_legacy_win_summary RPC 응답. */
const countSchema = z.number().int().min(0)
const winSummarySchema = z.object({
  rank_counts: z.object({ 1: countSchema, 2: countSchema, 3: countSchema, 4: countSchema, 5: countSchema }),
  total_count: countSchema,
  // bigint 합계라 안전 정수를 넘을 수 있어 문자열 그대로 받고 표시할 때 BigInt 로 다룬다.
  total_prize: z.string().regex(/^\d+$/),
  removed_count: countSchema,
})
export type LegacyWinSummary = z.infer<typeof winSummarySchema>
export const EMPTY_LEGACY_WIN_SUMMARY: LegacyWinSummary = {
  rank_counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, total_count: 0, total_prize: '0', removed_count: 0,
}

export function parseLegacyWinSummary(input: unknown): LegacyWinSummary {
  const summary = winSummarySchema.parse(input)
  const ranks = [1, 2, 3, 4, 5] as const
  if (ranks.reduce((sum, r) => sum + summary.rank_counts[r], 0) !== summary.total_count)
    throw new Error('당첨기록 요약의 건수가 맞지 않습니다.')
  if (summary.removed_count > summary.total_count) throw new Error('당첨기록 요약의 건수가 맞지 않습니다.')
  return summary
}

/** "1,234,567원" — 안전 정수를 넘는 합계도 자릿수 손실 없이 표시한다. */
export function formatWinPrizeTotal(totalPrize: string): string {
  return `${BigInt(totalPrize).toLocaleString('ko-KR')}원`
}
