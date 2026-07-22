// 로또기록 모듈 데이터 훅 (CLAUDE §1·§8, BUILD_PROMPTS Phase 6 — 스샷 있음, 원본 구조 재현).
// 회차/베팅은 전역 데이터(역할 스코프 없음). '당첨 확정'은 회차 베팅의 등수/당첨금을 산정하고
// 1~3등 당첨자의 win_history 를 갱신(§8 당첨자 세그먼트) → lotto/bets/members 쿼리 무효화.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Bet, Grade, GenerationRecord, LogEntry, LottoRound, SiteSettings, WeeklyRecoIssue } from '@/types/db'
import { genId, mutateDb, nowIso, readDb } from '@/lib/db/store'
import { dataSource } from '@/lib/supabase'
import { fetchSiteSettings, fetchTables, patchSiteSettings } from '@/lib/db/remote'
import { useCurrentUser } from '@/lib/auth'
import { betKeys, lottoKeys, memberKeys, settingsKeys } from '@/lib/queryKeys'
import { gradeRank, lottoSum, oddEven, prizeForRank, resolveExcludeForGrade } from '@/lib/lotto'
import { makeGenerationRecord, upsertGenerationRecord } from '@/lib/generationRecord'
import { readWinRecords, upsertWinRecords, type WinRecord } from '@/lib/winHistory'
import { generateIssueSets, generateRecommendation } from '@/lib/lottoGenerator'
import * as supa from './supa'

export const WEEKLY_FREE_RECO_DEFAULT: import('@/types/db').WeeklyFreeRecoSettings = {
  enabled: true,
  set_count: 30,
  logic_ratio: 100,
}
const WEEKLY_RECO_KEEP = 8 // 회원당 보관할 최근 발급 회차 수
// 회원별 결정적 시드(같은 회원·회차는 동일 결과, 회원마다 다른 조합).
function memberSeed(id: string, round: number): number {
  let h = round * 2654435761
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h >>> 0
}

export interface RoundRow extends LottoRound {
  betCount: number
  winnerCount: number // 등수 있는 베팅 수(확정 회차)
  prizeSum: number // 당첨금 합계
  rankCounts: [number, number, number, number, number] // 1~5등 당첨 건수(회차별 누적 기록)
}

export type RoundFilter = 'all' | 'confirmed' | 'pending'

type BetAgg = { count: number; winners: number; prize: number; ranks: [number, number, number, number, number] }

function aggregateBets(bets: readonly Bet[]): Map<number, BetAgg> {
  const m = new Map<number, BetAgg>()
  for (const b of bets) {
    const cur = m.get(b.round_no) ?? { count: 0, winners: 0, prize: 0, ranks: [0, 0, 0, 0, 0] as BetAgg['ranks'] }
    cur.count += 1
    if (b.rank != null) {
      cur.winners += 1
      if (b.rank >= 1 && b.rank <= 5) cur.ranks[b.rank - 1] += 1
    }
    cur.prize += b.prize ?? 0
    m.set(b.round_no, cur)
  }
  return m
}

/** 회차 목록(최신순). 확정/미확정 필터. 베팅 집계 동봉. */
export function useRounds(filter: RoundFilter = 'all') {
  return useQuery({
    queryKey: lottoKeys.rounds({ filter }),
    queryFn: async (): Promise<RoundRow[]> => {
      const db =
        dataSource === 'supabase' ? await fetchTables(['bets', 'lotto_rounds']) : readDb()
      const agg = aggregateBets(db.bets)
      let rows = db.lotto_rounds.map((r): RoundRow => {
        const a = agg.get(r.round_no)
        return {
          ...r,
          betCount: a?.count ?? 0,
          winnerCount: a?.winners ?? 0,
          prizeSum: a?.prize ?? 0,
          rankCounts: a?.ranks ?? [0, 0, 0, 0, 0],
        }
      })
      if (filter === 'confirmed') rows = rows.filter((r) => r.confirmed_at != null)
      else if (filter === 'pending') rows = rows.filter((r) => r.confirmed_at == null)
      return rows.sort((a, b) => b.round_no - a.round_no)
    },
    placeholderData: (prev) => prev,
  })
}

/**
 * 추천 생성기용 수동 고정·제외 설정. settings 페이지의 useSiteSettings 와 동일 쿼리 키를
 * 공유하므로(설정 캐시 재사용) 설정 편집이 추천 화면에 즉시 반영된다(§2 feature 간 import 회피).
 * 등급별 규칙 해석은 lib/lotto.resolveExcludeForGrade(회원 모듈 수동발급과 공유)로 이동 — 재노출.
 */
