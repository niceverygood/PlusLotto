// 로또기록 모듈 — supabase 쓰기 경로 (M7). dataSource==='supabase' 일 때 api.ts 의 뮤테이션이 호출.
// mock 의 mutateDb 부수효과(§8)를 미러링한다:
//   당첨 확정 → 회차 베팅 등수/당첨금 (재)산정 + 1~3등 회원 win_history 갱신 + confirmed_at + 로그
//   회차 등록 → 중복 검사 후 미확정 회차 추가 + 로그
// 회차/베팅은 전역 데이터(RLS 스코프 없음). 읽기(useRounds)는 fetchTables 스냅샷으로 재사용.
// TODO(live-verify): 회차 베팅 채점은 행 단위 update — 대량 회차는 RPC(set-based)로 이관 권장.
import type { Bet, Grade, LottoRound, Member, SiteSettings, WeeklyRecoIssue } from '@/types/db'
import { nowIso } from '@/lib/db/store'
import { insertLog, fetchSiteSettings, patchSiteSettings, sb, selectAll } from '@/lib/db/remote'
import { gradeRank, lottoSum, oddEven, prizeForRank } from '@/lib/lotto'
import { makeGenerationRecord, upsertGenerationRecord } from '@/lib/generationRecord'
import { generateIssueSets, generateRecommendation } from '@/lib/lottoGenerator'
import {
  resolveExcludeForGrade,
  WEEKLY_FREE_RECO_DEFAULT,
  type RegisterResult,
  type RegisterRoundInput,
  type WeeklyIssueResult,
} from './api'

/** 당첨 확정: 회차 베팅 등수/당첨금 (재)산정 + 1~3등 회원 win_history 갱신. 멱등. */
export async function confirmRound(roundNo: number, actor: string | null): Promise<void> {
  const { data: rData, error: re } = await sb()
    .from('lotto_rounds')
    .select('*')
    .eq('round_no', roundNo)
    .maybeSingle()
  if (re) throw re
  const round = rData as LottoRound | null
  if (!round) return

  const { data: bData, error: be } = await sb().from('bets').select('*').eq('round_no', roundNo)
  if (be) throw be
  const bets = (bData ?? []) as Bet[]

  let winners = 0
  let prizeSum = 0
  for (const bet of bets) {
    const rank = gradeRank(bet.numbers, round.numbers, round.bonus)
    const prize = prizeForRank(round, rank)
    const { error } = await sb().from('bets').update({ rank, prize }).eq('id', bet.id)
    if (error) throw error
    if (rank != null) {
      winners += 1
      prizeSum += prize ?? 0
    }
    if (rank != null && rank <= 3 && bet.member_ref) {
      const { error: me } = await sb()
        .from('members')
        .update({ win_history: `${roundNo}회 ${rank}등` })
        .eq('id', bet.member_ref)
      if (me) throw me
    }
  }

  // 추천조합(weekly_recos) 당첨 집계 — 회원이 받은 추천번호를 당첨번호와 대조해 win_history 갱신(현장 6/29).
  // 실제 서비스는 베팅이 아니라 추천조합 발급이라, 이 집계가 '당첨자' 세그먼트의 실질 기준이다.
  const members = await selectAll<Member>('members')
  for (const m of members) {
    const meta = m.meta ?? {}
    const recos = Array.isArray(meta.weekly_recos) ? (meta.weekly_recos as WeeklyRecoIssue[]) : []
    const issue = recos.find((x) => x.round_no === roundNo)
    if (!issue) continue
    let best: number | null = null
    let wins = 0
    for (const set of issue.sets) {
      const rk = gradeRank(set, round.numbers, round.bonus)
      if (rk != null) {
        wins += 1
        if (best === null || rk < best) best = rk
      }
    }
    if (best != null) {
      winners += 1
      const { error: we } = await sb()
        .from('members')
        .update({ win_history: `${roundNo}회 ${best}등${wins > 1 ? ` (${wins}건)` : ''}` })
        .eq('id', m.id)
      if (we) throw we
    }
  }

  const { error: ue } = await sb()
    .from('lotto_rounds')
    .update({ confirmed_at: nowIso() })
    .eq('round_no', roundNo)
  if (ue) throw ue
  await insertLog({
    kind: 'admin',
    actor,
    action: 'lotto.confirm',
    target_type: 'lotto_round',
    target_id: String(roundNo),
    meta: { winners, prizeSum },
  })
}

