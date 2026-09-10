import { z } from 'zod'

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
