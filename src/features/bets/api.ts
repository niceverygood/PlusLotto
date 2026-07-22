// 베팅 모듈 데이터 훅 (BUILD_PROMPTS Phase 6 — 스샷 있음). 베팅은 전역 데이터(역할 스코프 없음).
// 회차 필터 + 검색 + 당첨금 집계. 당첨 확정(useConfirmRound)이 등수/당첨금을 갱신하면
// betKeys 무효화로 자동 재조회된다(§8). 회차 당첨번호를 동봉해 번호 일치 시각화에 사용.
import { useQuery } from '@tanstack/react-query'
import type { Bet } from '@/types/db'
import { readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchTables, sb } from '@/lib/db/remote'
import { betKeys, lottoKeys } from '@/lib/queryKeys'

export interface BetRow extends Bet {
  memberName: string | null // member_ref 가 회원 id 면 회원명, 아니면 null(외부 발행)
  win: number[] | null // 회차 당첨번호(확정/미확정 무관, 회차에 입력돼 있으면)
  winBonus: number | null
  confirmed: boolean // 회차 당첨 확정 여부
}

export interface BetSummary {
  count: number
  winners: number
  prizeSum: number
}

export interface BetsQuery {
  round: number | null // 회차 필터(null=전체)
  search: string
  page: number
  pageSize: number
}

export interface BetsResult {
  rows: BetRow[]
  total: number
  summary: BetSummary
}

function matchSearch(b: BetRow, s: string): boolean {
  const q = s.trim().toLowerCase()
  if (!q) return true
  const hay = [b.id, b.issuer, b.member_ref, b.memberName, String(b.round_no)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

export function useBets(q: BetsQuery) {
  return useQuery({
    queryKey: betKeys.list({ round: q.round, search: q.search, page: q.page, pageSize: q.pageSize }),
    queryFn: async (): Promise<BetsResult> => {
      if (dataSource === 'supabase') {
        const { data, error } = await sb().rpc('admin_bets_page', {
          p_round: q.round,
          p_search: q.search,
          p_offset: Math.max(0, q.page - 1) * q.pageSize,
          p_limit: q.pageSize,
        })
        if (error) throw error
        const result = data as BetsResult | null
        return result ?? { rows: [], total: 0, summary: { count: 0, winners: 0, prizeSum: 0 } }
      }
      const db =
        readDb()
      const memberName: Record<string, string> = {}
      for (const m of db.members) memberName[m.id] = m.name
      const roundById = new Map(db.lotto_rounds.map((r) => [r.round_no, r]))

      let rows: BetRow[] = db.bets.map((b) => {
        const r = roundById.get(b.round_no)
        return {
          ...b,
          memberName: b.member_ref ? (memberName[b.member_ref] ?? null) : null,
          win: r?.numbers ?? null,
          winBonus: r?.bonus ?? null,
          confirmed: r?.confirmed_at != null,
        }
      })
      if (q.round != null) rows = rows.filter((b) => b.round_no === q.round)
      rows = rows.filter((b) => matchSearch(b, q.search))
      rows.sort((a, b) => b.round_no - a.round_no || a.id.localeCompare(b.id))

      const summary: BetSummary = {
        count: rows.length,
        winners: rows.filter((b) => b.rank != null).length,
        prizeSum: rows.reduce((s, b) => s + (b.prize ?? 0), 0),
      }
      const start = (q.page - 1) * q.pageSize
      return { rows: rows.slice(start, start + q.pageSize), total: rows.length, summary }
    },
    placeholderData: (prev) => prev,
  })
}

export interface RoundOption {
  round_no: number
  confirmed: boolean
}

/** 회차 필터 옵션(최신순). lotto 회차 데이터를 직접 조회(feature 간 import 회피). */
export function useBetRoundOptions() {
  return useQuery({
    queryKey: lottoKeys.rounds({ as: 'bet-options' }),
    queryFn: async (): Promise<RoundOption[]> =>
      (dataSource === 'supabase' ? await fetchTables(['lotto_rounds']) : readDb()).lotto_rounds
        .map((r) => ({ round_no: r.round_no, confirmed: r.confirmed_at != null }))
        .sort((a, b) => b.round_no - a.round_no),
  })
}
