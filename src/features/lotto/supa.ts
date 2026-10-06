// 로또기록 모듈 — supabase 쓰기 경로 (M7). dataSource==='supabase' 일 때 api.ts 의 뮤테이션이 호출.
// mock 의 mutateDb 부수효과(§8)를 미러링한다:
//   당첨 확정 → 회차 베팅 등수/당첨금 (재)산정 + 1~3등 회원 win_history 갱신 + confirmed_at + 로그
//   회차 등록 → 중복 검사 후 미확정 회차 추가 + 로그
// 회차/베팅은 전역 데이터(RLS 스코프 없음). 읽기(useRounds)는 fetchTables 스냅샷으로 재사용.
// 수동 재집계는 내구성 있는 작업으로 접수하고, 처리 진행과 완료는 health RPC로 확인한다.
import type { Grade, LottoRound, WeeklyRecoIssue } from '@/types/db'
import { requestGradeRecoBatch } from '@/lib/gradeRecoRequest'
import { insertLog, sb } from '@/lib/db/remote'
import { lottoSum, oddEven } from '@/lib/lotto'
import {
  type RegisterResult,
  type RegisterRoundInput,
  type WeeklyIssueResult,
} from './api'

/** 수동 확정/재집계는 DB 작업으로 접수한다. 실제 집계는 서버가 이어서 처리하며 문자는 보내지 않는다. */
export async function confirmRound(roundNo: number, _actor: string | null): Promise<void> {
  const { data, error } = await sb().rpc('lotto_sync_request_recount', { p_round_no: roundNo })
  if (error) throw new Error(`재집계 접수에 실패했습니다: ${error.message}`)
  if (!data || typeof data !== 'object' || data.ok !== true) {
    throw new Error('재집계 접수 결과를 확인하지 못했습니다. 새로고침 후 처리 상태를 확인해 주세요.')
  }
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

export async function issueGradeReco(grade: Grade, _actor: string | null): Promise<WeeklyIssueResult> {
  const { data: session, error: authError } = await sb().auth.getSession()
  if (authError || !session.session?.access_token) throw new Error('다시 로그인해 주세요.')
  const ids: string[] = []
  let cursor: string | null = null
  for (;;) {
    let query = sb().from('members').select('id').eq('grade', grade)
      .eq('is_deleted', false).eq('is_withdrawn', false).order('id').limit(1000)
    if (cursor !== null) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw error
    const rows = (data ?? []) as { id: string }[]
    ids.push(...rows.map(row => row.id))
    if (rows.length < 1000) break
    cursor = rows[rows.length - 1].id
  }
  let issued = 0
  let skipped = 0
  let roundNo: number | null = null
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = await requestGradeRecoBatch(ids.slice(offset, offset + 50), session.session.access_token)
    if (roundNo !== null && roundNo !== batch.round_no) throw new Error('발급 중 회차가 바뀌었습니다. 이미 처리한 발급 내역을 확인해 주세요.')
    roundNo = batch.round_no
    issued += batch.issued
    skipped += batch.skipped
  }
  if (roundNo === null) {
    const { data, error } = await sb().from('lotto_rounds').select('round_no').order('round_no', { ascending: false }).limit(1)
    if (error) throw error
    roundNo = Number(data?.[0]?.round_no ?? 0) + 1
  }
  return { issued, skipped, round_no: roundNo }
}
