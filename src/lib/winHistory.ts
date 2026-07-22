// 회원별 당첨내역 누적 기록 (현장 피드백 — 회원정보에 회차/날짜/조합순번/당첨금액 리스트로 표시).
// member.win_history(단일 문자열, 최근 1건만 보관)와 별개로 member.meta.win_records 에
// 전체 이력을 누적한다(§4 "모르는 필드는 meta jsonb 로 흡수" 원칙 — 컬럼 추가 없이 즉시 배포 가능).
export interface WinRecord {
  round_no: number
  draw_date: string | null // lotto_rounds.draw_date(ISO)
  rank: number // 1~5
  prize: number
  combo_index: number // 몇 번째 조합에서 당첨됐는지(1-based) — 추천조합(sets)/베팅 내 순번
  source: 'reco' | 'bet' // 추천조합 발급분 vs 베팅(레거시) — 실제 서비스 기준은 reco
}

function key(w: Pick<WinRecord, 'source' | 'round_no' | 'combo_index'>): string {
  return `${w.source}:${w.round_no}:${w.combo_index}`
}

export function readWinRecords(meta: Record<string, unknown> | null | undefined): WinRecord[] {
  const list = meta?.win_records as WinRecord[] | undefined
  return Array.isArray(list) ? list : []
}

/** 재확정(멱등) 대비 — 동일 (source,round_no,combo_index) 는 최신 값으로 교체, 나머지는 누적. */
export function upsertWinRecords(existing: readonly WinRecord[], fresh: readonly WinRecord[]): WinRecord[] {
  const map = new Map<string, WinRecord>()
  for (const w of existing) map.set(key(w), w)
  for (const w of fresh) map.set(key(w), w)
  return [...map.values()].sort((a, b) => b.round_no - a.round_no || a.combo_index - b.combo_index)
}

/** 리스트 최상단 통합정리용 — 등수별 당첨 건수. */
export function summarizeWinRecords(records: readonly WinRecord[]): Record<1 | 2 | 3 | 4 | 5, number> {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>
  for (const w of records) {
    if (w.rank >= 1 && w.rank <= 5) out[w.rank as 1 | 2 | 3 | 4 | 5] += 1
  }
  return out
}