export { resolveExcludeForGrade } from '@/lib/lotto'

// 추천 생성용 사이트 설정(고정/제외 이력 포함). 등급 해석은 resolveExcludeForGrade 로 호출측에서 수행.
export function useLottoExclude() {
  return useQuery({
    queryKey: settingsKeys.site(),
    queryFn: async (): Promise<SiteSettings> =>
      dataSource === 'supabase' ? await fetchSiteSettings() : readDb().site_settings,
  })
}

// ── 회차·등급별 생성 로직 기록(현장 피드백 7/21) ───────────────────────────────
// 특정 조합은 저장하지 않고, 규칙별 후보 → 최종 제외 → 남은 풀의 전체 흐름만 보관한다.
export function useSaveGenerationRecord() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (rec: Omit<GenerationRecord, 'id' | 'created_at' | 'created_by'>) => {
      const full: GenerationRecord = { ...rec, id: genId('genrec'), created_at: nowIso(), created_by: user?.id ?? null }
      if (dataSource === 'supabase') {
        const cur = await fetchSiteSettings()
        await patchSiteSettings({ generation_records: upsertGenerationRecord(cur.generation_records, full) }, user?.id ?? null)
        return full
      }
      mutateDb((db) => {
        db.site_settings.generation_records = upsertGenerationRecord(db.site_settings.generation_records, full)
      })
      return full
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.site() }),
  })
}

/** 생성기록 삭제(최고관리자 전용 — 호출측에서 역할 가드). */
export function useDeleteGenerationRecord() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      if (dataSource === 'supabase') {
        const cur = await fetchSiteSettings()
        await patchSiteSettings(
          { generation_records: (cur.generation_records ?? []).filter((r) => r.id !== id) },
          user?.id ?? null,
        )
        return id
      }
      mutateDb((db) => {
        db.site_settings.generation_records = (db.site_settings.generation_records ?? []).filter((r) => r.id !== id)
      })
      return id
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.site() }),
  })
}

function lottoLog(actor: string | null, action: string, roundNo: number, meta: Record<string, unknown>): LogEntry {
  return {
    id: genId('log'),
    kind: 'admin',
    actor,
    action,
    target_type: 'lotto_round',
    target_id: String(roundNo),
    meta,
    created_at: nowIso(),
  }
}

/**
 * 당첨 확정: 해당 회차 모든 베팅의 등수/당첨금을 (재)산정하고 confirmed_at 기록.
 * §8: 1~3등 당첨 베팅의 연결 회원 win_history 갱신(당첨자 세그먼트). 멱등(재확정 가능).
 */