/** 회차 등록(당첨번호 입력). 중복 회차는 거부. 미확정 상태로 추가. */
export async function registerRound(
  v: RegisterRoundInput,
  actor: string | null,
): Promise<RegisterResult> {
  const { data: existing, error: ce } = await sb()
    .from('lotto_rounds')
    .select('round_no')
    .eq('round_no', v.round_no)
    .maybeSingle()
  if (ce) throw ce
  if (existing) return { ok: false, error: '이미 존재하는 회차입니다.' }

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
  const { error } = await sb().from('lotto_rounds').insert(round)
  if (error) throw error
  await insertLog({
    kind: 'admin',
    actor,
    action: 'lotto.register',
    target_type: 'lotto_round',
    target_id: String(v.round_no),
    meta: { numbers: round.numbers, bonus: round.bonus },
  })
  return { ok: true }
}

// ── 회원 추천조합 발급(현장 피드백) — mock useIssueGradeReco 미러 ──────────────
function seedFor(id: string, round: number): number {
  let h = round * 2654435761
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h >>> 0
}

type MemberRow = { id: string; meta: Record<string, unknown> | null }

export async function fetchWeeklyRecoStatus(grade: Grade): Promise<{
  targetCount: number
  lastRound: number | null
  lastIssuedAt: string | null
}> {
  const { data, error } = await sb()
    .from('members')
    .select('id, meta')
    .eq('grade', grade)
    .eq('is_deleted', false)
    .eq('is_withdrawn', false)
  if (error) throw error
  const rows = (data ?? []) as MemberRow[]
  let lastRound: number | null = null
  let lastIssuedAt: string | null = null
  for (const r of rows) {
    const recos = Array.isArray(r.meta?.weekly_recos) ? (r.meta!.weekly_recos as WeeklyRecoIssue[]) : []
    const top = recos[0]
    if (top && (lastIssuedAt === null || top.issued_at > lastIssuedAt)) {
      lastIssuedAt = top.issued_at
      lastRound = top.round_no
    }
  }
  return { targetCount: rows.length, lastRound, lastIssuedAt }
}

export async function issueGradeReco(grade: Grade, actor: string | null): Promise<WeeklyIssueResult> {
  const settings = (await fetchSiteSettings()) as SiteSettings
  const cfg = settings.weekly_free_reco ?? WEEKLY_FREE_RECO_DEFAULT
  const setCount = Math.max(1, cfg.set_count || WEEKLY_FREE_RECO_DEFAULT.set_count)
  const ratio = cfg.logic_ratio ?? 100
  const rounds = await selectAll<LottoRound>('lotto_rounds') // 1000행 캡 회피(페이지네이션)
  const exclude = resolveExcludeForGrade(settings, grade)
  const targetRound = rounds.reduce((mx, r) => Math.max(mx, r.round_no), 0) + 1
  const trace = generateRecommendation(rounds, exclude, {
    mode: 20,
    setCount: 1,
    seed: seedFor(grade, targetRound),
  })

  const { data: mdata, error: me } = await sb()
    .from('members')
    .select('id, meta')
    .eq('grade', grade)
    .eq('is_deleted', false)
    .eq('is_withdrawn', false)
  if (me) throw me
  const rows = (mdata ?? []) as MemberRow[]
  const ts = nowIso()
  let issued = 0
  let skipped = 0
  for (const r of rows) {
    const recos = Array.isArray(r.meta?.weekly_recos) ? (r.meta!.weekly_recos as WeeklyRecoIssue[]) : []
    if (recos[0]?.round_no === targetRound) {
      skipped++
      continue
    }
    const mCount = typeof r.meta?.weekly_reco_count === 'number' && (r.meta.weekly_reco_count as number) > 0
      ? (r.meta.weekly_reco_count as number)
      : setCount
    const sets = generateIssueSets(rounds, exclude, mCount, ratio, seedFor(r.id, targetRound))
    const issue: WeeklyRecoIssue = { round_no: targetRound, issued_at: ts, sets }
    const meta = { ...(r.meta ?? {}), weekly_recos: [issue, ...recos].slice(0, 8) }
    const { error } = await sb().from('members').update({ meta }).eq('id', r.id)
    if (error) throw error
    issued++
  }
  if (issued > 0) {
    const record = makeGenerationRecord(trace, {
      createdBy: actor,
      grade,
      source: 'grade_issue',
      setCount,
      logicRatio: ratio,
      issuedCount: issued,
    })
    await patchSiteSettings(
      { generation_records: upsertGenerationRecord(settings.generation_records, record) },
      actor,
    )
  }
  await insertLog({
    kind: 'admin',
    actor,
    action: 'reco.weekly_issue',
    target_type: 'member',
    target_id: null,
    meta: { count: issued, skipped, round_no: targetRound, set_count: setCount, logic_ratio: ratio, grade, channel: 'console' },
  })
  return { issued, skipped, round_no: targetRound }
}
