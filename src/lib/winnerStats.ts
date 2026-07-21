import type { WinnerRoundStats, WinnerStats } from '@/types/db'

export type WinnerRankKey = 'rank1' | 'rank2' | 'rank3' | 'rank4' | 'rank5'

export const WINNER_RANKS: readonly { key: WinnerRankKey; label: string }[] = [
  { key: 'rank1', label: '1등' },
  { key: 'rank2', label: '2등' },
  { key: 'rank3', label: '3등' },
  { key: 'rank4', label: '4등' },
  { key: 'rank5', label: '5등' },
]

export const EMPTY_WINNER_STATS: WinnerStats = { enabled: false, current: null }

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
}

export function normalizeWinnerRoundStats(value: unknown): WinnerRoundStats | null {
  const row = asObject(value)
  if (!row) return null
  const roundNo = nonNegativeInteger(row.round_no)
  if (roundNo < 1) return null
  return {
    round_no: roundNo,
    rank1: nonNegativeInteger(row.rank1),
    rank2: nonNegativeInteger(row.rank2),
    rank3: nonNegativeInteger(row.rank3),
    rank4: nonNegativeInteger(row.rank4),
    rank5: nonNegativeInteger(row.rank5),
    updated_at: typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : new Date(0).toISOString(),
  }
}

/** DB JSON을 최신 shape로 정규화하고 회차 중복을 제거한다. */
export function normalizeWinnerStats(value: unknown): WinnerStats {
  const raw = asObject(value)
  if (!raw) return { ...EMPTY_WINNER_STATS }
  return { enabled: raw.enabled === true, current: normalizeWinnerRoundStats(raw.current) }
}

/** 현재 공개 회차를 추가/수정한다. 동일 값이면 저장일시를 유지한다. */
export function upsertWinnerRound(
  value: unknown,
  entry: Omit<WinnerRoundStats, 'updated_at'>,
  updatedAt = new Date().toISOString(),
): WinnerStats {
  const current = normalizeWinnerStats(value)
  const previous = current.current
  if (
    previous?.round_no === entry.round_no &&
    WINNER_RANKS.every((rank) => previous[rank.key] === entry[rank.key])
  ) {
    return current
  }
  const next: WinnerRoundStats = { ...entry, updated_at: updatedAt }
  return { enabled: current.enabled, current: next }
}

/** 현재값+admin 로그 이력을 회차별 최신 1건으로 합친다. */
export function mergeWinnerHistory(values: readonly (WinnerRoundStats | null)[]): WinnerRoundStats[] {
  const byRound = new Map<number, WinnerRoundStats>()
  for (const row of values) {
    if (!row) continue
    const previous = byRound.get(row.round_no)
    if (!previous || row.updated_at > previous.updated_at) byRound.set(row.round_no, row)
  }
  return [...byRound.values()].sort((a, b) => b.round_no - a.round_no)
}

export function winnerTotal(row: WinnerRoundStats): number {
  return WINNER_RANKS.reduce((total, rank) => total + row[rank.key], 0)
}