export function useConfirmRound() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { roundNo: number }) => {
      if (dataSource === 'supabase') return supa.confirmRound(v.roundNo, user?.id ?? null)
      mutateDb((db) => {
        const round = db.lotto_rounds.find((r) => r.round_no === v.roundNo)
        if (!round) return
        let winners = 0
        let prizeSum = 0
        // 회원별 당첨내역 누적(§ 회원상세 "당첨이력") — bet/reco 각각의 새 WinRecord 를 모아 한 번에 upsert.
        const freshByMember = new Map<string, WinRecord[]>()
        const addFresh = (memberId: string, w: WinRecord) => {
          const arr = freshByMember.get(memberId) ?? []
          arr.push(w)
          freshByMember.set(memberId, arr)
        }
        // 베팅 내 조합순번(몇 번째 조합) — 같은 회원·회차 베팅을 등록 순서대로 세어 부여.
        const betIndexByMember = new Map<string, number>()
        for (const bet of db.bets) {
          if (bet.round_no !== v.roundNo) continue
          const rank = gradeRank(bet.numbers, round.numbers, round.bonus)
          bet.rank = rank
          bet.prize = prizeForRank(round, rank)
          if (rank != null) {
            winners += 1
            prizeSum += bet.prize ?? 0
          }
          if (bet.member_ref) {
            const idx = (betIndexByMember.get(bet.member_ref) ?? 0) + 1
            betIndexByMember.set(bet.member_ref, idx)
            if (rank != null && rank <= 3) {
              const m = db.members.find((x) => x.id === bet.member_ref)
              if (m) {
                m.win_history = `${v.roundNo}회 ${rank}등`
                addFresh(m.id, {
                  round_no: v.roundNo,
                  draw_date: round.draw_date,
                  rank,
                  prize: bet.prize ?? 0,
                  combo_index: idx,
                  source: 'bet',
                })
              }
            }
          }
        }
        // 추천조합(weekly_recos) 당첨 집계 — 실제 서비스 기준 당첨자 산정(당첨금은 등수별 고정 산식).
        for (const m of db.members) {
          const recos = Array.isArray(m.meta?.weekly_recos) ? (m.meta!.weekly_recos as WeeklyRecoIssue[]) : []
          const issue = recos.find((x) => x.round_no === v.roundNo)
          if (!issue) continue
          let best: number | null = null
          let wins = 0
          issue.sets.forEach((set, i) => {
            const rk = gradeRank(set, round.numbers, round.bonus)
            if (rk == null) return
            wins += 1
            if (best === null || rk < best) best = rk
            addFresh(m.id, {
              round_no: v.roundNo,
              draw_date: round.draw_date,
              rank: rk,
              prize: prizeForRank(round, rk) ?? 0,
              combo_index: i + 1,
              source: 'reco',
            })
          })
          if (best != null) {
            winners += 1
            m.win_history = `${v.roundNo}회 ${best}등${wins > 1 ? ` (${wins}건)` : ''}`
          }
        }
        for (const [memberId, fresh] of freshByMember) {
          const m = db.members.find((x) => x.id === memberId)
          if (!m) continue
          m.meta = { ...m.meta, win_records: upsertWinRecords(readWinRecords(m.meta), fresh) }
        }
        round.confirmed_at = nowIso()
        db.logs.push(lottoLog(user?.id ?? null, 'lotto.confirm', v.roundNo, { winners, prizeSum }))
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: lottoKeys.all })
      qc.invalidateQueries({ queryKey: betKeys.all })
      qc.invalidateQueries({ queryKey: memberKeys.all }) // 당첨자 세그먼트 재계산(§8)
    },
  })
}

export interface RegisterRoundInput {
  round_no: number
  draw_date: string // yyyy-MM-dd
  numbers: number[] // 6
  bonus: number
  prize_1: number | null
  prize_2: number | null
  prize_3: number | null
  total_sales: number | null
}

export type RegisterResult = { ok: true } | { ok: false; error: string }

/** 회차 등록(당첨번호 입력). 미확정 상태로 추가 → 이후 '당첨 확정'으로 베팅 채점. */
export function useRegisterRound() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: RegisterRoundInput): Promise<RegisterResult> => {
      if (dataSource === 'supabase') return supa.registerRound(v, user?.id ?? null)
      let result: RegisterResult = { ok: true }
      mutateDb((db) => {
        if (db.lotto_rounds.some((r) => r.round_no === v.round_no)) {
          result = { ok: false, error: '이미 존재하는 회차입니다.' }
          return
        }
        const round: LottoRound = {
          round_no: v.round_no,
          draw_date: new Date(`${v.draw_date}T20:45:00+09:00`).toISOString(),
          numbers: [...v.numbers].sort((a, b) => a - b),
          bonus: v.bonus,
          sum: lottoSum(v.numbers),
          odd_even: oddEven(v.numbers),
          appear_rate: null,
          prize_1: v.prize_1,
          prize_2: v.prize_2,
          prize_3: v.prize_3,
          total_sales: v.total_sales,
          confirmed_at: null,
        }
        db.lotto_rounds.push(round)
        db.logs.push(lottoLog(user?.id ?? null, 'lotto.register', v.round_no, { numbers: round.numbers, bonus: round.bonus }))
      })
      return result
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: lottoKeys.all })
    },
  })
}

// ── 회원 추천조합 발급(현장 피드백) ────────────────────────────────────────
// 주간 자동(크론, 무료 기본) 외에 콘솔에서 '등급 선택 → 일괄 발급' 지원(<추천번호> 4).
// 세트 수 = 회원별 weekly_reco_count(없으면 전역 set_count) (<추천번호> 5).
// 로직:랜덤 비율 = weekly_free_reco.logic_ratio % (<추천번호> 6). 문자발송 X.

/** 발급 대상(선택 등급) 수 + 최근 발급 회차 요약 — RecommendPage 발급 카드용. */
export function useWeeklyRecoStatus(grade: Grade) {
  return useQuery({
    queryKey: ['weekly-reco-status', grade],
    queryFn: async (): Promise<{ targetCount: number; lastRound: number | null; lastIssuedAt: string | null }> => {
      if (dataSource === 'supabase') return supa.fetchWeeklyRecoStatus(grade)
      const members = readDb().members.filter((m) => m.grade === grade && !m.is_deleted && !m.is_withdrawn)
      let lastRound: number | null = null
      let lastIssuedAt: string | null = null
      for (const m of members) {
        const recos = Array.isArray(m.meta?.weekly_recos) ? (m.meta!.weekly_recos as WeeklyRecoIssue[]) : []
        const top = recos[0]
        if (top && (lastIssuedAt === null || top.issued_at > lastIssuedAt)) {
          lastIssuedAt = top.issued_at
          lastRound = top.round_no
        }
      }
      return { targetCount: members.length, lastRound, lastIssuedAt }
    },
  })
}

export interface WeeklyIssueResult {
  issued: number // 신규 발급된 회원 수
  skipped: number // 이미 이번 회차 발급된 회원 수
  round_no: number
}

/**
 * 등급 일괄 발급 실행(수동 트리거 — 주간 크론과 동일 로직). 멱등:
 * 회원이 이미 대상 회차를 받았으면 건너뛴다. 문자 발송은 하지 않는다(요구사항).
 */
export function useIssueGradeReco() {
  const user = useCurrentUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { grade: Grade }): Promise<WeeklyIssueResult> => {
      if (dataSource === 'supabase') return supa.issueGradeReco(v.grade, user?.id ?? null)
      const cur = readDb()
      const cfg = cur.site_settings.weekly_free_reco ?? WEEKLY_FREE_RECO_DEFAULT
      const setCount = Math.max(1, cfg.set_count || WEEKLY_FREE_RECO_DEFAULT.set_count)
      const ratio = cfg.logic_ratio ?? 100
      const rounds = cur.lotto_rounds
      const exclude = resolveExcludeForGrade(cur.site_settings, v.grade)
      const targetRound = rounds.reduce((mx, r) => Math.max(mx, r.round_no), 0) + 1
      const trace = generateRecommendation(rounds, exclude, {
        mode: 20,
        setCount: 1,
        seed: memberSeed(v.grade, targetRound),
      })
      let issued = 0
      let skipped = 0
      const ts = nowIso()
      mutateDb((db) => {
        for (const m of db.members) {
          if (m.grade !== v.grade || m.is_deleted || m.is_withdrawn) continue
          const recos = Array.isArray(m.meta?.weekly_recos) ? (m.meta!.weekly_recos as WeeklyRecoIssue[]) : []
          if (recos[0]?.round_no === targetRound) {
            skipped++
            continue
          }
          // 회원별 발송갯수 override(현장 피드백). 미설정 시 전역 set_count.
          const mCount = typeof m.meta?.weekly_reco_count === 'number' && m.meta.weekly_reco_count > 0
            ? (m.meta.weekly_reco_count as number)
            : setCount
          const sets = generateIssueSets(rounds, exclude, mCount, ratio, memberSeed(m.id, targetRound))
          const issue: WeeklyRecoIssue = { round_no: targetRound, issued_at: ts, sets }
          m.meta = { ...m.meta, weekly_recos: [issue, ...recos].slice(0, WEEKLY_RECO_KEEP) }
          issued++
        }
        if (issued > 0) {
          db.site_settings.generation_records = upsertGenerationRecord(
            db.site_settings.generation_records,
            makeGenerationRecord(trace, {
              createdBy: user?.id ?? null,
              grade: v.grade,
              source: 'grade_issue',
              setCount,
              logicRatio: ratio,
              issuedCount: issued,
            }),
          )
        }
        db.logs.push({
          id: genId('log'),
          kind: 'admin',
          actor: user?.id ?? null,
          action: 'reco.weekly_issue',
          target_type: 'member',
          target_id: null,
          meta: { count: issued, skipped, round_no: targetRound, set_count: setCount, logic_ratio: ratio, grade: v.grade, channel: 'console' },
          created_at: ts,
        })
      })
      return { issued, skipped, round_no: targetRound }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: memberKeys.all })
      qc.invalidateQueries({ queryKey: ['weekly-reco-status'] })
      qc.invalidateQueries({ queryKey: settingsKeys.site() })
    },
  })
}
