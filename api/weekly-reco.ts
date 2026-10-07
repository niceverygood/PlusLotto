// 추천조합 발급 API — 크론 및 정확한 회원 목록의 수동 발급, 설정에 따른 SMS 요청.
// vercel.json crons 가 매일 00:00 UTC(=09:00 KST) 호출.
// 대상(현장 피드백 6/11 <추천번호> 7): ① 무료회원 = 기본 금요일(회원별 weekly_reco_day 우선)
// ② 유료 등 그 외 등급 = 회원정보창에 발송요일이 '설정된' 회원만, 그 요일에 발급.
// 세트수 = 회원별 weekly_reco_count(없으면 전역), 등급별 고정/제외 규칙 적용. 멱등(동일 회차 skip).
//
// ⚠️ 완전 자급자족 단일 파일: Vercel 함수 런타임(ESM)이 api/ 상대 import 를 해석하지 못해
// src/lib/lottoGenerator.ts 의 생성 로직 사본 + 최소 타입을 인라인한다(원본 수정 시 동기화).
//
// Vercel 환경변수: SUPABASE_URL(또는 VITE_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET
// 사전점검: GET ?dryRun=1 또는 POST { memberIds, dryRun: true }. 실발급은 DB 원자 선점 후에만 요청한다.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

// ── 최소 타입(소스: src/types/db.ts) ─────────────────────────────────────────
interface LottoRound {
  round_no: number
  draw_date: string
  numbers: number[]
  bonus: number
}
interface LottoExcludeSettings {
  fixed: number[]
  excluded: number[]
}
interface LottoExcludeRule {
  round_no: number
  grade: string | null
  fixed: number[]
  excluded: number[]
  effective_from: string
  created_at: string
}
interface WeeklyRecoIssue {
  round_no: number
  issued_at: string
  sets: number[][]
}
interface SiteSettingsLite {
  lotto_exclude: LottoExcludeSettings
  lotto_exclude_history?: LottoExcludeRule[]
  weekly_free_reco?: { enabled: boolean; set_count: number; logic_ratio?: number; paid_sms?: boolean }
  sms?: { oneshot_enabled?: boolean; sender_no?: string; by_site?: Record<string, { sender_no?: string }> }
  generation_records?: GenerationRecordLite[]
}

interface GenerationRecordLite {
  id: string
  created_at: string
  created_by: string | null
  grade: string | null
  target_round: number
  mode: number
  source?: 'preview' | 'grade_issue' | 'weekly_auto'
  fixed: number[]
  excluded: number[]
  reasons: ExclusionReason[]
  stages: ExclusionStage[]
  pool: number[]
  basis: GenerateBasis
  set_count: number
  logic_ratio: number
  issued_count: number
}

const LOTTO_MIN = 1
const LOTTO_MAX = 45
const LOTTO_PICK = 6

// 등급별 활성 고정/제외 규칙(소스: src/lib/lotto.ts resolveExcludeForGrade)
function resolveExcludeForGrade(settings: SiteSettingsLite, grade: string | null): LottoExcludeSettings {
  const d = new Date(Date.now() + 9 * 3600_000) // KST
  const today = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  // 동일 회차·등급·시작일 재등록 시 created_at 을 최종 타이브레이커로 둔다(현장 피드백 7/27).
  const effective = (settings.lotto_exclude_history ?? [])
    .filter((r) => r.effective_from <= today)
    .sort(
      (a, b) =>
        b.effective_from.localeCompare(a.effective_from) ||
        b.round_no - a.round_no ||
        b.created_at.localeCompare(a.created_at),
    )
  const pick = (g: string | null): LottoExcludeRule | undefined =>
    effective.find((r) => (r.grade ?? null) === g)
  const rule = (grade != null ? pick(grade) : undefined) ?? pick(null)
  return rule ? { fixed: rule.fixed, excluded: rule.excluded } : settings.lotto_exclude
}

// ── 이하 생성 로직: src/lib/lottoGenerator.ts 사본(임포트 제거) ─────────────────
// 로또(6/45) 추천 번호 생성기 — 순수 도메인 로직(React/UI 비의존).
//
// 운영사 「플러스로또 제외수 프로그램」의 문서화된 방식(프로그램_로직_제외수)을 그대로 구현한다.
// 핵심은 '제외수(excluded numbers)' 산정이다 — 과거 회차 데이터에서 5개 규칙으로 제외 후보를
// 뽑아 10·15·20개로 압축하고, 남은 풀(45 − 제외수)에서 패턴 품질 필터를 통과하는 6개 조합을 만든다.
//
// 5개 제외 규칙(문서 '플러스로또 프로그램 실제 적용 방식'):
//   ① 직전회차 — 직전 당첨 6개 중 최상위 2 + 최하위 1 = 3개
//   ② 직전회차 보너스 — 보너스 1개
//   ③ 월별 저출현 — 대상 추첨월에 역대 출현이 가장 적은 번호 (포아송·평균회귀 논거)
//   ④ 회차 저빈도 — 전체 저빈도 번호(대상 회차가 10의 배수면 가중)
//   ⑤ 40번대 과출현 — 최근 구간 40~45 중 과출현 2개
//   + 운영자 수동 제외(site_settings.lotto_exclude.excluded)는 항상 적용, 수동 고정수는 항상 포함.
//
// 데이터가 적으면(시드 16회차) 절대 임계치 대신 '순위 기반 압축'으로 동작한다 — 문서의 "압축 필터"와 동일.
//
// ⚠️ 확률 정직성: 6/45 모든 6개 조합의 1등 확률은 1/8,145,060 로 동일하다. 본 생성기는 제외수 기준에
// 따라 '제시할 조합을 선별'할 뿐 당첨 확률을 높이지 않는다. 어떤 함수/주석/반환값도 확률 향상을
// 단언하지 않는다(문서의 '확률이 N배 증가' 주장은 전제가 보장되지 않아 사실로 취급하지 않음).

// 제외수 개수 — 10/15/20 프리셋 외에 임의 개수 입력 가능(현장 피드백).
// 6개 조합이 남아야 하므로 1..(45-6)=39 로 클램프한다.
export type ExclusionMode = number

export const EXCLUSION_MODE_MIN = 1
export const EXCLUSION_MODE_MAX = LOTTO_MAX - LOTTO_PICK // 39

export function clampExclusionMode(n: number): number {
  if (!Number.isFinite(n)) return 20
  return Math.min(EXCLUSION_MODE_MAX, Math.max(EXCLUSION_MODE_MIN, Math.round(n)))
}

export interface GenerateOptions {
  mode: ExclusionMode
  /** 생성할 추천 조합 수. */
  setCount: number
  /** 재현 가능한 결과용 시드(미지정 시 무작위). */
  seed?: number
}

export interface ExclusionReason {
  number: number
  /** 규칙 키 — UI 라벨 매핑에 사용. */
  rule: ExclusionRuleKey
}

export type ExclusionRuleKey = 'prev' | 'bonus' | 'month' | 'freq' | 'forties' | 'manual' | 'patent'

export interface ExclusionStage {
  rule: ExclusionRuleKey
  candidates: number[]
  selected: number[]
}

export interface GenerateResult {
  targetRound: number
  drawMonth: number // 1..12
  mode: ExclusionMode
  excluded: number[] // 최종 제외수(오름차순)
  reasons: ExclusionReason[] // 번호별 제외 사유(중복 번호는 최상위 규칙 1개)
  stages: ExclusionStage[] // 규칙별 후보 → 최종 적용 과정
  fixed: number[] // 적용된 수동 고정수
  pool: number[] // 남은 풀(오름차순)
  sets: number[][] // 추천 조합(각 6개 오름차순)
  basis: GenerateBasis
}

export interface GenerateBasis {
  roundsUsed: number
  prevRound: number | null
  prevNumbers: number[] | null
  prevBonus: number | null
  sumBand: [number, number] // 조합 합 권장 밴드
  relaxed: boolean // 풀이 좁아 품질 필터를 완화했는지
}

const ALL_NUMBERS: readonly number[] = Array.from(
  { length: LOTTO_MAX - LOTTO_MIN + 1 },
  (_, i) => i + LOTTO_MIN,
)

// 규칙 배분(문서 '결과값' 20개 기준: 3+1+7+7+2=20). 10·15·20은 원본 표 그대로,
// 그 외 임의 개수는 같은 비율(직전3+보너스1 제외분을 월별·빈도에 균분)로 산정한다.
const RULE_QUOTA_PRESET: Record<number, { month: number; freq: number }> = {
  10: { month: 4, freq: 4 }, // 직전3·보너스1 + 월별4·빈도4 − 압축 = 상위 10
  15: { month: 5, freq: 6 },
  20: { month: 7, freq: 7 },
}

function ruleQuota(mode: number): { month: number; freq: number } {
  const preset = RULE_QUOTA_PRESET[mode]
  if (preset) return preset
  // 직전회차(3)+보너스(1) 후보를 제외한 나머지를 월별/빈도에 반씩 배분.
  const rest = Math.max(2, mode - 4)
  const month = Math.max(1, Math.floor(rest / 2))
  const freq = Math.max(1, rest - month)
  return { month, freq }
}

// ── PRNG (mulberry32) — 시드 가능한 결정적 난수 ─────────────────────────
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── 통계 헬퍼 ───────────────────────────────────────────────────────────
function sortedRoundsDesc(rounds: readonly LottoRound[]): LottoRound[] {
  return [...rounds].sort((a, b) => b.round_no - a.round_no)
}

/** 번호별 출현 횟수(최근 window 회차, 미지정 시 전체). */
export function numberFrequencies(
  rounds: readonly LottoRound[],
  window?: number,
): Map<number, number> {
  const desc = sortedRoundsDesc(rounds)
  const scope = window != null ? desc.slice(0, window) : desc
  const freq = new Map<number, number>()
  for (const n of ALL_NUMBERS) freq.set(n, 0)
  for (const r of scope) for (const n of r.numbers) freq.set(n, (freq.get(n) ?? 0) + 1)
  return freq
}

/** 대상 추첨월(1..12)에 한정한 번호별 출현 횟수. */
export function monthlyFrequencies(
  rounds: readonly LottoRound[],
  month: number,
): Map<number, number> {
  const freq = new Map<number, number>()
  for (const n of ALL_NUMBERS) freq.set(n, 0)
  for (const r of rounds) {
    if (new Date(r.draw_date).getMonth() + 1 !== month) continue
    for (const n of r.numbers) freq.set(n, (freq.get(n) ?? 0) + 1)
  }
  return freq
}

/** 조합 합의 권장 밴드 [lo, hi] — 역대 합 분포의 ~10~90 분위. 데이터 부족 시 표준 밴드. */
export function sumBand(rounds: readonly LottoRound[]): [number, number] {
  const sums = rounds.map((r) => r.numbers.reduce((a, n) => a + n, 0)).sort((a, b) => a - b)
  if (sums.length < 8) return [100, 175]
  const at = (q: number) => sums[Math.min(sums.length - 1, Math.floor(q * sums.length))]
  return [at(0.1), at(0.9)]
}

// 번호 → 구간 버킷(0:1-9, 1:10-19, 2:20-29, 3:30-39, 4:40-45).
function decadeBucket(n: number): number {
  return Math.min(4, Math.floor(n / 10))
}

function maxConsecutiveRun(sortedAsc: readonly number[]): number {
  let best = 1
  let cur = 1
  for (let i = 1; i < sortedAsc.length; i++) {
    cur = sortedAsc[i] === sortedAsc[i - 1] + 1 ? cur + 1 : 1
    if (cur > best) best = cur
  }
  return best
}

function consecutivePairCount(sortedAsc: readonly number[]): number {
  let c = 0
  for (let i = 1; i < sortedAsc.length; i++) if (sortedAsc[i] === sortedAsc[i - 1] + 1) c++
  return c
}

function oddCount(nums: readonly number[]): number {
  return nums.filter((n) => n % 2 === 1).length
}

// ── 제외수 산정 ─────────────────────────────────────────────────────────
interface Candidate {
  number: number
  rule: ExclusionRuleKey
  priority: number // 클수록 우선 제외
  score: number // 동순위 내 정렬(클수록 우선)
}

/**
 * 5개 규칙으로 제외 후보를 모아 mode(10/15/20)개로 압축한다.
 * 수동 제외는 항상 포함(압축 한도 무관), 수동 고정수는 후보에서 제거.
 */
export function computeExclusions(
  rounds: readonly LottoRound[],
  month: number,
  targetRound: number,
  mode: ExclusionMode,
  manual: LottoExcludeSettings,
): { excluded: number[]; reasons: ExclusionReason[]; stages: ExclusionStage[] } {
  const desc = sortedRoundsDesc(rounds)
  const prev = desc[0] ?? null
  const fixedSet = new Set(manual.fixed)
  const quota = ruleQuota(mode)
  const cands: Candidate[] = []

  // ① 직전회차 상위2·하위1
  if (prev) {
    const asc = [...prev.numbers].sort((a, b) => a - b)
    const picks = [asc[0], asc[asc.length - 1], asc[asc.length - 2]]
    for (const n of picks) cands.push({ number: n, rule: 'prev', priority: 100, score: 0 })
  }
  // ② 직전회차 보너스
  if (prev) cands.push({ number: prev.bonus, rule: 'bonus', priority: 95, score: 0 })

  // ③ 월별 저출현 — 해당 월 출현이 적은 번호 우선(동률은 전체 저빈도)
  {
    const mFreq = monthlyFrequencies(rounds, month)
    const allFreq = numberFrequencies(rounds)
    const ranked = [...ALL_NUMBERS].sort(
      (a, b) => (mFreq.get(a)! - mFreq.get(b)!) || (allFreq.get(a)! - allFreq.get(b)!),
    )
    for (const n of ranked.slice(0, quota.month)) {
      cands.push({ number: n, rule: 'month', priority: 80, score: 45 - (mFreq.get(n) ?? 0) })
    }
  }

  // ④ 회차 저빈도 — 전체 저빈도 번호. 대상 회차가 10의 배수면 우선순위 가중(문서 '10배수 회차').
  {
    const allFreq = numberFrequencies(rounds)
    const ranked = [...ALL_NUMBERS].sort((a, b) => allFreq.get(a)! - allFreq.get(b)!)
    const boost = targetRound % 10 === 0 ? 5 : 0
    for (const n of ranked.slice(0, quota.freq)) {
      cands.push({ number: n, rule: 'freq', priority: 70 + boost, score: 45 - (allFreq.get(n) ?? 0) })
    }
  }

  // ⑤ 40번대 과출현 2개 — 최근 20회차 기준 40~45 중 많이 나온 번호(과대 편입 회피)
  {
    const recent = numberFrequencies(rounds, 20)
    const forties = ALL_NUMBERS.filter((n) => n >= 40).sort(
      (a, b) => recent.get(b)! - recent.get(a)!,
    )
    for (const n of forties.slice(0, 2)) {
      cands.push({ number: n, rule: 'forties', priority: 60, score: recent.get(n) ?? 0 })
    }
  }

  // 고정수는 어떤 규칙으로도 제외하지 않는다.
  const statCands = cands.filter((c) => !fixedSet.has(c.number))

  // 번호별 최상위(priority,score) 후보만 남겨 압축 정렬 → 상위 mode개.
  const best = new Map<number, Candidate>()
  for (const c of statCands) {
    const cur = best.get(c.number)
    if (!cur || c.priority > cur.priority || (c.priority === cur.priority && c.score > cur.score)) {
      best.set(c.number, c)
    }
  }
  const compressed = [...best.values()]
    .sort((a, b) => b.priority - a.priority || b.score - a.score)
    .slice(0, clampExclusionMode(mode))

  // 수동 제외(고정수와 겹치면 고정수 우선) 병합.
  const reasons: ExclusionReason[] = []
  const seen = new Set<number>()
  for (const c of compressed) {
    reasons.push({ number: c.number, rule: c.rule })
    seen.add(c.number)
  }
  for (const n of manual.excluded) {
    if (fixedSet.has(n) || seen.has(n)) continue
    reasons.push({ number: n, rule: 'manual' })
    seen.add(n)
  }
  const excluded = [...seen].sort((a, b) => a - b)
  const stageOrder: ExclusionRuleKey[] = ['prev', 'bonus', 'month', 'freq', 'forties', 'manual']
  const stages = stageOrder.map((rule) => {
    const candidates = [
      ...new Set(
        rule === 'manual'
          ? manual.excluded.filter((n) => !fixedSet.has(n))
          : cands.filter((candidate) => candidate.rule === rule).map((candidate) => candidate.number),
      ),
    ].sort((a, b) => a - b)
    return { rule, candidates, selected: candidates.filter((number) => seen.has(number)) }
  })
  return { excluded, reasons, stages }
}

// ── 조합 품질 필터 ──────────────────────────────────────────────────────
interface QualityOpts {
  sumBand: [number, number]
  pastSets: Set<string>
  relaxed: boolean
}

function key(nums: readonly number[]): string {
  return [...nums].sort((a, b) => a - b).join('-')
}

/** 패턴 품질 판정(문서 '극단 조합 회피' + 특허 제2기준: 구간분포·홀짝·연번·합). */
function passesQuality(combo: readonly number[], opts: QualityOpts): boolean {
  const asc = [...combo].sort((a, b) => a - b)
  // 역대 동일 조합 회피
  if (opts.pastSets.has(asc.join('-'))) return false

  const buckets = new Set(asc.map(decadeBucket))
  const bucketCounts = new Map<number, number>()
  for (const n of asc) bucketCounts.set(decadeBucket(n), (bucketCounts.get(decadeBucket(n)) ?? 0) + 1)
  const maxBucket = Math.max(...bucketCounts.values())
  const odd = oddCount(asc)
  const total = asc.reduce((a, n) => a + n, 0)

  // 완화 모드(풀이 좁을 때): 한 구간 몰림과 연속 6연번만 막는다.
  if (opts.relaxed) {
    return maxBucket <= 5 && maxConsecutiveRun(asc) < LOTTO_PICK
  }

  if (buckets.size < 3) return false // 최소 3개 구간 분산
  if (maxBucket >= 4) return false // 한 구간 4개 이상 몰림 회피(예: 40번대만)
  if (odd === 0 || odd === LOTTO_PICK) return false // 전홀/전짝 회피
  if (maxConsecutiveRun(asc) >= 3) return false // 3연번 이상 회피
  if (consecutivePairCount(asc) > 1) return false // 연속쌍 최대 1
  if (total < opts.sumBand[0] || total > opts.sumBand[1]) return false // 합 밴드
  return true
}

// ── 조합 생성 ───────────────────────────────────────────────────────────
function drawCombo(pool: readonly number[], fixed: readonly number[], rng: () => number): number[] {
  const need = LOTTO_PICK - fixed.length
  const bag = pool.filter((n) => !fixed.includes(n))
  // Fisher–Yates 부분 셔플
  const arr = [...bag]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return [...fixed, ...arr.slice(0, need)].sort((a, b) => a - b)
}

function generateSets(
  pool: readonly number[],
  fixed: readonly number[],
  count: number,
  rng: () => number,
  band: [number, number],
  pastSets: Set<string>,
): { sets: number[][]; relaxed: boolean } {
  const out: number[][] = []
  const used = new Set<string>()
  let relaxed = false
  const TRY_PER_SET = 400

  while (out.length < count) {
    let placed = false
    for (let attempt = 0; attempt < TRY_PER_SET; attempt++) {
      const combo = drawCombo(pool, fixed, rng)
      const k = key(combo)
      if (used.has(k)) continue
      if (passesQuality(combo, { sumBand: band, pastSets, relaxed })) {
        out.push(combo)
        used.add(k)
        placed = true
        break
      }
    }
    if (!placed) {
      if (!relaxed) {
        relaxed = true // 1차 실패 → 필터 완화 후 재시도
        continue
      }
      // 완화로도 새 조합을 못 뽑으면(풀 고갈) 종료.
      break
    }
  }
  return { sets: out, relaxed }
}

// ── 오케스트레이션 ──────────────────────────────────────────────────────
/**
 * 추천 결과 생성. rounds 가 비면 빈 결과(sets=[]) 를 돌려준다(페이지가 안내).
 * targetRound = 최신 회차 + 1, drawMonth 는 직전 추첨월 기준(없으면 현재월).
 */
export function generateRecommendation(
  rounds: readonly LottoRound[],
  manual: LottoExcludeSettings,
  opts: GenerateOptions,
): GenerateResult {
  const desc = sortedRoundsDesc(rounds)
  const prev = desc[0] ?? null
  const targetRound = prev ? prev.round_no + 1 : 1
  const drawMonth = prev ? new Date(prev.draw_date).getMonth() + 1 : new Date().getMonth() + 1
  const band = sumBand(rounds)
  const rng = makeRng(opts.seed ?? (Date.now() & 0xffffffff))

  const { excluded, reasons, stages } = computeExclusions(rounds, drawMonth, targetRound, opts.mode, manual)

  // 고정수는 항상 포함(제외수와 상호배타 — 설정 UI 보장, 여기서도 방어).
  const fixed = manual.fixed.filter((n) => n >= LOTTO_MIN && n <= LOTTO_MAX).slice(0, LOTTO_PICK)
  const excludedSet = new Set(excluded)
  for (const f of fixed) excludedSet.delete(f)

  let pool = ALL_NUMBERS.filter((n) => !excludedSet.has(n))
  // 풀 하한 방어: 통계 제외가 과해 6개 미만이면 우선순위 낮은 제외부터 되돌린다(수동 제외는 유지).
  if (pool.length < LOTTO_PICK) {
    const manualSet = new Set(manual.excluded)
    const droppable = [...excludedSet].filter((n) => !manualSet.has(n))
    while (pool.length < LOTTO_PICK && droppable.length) {
      const back = droppable.pop()!
      excludedSet.delete(back)
      pool = ALL_NUMBERS.filter((n) => !excludedSet.has(n))
    }
  }

  const pastSets = new Set(rounds.map((r) => key(r.numbers)))
  const { sets, relaxed } =
    pool.length >= LOTTO_PICK
      ? generateSets(pool, fixed, Math.max(1, opts.setCount), rng, band, pastSets)
      : { sets: [], relaxed: false }

  const finalExcluded = ALL_NUMBERS.filter((n) => !pool.includes(n))
  return {
    targetRound,
    drawMonth,
    mode: opts.mode,
    excluded: finalExcluded,
    reasons: reasons.filter((r) => finalExcluded.includes(r.number)),
    stages: stages.map((stage) => ({
      ...stage,
      selected: stage.selected.filter((number) => finalExcluded.includes(number)),
    })),
    fixed,
    pool,
    sets,
    basis: {
      roundsUsed: rounds.length,
      prevRound: prev?.round_no ?? null,
      prevNumbers: prev ? [...prev.numbers].sort((a, b) => a - b) : null,
      prevBonus: prev?.bonus ?? null,
      sumBand: band,
      relaxed,
    },
  }
}

export const EXCLUSION_RULE_LABEL: Record<ExclusionRuleKey, string> = {
  prev: '직전회차 상·하위',
  bonus: '직전 보너스',
  month: '월별 저출현',
  freq: '저빈도',
  forties: '40번대 과출현',
  manual: '수동 제외',
  patent: '특허 제외수 로직',
}

export const MODE_OPTIONS: ExclusionMode[] = [10, 15, 20]

// ── 이하 특허 제외수 로직: src/lib/lottoPatentExclude.ts 사본(임포트 제거, 현장 피드백 7/23) ──────
// 실버(goldp)·골드(vip)·다이아(royal) 3개 유료등급 전용 — 위 통계 제외수 엔진(computeExclusions/
// passesQuality)과는 완전히 별도 경로. 원본 수정 시 이 사본도 동기화할 것(파일 상단 경고 참조).
type PatentGrade = 'goldp' | 'vip' | 'royal'
function isPatentGrade(grade: string | null | undefined): grade is PatentGrade {
  return grade === 'goldp' || grade === 'vip' || grade === 'royal'
}

interface PatentFilters {
  sumBand: boolean
  oddEven343: boolean
  consecutivePairMax2: boolean
  segmentMax3: boolean
  carryoverMax2: boolean
  lastDigitMax2: boolean
}
interface PatentGradeConfig {
  window: number | 'all'
  excludeCount: number
  filters: PatentFilters
}
const SILVER_FILTERS: PatentFilters = {
  sumBand: true,
  oddEven343: true,
  consecutivePairMax2: false,
  segmentMax3: false,
  carryoverMax2: false,
  lastDigitMax2: false,
}
const GOLD_FILTERS: PatentFilters = { ...SILVER_FILTERS, consecutivePairMax2: true, segmentMax3: true, carryoverMax2: true }
const DIAMOND_FILTERS: PatentFilters = { ...GOLD_FILTERS, lastDigitMax2: true }
const PATENT_CONFIG: Record<PatentGrade, PatentGradeConfig> = {
  goldp: { window: 10, excludeCount: 5, filters: SILVER_FILTERS }, // 실버
  vip: { window: 30, excludeCount: 8, filters: GOLD_FILTERS }, // 골드
  royal: { window: 'all', excludeCount: 12, filters: DIAMOND_FILTERS }, // 다이아
}

function patentFreqScore(ratio: number): number {
  if (ratio >= 0.4) return 50
  if (ratio >= 0.3) return 35
  if (ratio >= 0.2) return 20
  if (ratio >= 0.1) return 5
  return 0
}
function patentGapScore(gap: number): number {
  if (gap >= 15) return 50
  if (gap >= 10) return 35
  if (gap >= 5) return 20
  if (gap >= 2) return 5
  return 0 // gap 0(직전출현)·1(경계 미명시, 0점 처리)
}
interface PatentNumberScore {
  number: number
  total: number
}
function patentScoreWindow(roundsDesc: readonly LottoRound[], windowSize: number): PatentNumberScore[] {
  const win = roundsDesc.slice(0, windowSize)
  const n = win.length
  const out: PatentNumberScore[] = []
  for (let num = LOTTO_MIN; num <= LOTTO_MAX; num++) {
    let appear = 0
    let gap = n
    for (let i = 0; i < n; i++) {
      if (win[i].numbers.includes(num)) {
        appear++
        if (gap === n) gap = i
      }
    }
    const ratio = n > 0 ? appear / n : 0
    out.push({ number: num, total: patentFreqScore(ratio) + patentGapScore(gap) })
  }
  return out
}

/** N/N+1위 동점이면 창을 10회차씩 늘려 재계산 — window 는 유한 회차 내에서만 늘어나 항상 종료한다. */
function computePatentExcludeSet(
  roundsDesc: readonly LottoRound[],
  baseWindow: number | 'all',
  excludeCount: number,
  fixedSet: ReadonlySet<number>,
): { excluded: number[]; window: number } {
  const maxAvailable = roundsDesc.length
  let window = baseWindow === 'all' ? maxAvailable : Math.min(baseWindow, maxAvailable)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const scores = patentScoreWindow(roundsDesc, window).filter((s) => !fixedSet.has(s.number))
    const sorted = [...scores].sort((a, b) => b.total - a.total || a.number - b.number)
    const cutoff = sorted[excludeCount - 1]?.total ?? 0
    const next = sorted[excludeCount]?.total
    const tiedAtBoundary = next !== undefined && next === cutoff
    const canGrow = baseWindow !== 'all' && window < maxAvailable
    if (!tiedAtBoundary || !canGrow) return { excluded: sorted.slice(0, excludeCount).map((s) => s.number), window }
    window = Math.min(window + 10, maxAvailable)
  }
}

function passesPatentFilters(
  asc: readonly number[],
  filters: PatentFilters,
  prevNumbers: readonly number[],
  relaxed: boolean,
): boolean {
  if (relaxed) return maxConsecutiveRun(asc) < LOTTO_PICK
  if (filters.sumBand) {
    const total = asc.reduce((a, n) => a + n, 0)
    if (total < 100 || total > 175) return false
  }
  if (filters.oddEven343) {
    const odd = oddCount(asc)
    if (odd !== 2 && odd !== 3 && odd !== 4) return false
  }
  if (filters.consecutivePairMax2 && consecutivePairCount(asc) >= 3) return false
  if (filters.segmentMax3) {
    const counts = new Map<number, number>()
    for (const n of asc) counts.set(decadeBucket(n), (counts.get(decadeBucket(n)) ?? 0) + 1)
    if (Math.max(...counts.values()) >= 4) return false
  }
  if (filters.carryoverMax2) {
    const overlap = asc.filter((n) => prevNumbers.includes(n)).length
    if (overlap >= 3) return false
  }
  if (filters.lastDigitMax2) {
    const counts = new Map<number, number>()
    for (const n of asc) counts.set(n % 10, (counts.get(n % 10) ?? 0) + 1)
    if (Math.max(...counts.values()) >= 3) return false
  }
  return true
}

function generatePatentCombos(
  pool: readonly number[],
  fixed: readonly number[],
  count: number,
  rng: () => number,
  filters: PatentFilters,
  prevNumbers: readonly number[],
  pastSets: ReadonlySet<string>,
): number[][] {
  const out: number[][] = []
  const used = new Set<string>()
  let relaxed = false
  const TRY_PER_SET = 400
  while (out.length < count) {
    let placed = false
    for (let attempt = 0; attempt < TRY_PER_SET; attempt++) {
      const combo = drawCombo(pool, fixed, rng)
      const k = key(combo)
      if (used.has(k) || pastSets.has(k)) continue
      if (passesPatentFilters(combo, filters, prevNumbers, relaxed)) {
        out.push(combo)
        used.add(k)
        placed = true
        break
      }
    }
    if (!placed) {
      if (!relaxed) {
        relaxed = true
        continue
      }
      break
    }
  }
  return out
}

interface PatentGenerateResult {
  sets: number[][]
  excluded: number[]
  autoExcluded: number[]
  window: number
  fixed: number[]
  pool: number[]
  targetRound: number
  prevRound: number | null
  prevNumbers: number[] | null
  prevBonus: number | null
}

function generatePatentSets(
  rounds: readonly LottoRound[],
  grade: PatentGrade,
  manual: LottoExcludeSettings,
  setCount: number,
  seed?: number,
): PatentGenerateResult {
  const cfg = PATENT_CONFIG[grade]
  const desc = sortedRoundsDesc(rounds)
  const prev = desc[0] ?? null
  const targetRound = prev ? prev.round_no + 1 : 1
  const fixed = manual.fixed.filter((n) => n >= LOTTO_MIN && n <= LOTTO_MAX).slice(0, LOTTO_PICK)
  const fixedSet = new Set(fixed)

  const { excluded: autoExcluded, window } = computePatentExcludeSet(desc, cfg.window, cfg.excludeCount, fixedSet)
  const excludedSet = new Set<number>([...autoExcluded, ...manual.excluded])
  for (const f of fixedSet) excludedSet.delete(f)

  let pool = ALL_NUMBERS.filter((n) => !excludedSet.has(n))
  if (pool.length < LOTTO_PICK) {
    const manualSet = new Set(manual.excluded)
    const droppable = autoExcluded.filter((n) => !manualSet.has(n))
    while (pool.length < LOTTO_PICK && droppable.length) {
      const back = droppable.pop()!
      excludedSet.delete(back)
      pool = ALL_NUMBERS.filter((n) => !excludedSet.has(n))
    }
  }

  const prevNumbers = prev ? [...prev.numbers].sort((a, b) => a - b) : []
  const pastSets = new Set(rounds.map((r) => key(r.numbers)))
  const rng = makeRng(seed ?? (Date.now() & 0xffffffff))
  const sets =
    pool.length >= LOTTO_PICK
      ? generatePatentCombos(pool, fixed, Math.max(1, setCount), rng, cfg.filters, prevNumbers, pastSets)
      : []

  return {
    sets,
    excluded: [...excludedSet].sort((a, b) => a - b),
    autoExcluded,
    window,
    fixed,
    pool,
    targetRound,
    prevRound: prev?.round_no ?? null,
    prevNumbers: prev ? prevNumbers : null,
    prevBonus: prev?.bonus ?? null,
  }
}

/** 발급 조합(등급 인지) — 특허 3등급은 위 로직, 그 외는 기존 통계 로직 + 완전랜덤 보충(비율 혼합). */
function generateIssueSetsForGrade(
  rounds: readonly LottoRound[],
  grade: string,
  exclude: LottoExcludeSettings,
  count: number,
  logicRatio: number,
  seed?: number,
): number[][] {
  const total = Math.max(1, count)
  const ratio = Math.max(0, Math.min(100, Math.round(logicRatio)))
  const logicCount = Math.max(0, Math.min(total, Math.round((total * ratio) / 100)))
  const sets: number[][] = isPatentGrade(grade)
    ? logicCount > 0
      ? generatePatentSets(rounds, grade, exclude, logicCount, seed).sets
      : []
    : logicCount > 0
      ? generateRecommendation(rounds, exclude, { mode: 20, setCount: logicCount, seed }).sets
      : []
  const seen = new Set(sets.map((s) => s.join('-')))
  const randomCount = total - sets.length
  let guard = 0
  while (sets.length < total && guard++ < Math.max(1, randomCount) * 200) {
    const poolAll = Array.from({ length: LOTTO_MAX - LOTTO_MIN + 1 }, (_, i) => i + LOTTO_MIN)
    for (let i = poolAll.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[poolAll[i], poolAll[j]] = [poolAll[j], poolAll[i]]
    }
    const set = poolAll.slice(0, LOTTO_PICK).sort((a, b) => a - b)
    const k = set.join('-')
    if (seen.has(k)) continue
    seen.add(k)
    sets.push(set)
  }
  return sets
}

// ── 유료회원 지정요일 조합 SMS 자동발송(현장 피드백 6/18) ────────────────────────
// 유료 등급(골드/골드+/VIP/로얄)만 대상. 무료는 발급만(문자 X).
const PAID_GRADES = new Set(['gold', 'goldp', 'vip', 'royal'])

/**
 * 조합 목록 → SMS 본문(LMS). src/lib/sms.ts recoSmsBody 와 동일 규칙(자급자족 중복, 상단 참조).
 * 본문은 sms_templates 'recommend' 템플릿에서 온다(현장 피드백 8/4, 정의현 차장 — "조합문자 발송
 * 내용을 설정 > 기본문자 템플릿에서 수정하면 변경할수 있도록. 스팸관련해서 지속적으로 변경").
 * 변수: $round(회차) · $name · $num(조합 리스트).
 * 회차 표기: 7/22 에는 스팸필터 회피로 1236→12.36 처럼 점을 넣었으나, 현장 요청(8/6, 정의현 차장 —
 * "회차 사이에 '.' 삭제 부탁드립니다")으로 점 없이 그대로 쓴다(src/lib/sms.ts roundText 와 동일).
 * 템플릿이 비었으면 기존 하드코딩 포맷(plus No. 한 줄, 현장 7/30)으로 폴백.
 */
const RECO_TEMPLATE_FALLBACK = 'plus No. $round\n$name님\n$num'
const LEGACY_PLUS_DEFAULT_TEMPLATE = 'plus No. $round\n$num'

const RECO_SITE_BRANDS = new Map([
  ['pluslotto', '플러스로또'], ['lotto815', '815로또'], ['infolotto', '인포로또'],
  ['cplotto', '일행로또'], ['best', '프리미엄로또'],
])

export function formatComboSms(
  name: string,
  roundNo: number,
  sets: number[][],
  templateBody?: string | null,
  meta?: Record<string, unknown> | null,
): string {
  const round = String(Math.max(0, Math.trunc(roundNo)))
  const lines = sets.map((s, i) => `[${i + 1}] ${s.join(',')}`).join('\n')
  const source = typeof meta?.source_site === 'string' ? meta.source_site.trim() : 'pluslotto'
  const siteBrand = RECO_SITE_BRANDS.get(source)
  const brand = siteBrand ?? '플러스로또'
  // 레거시 사이트도 같은 템플릿을 쓰므로 $brand를 회원 계약 기준으로 치환한다.
  // 템플릿 미설정 때만 사이트별 폴백을 사용하고 기존 플러스 문구는 보존한다.
  const fallback = source !== 'pluslotto' && siteBrand
    ? '$brand No. $round\n$name님\n$num'
    : RECO_TEMPLATE_FALLBACK
  // 2026-10-02 운영에 남아 있는 정확한 구 기본 템플릿만 이관 계약의 브랜드로 바꾼다.
  // DB 템플릿과 사용자 지정 문구는 유지하고, 출처 없는 기존 플러스 경로는 그대로 둔다.
  const body = source !== 'pluslotto' && siteBrand && templateBody === LEGACY_PLUS_DEFAULT_TEMPLATE
    ? '$brand No. $round\n$num'
    : templateBody?.trim() ? templateBody : fallback
  return body
    .replace(/\$round/g, round)
    .replace(/\$name/g, name || '회원')
    .replace(/\$num/g, lines)
    .replace(/\$brand/g, brand)
}

/** 한국 문자 바이트 길이(비ASCII=2byte). SMS=90byte 기준. (src/lib/oneshot.ts koByteLength 동기화) */
function koByteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0x7f ? 2 : 1
  return n
}

/** 검증된 발송 함수(/api/send-sms, Fixie 프록시 경유)를 재사용해 1건 발송. */
async function sendComboSms(
  base: string,
  memberId: string,
  dest: string,
  body: string,
  sender: string,
  sourceSite: string,
): Promise<{ outcome: 'accepted' | 'rejected' | 'unknown'; code: string; receipt: Record<string, unknown> }> {
  try {
    const r = await fetch(`${base}/api/send-sms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 서버-서버 인증(보안 D68) — send-sms 가 내부 호출을 식별.
        ...(process.env.CRON_SECRET ? { 'x-internal-secret': process.env.CRON_SECRET } : {}),
      },
      // msgType 명시(D68): 조합 본문은 90byte 초과라 LMS — 미지정 시 SMS 로 처리돼 402 길이초과 전건 실패.
      body: JSON.stringify({
        member_id: memberId,
        source_site: sourceSite,
        dest_phone: dest,
        msg_body: body,
        send_phone: sender,
        msgType: koByteLength(body) <= 90 ? 'SMS' : 'LMS',
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const d: unknown = await r.json()
    if (!object(d)) return { outcome: 'unknown', code: 'INVALID_RESPONSE', receipt: { code: 'INVALID_RESPONSE', httpStatus: r.status, body } }
    const code = typeof d.code === 'string' && d.code ? d.code : 'UNKNOWN'
    const outcome = r.ok && d.ok === true && code !== 'UNKNOWN' ? 'accepted'
      : d.ok === false && !['UNKNOWN', 'NET', 'NET_ERR', 'EXCEPTION'].includes(code) ? 'rejected' : 'unknown'
    return { outcome, code, receipt: { code, cmid: typeof d.cmid === 'string' ? d.cmid : null,
      httpStatus: r.status, body } }
  } catch {
    return { outcome: 'unknown', code: 'NET', receipt: { code: 'NET', body } }
  }
}

// ── 크론 핸들러 ───────────────────────────────────────────────────────────────
const DEFAULT_DAY = 5 // 금요일(0=일..6=토)
const DEFAULT_COUNT = 30

export type RecoSafetyBlockReason = 'paused' | 'expired' | null

/** Date.now() 계열 값을 한국 영업일(YYYY-MM-DD)로 고정한다. */
export function kstDay(nowMs: number): string {
  const d = new Date(nowMs + 9 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * 종료일/일시정지 안전 게이트.
 *
 * - `reco_paused=true` 는 수동 실행(force=1)에서도 절대 우회하지 않는다.
 * - `end_date` 는 회원정보창과 레거시 이관 모두 날짜(YYYY-MM-DD)를 기준으로 저장한다.
 * - 종료일 당일까지는 이용 가능하며, KST 오늘보다 이전인 경우에만 차단한다.
 * - 값이 없거나 유효하지 않으면 임의로 만료시키지 않는다.
 */
export function recoSafetyBlockReason(
  meta: Record<string, unknown> | null | undefined,
  todayKst: string,
): RecoSafetyBlockReason {
  if (meta?.reco_paused === true) return 'paused'

  const raw = meta?.end_date
  if (typeof raw !== 'string') return null
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null
  }

  const endDay = `${match[1]}-${match[2]}-${match[3]}`
  return endDay < todayKst ? 'expired' : null
}

/**
 * 자동발급 대상 판정(순수 함수).
 *
 * 발송 루프와 발송 후 누락 대조(recoAuditMisses)가 **같은 함수**를 쓴다. 판정 규칙이 두 곳에
 * 따로 적혀 있으면 한쪽만 고쳐질 때 "정상 제외"가 누락으로 잡혀 허위 목록이 나간다. 허위가 섞인
 * 누락 목록은 현장이 목록 자체를 무시하게 만들어 진짜 누락을 놓치게 한다(현장 9/12 — "조합발송
 * 누락시, 민원발생으로 취소요청건에 대한 방어가 어렵습니다").
 *
 * 반환값이 null 이면 이번 회차 발급 대상이다.
 */
export type RecoSkipReason = 'day' | 'paused' | 'expired' | 'count-zero' | 'already' | null

export interface RecoGateCtx {
  /** KST 요일(0=일). */
  today: number
  todayKst: string
  force: boolean
  /** 무료 자동발급 토글(site_settings.weekly_free_reco.enabled). */
  autoEnabled: boolean
  /** 유료 지정요일 조합 SMS 가동 여부. */
  paidSmsOn: boolean
  targetRound: number
}

export function recoSkipReason(
  row: { grade: string; meta: Record<string, unknown> | null | undefined },
  ctx: RecoGateCtx,
): RecoSkipReason {
  const meta = row.meta ?? {}
  const day =
    typeof meta.weekly_reco_day === 'number'
      ? (meta.weekly_reco_day as number)
      : row.grade === 'free'
        ? DEFAULT_DAY
        : null // 유료 등 — 발송요일 미설정이면 자동발급 대상 아님
  if (day === null || (!ctx.force && day !== ctx.today)) return 'day'
  // 무료 자동발급 OFF 시: 유료 지정요일 SMS 대상만 계속, 그 외는 발급 안 함(D68 #12).
  if (!ctx.autoEnabled && !ctx.force && !(ctx.paidSmsOn && PAID_GRADES.has(row.grade))) return 'day'
  // 일시정지·종료일 경과는 force=1 도 우회하지 않는다.
  const safetyBlock = recoSafetyBlockReason(meta, ctx.todayKst)
  if (safetyBlock !== null) return safetyBlock
  // 발송갯수 명시적 0 → 발급·문자 제외(현장 6/26).
  if (meta.weekly_reco_count === 0) return 'count-zero'
  const recos = Array.isArray(meta.weekly_recos) ? (meta.weekly_recos as WeeklyRecoIssue[]) : []
  if (recos.some(issue => issue?.round_no === ctx.targetRound && !isAdditionalManualIssue(issue))) return 'already'
  return null
}

/** This hint only separates new manual issues in eligibility; the DB also verifies the exact ledger issue. */
function isAdditionalManualIssue(issue: unknown): boolean {
  return object(issue) && typeof issue.manual_request_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(issue.manual_request_id)
}

/** 조합 SMS 가 나가야 하는 회원인지 — 유료 SMS 가동 + 유료등급 + 번호 보유. */
export function expectsComboSms(
  row: { grade: string; phone: string | null },
  ctx: { paidSmsOn: boolean },
): boolean {
  return ctx.paidSmsOn && PAID_GRADES.has(row.grade) && !!row.phone
}

/**
 * 발송 후 누락 대조(순수 함수).
 *
 * 현장 요청(9/12, 정의현 차장 — "추후 누락회원 발생치 않도록 부탁드리겠습니다"). 발송이 끝난 뒤
 * "받아야 했는데 못 받은 회원"만 추려낸다.
 *
 * 허위를 섞지 않는 것이 이 기능의 전부다. 아래 네 가지는 **정상적인 제외**이며 누락이 아니다.
 * 이걸 빼먹으면 신규 가입자·종료회원까지 매번 목록에 올라와, 현장이 목록을 믿지 않게 된다.
 *   1) 발송 시작 이후 가입 — 애초에 대상이 아니었다(registered_after)
 *   2) 종료일 경과(expired) · 3) 일시정지(paused) · 4) 발송갯수 0(count_zero)
 *   (+ 그날 지정요일이 아닌 회원은 day 로 제외)
 * 판정은 발송 루프와 **같은 recoSkipReason** 을 쓰므로 규칙이 갈라질 수 없다.
 *
 * 누락은 세 종류로 나눈다.
 *   not_issued  — 조합 자체가 발급되지 않음(2026-09-16 88로또 951명 사고 유형: 함수 중단/타임아웃)
 *   sms_missing — 발급은 됐는데 문자 기록이 없음(발송 단계에서 끊김)
 *   sms_failed  — 문자업체가 실패로 응답(재발송 대상)
 */
export type RecoMissReason = 'not_issued' | 'sms_missing' | 'sms_failed'

export interface RecoMiss {
  member_id: string
  name: string | null
  phone: string | null
  grade: string
  reason: RecoMissReason
}

export interface RecoAuditExcluded {
  day: number
  paused: number
  expired: number
  count_zero: number
  registered_after: number
  no_phone: number
}

export interface RecoAuditResult {
  round_no: number
  /** 대조한 전체 회원 수. */
  checked: number
  /** 이번 회차에 발급됐어야 하는 회원 수(정상 제외분 제외). */
  expected: number
  misses: RecoMiss[]
  excluded: RecoAuditExcluded
}

export interface RecoAuditCtx extends RecoGateCtx {
  /** 이번 발송이 시작된 시각(ISO). 이후 가입자는 대상이 아니므로 제외한다. */
  sinceIso: string
  /** 이번 회차 조합문자 발송완료 회원 id. */
  smsOk: Set<string>
  /** 이번 회차 조합문자 실패 회원 id. */
  smsFail: Set<string>
}

export function recoAuditMisses(
  rows: {
    id: string
    grade: string
    name: string | null
    phone: string | null
    meta: Record<string, unknown> | null
    registered_at?: string | null
  }[],
  ctx: RecoAuditCtx,
): RecoAuditResult {
  const misses: RecoMiss[] = []
  const excluded: RecoAuditExcluded = {
    day: 0,
    paused: 0,
    expired: 0,
    count_zero: 0,
    registered_after: 0,
    no_phone: 0,
  }
  let expected = 0

  for (const r of rows) {
    // 발송 시작 이후 가입 — 이번 회차 대상이 아니다. 가장 먼저 걸러야 신규 가입자가
    // 매번 누락으로 올라오는 일이 없다.
    if (typeof r.registered_at === 'string' && r.registered_at > ctx.sinceIso) {
      excluded.registered_after++
      continue
    }
    const skip = recoSkipReason(r, ctx)
    if (skip === 'day') {
      excluded.day++
      continue
    }
    if (skip === 'paused') {
      excluded.paused++
      continue
    }
    if (skip === 'expired') {
      excluded.expired++
      continue
    }
    if (skip === 'count-zero') {
      excluded.count_zero++
      continue
    }

    expected++
    if (skip === null) {
      // 발급 대상인데 아직 발급 기록이 없다 = 조합 자체가 안 나갔다.
      misses.push({ member_id: r.id, name: r.name, phone: r.phone, grade: r.grade, reason: 'not_issued' })
      continue
    }
    // skip === 'already' — 발급은 됐다. 조합문자 대상이면 문자까지 확인한다.
    if (!expectsComboSms(r, ctx)) {
      // 유료인데 번호가 없으면 문자를 보낼 수 없다 — 누락이 아니라 회원정보 문제로 따로 센다.
      if (ctx.paidSmsOn && PAID_GRADES.has(r.grade) && !r.phone) excluded.no_phone++
      continue
    }
    if (ctx.smsOk.has(r.id)) continue
    misses.push({
      member_id: r.id,
      name: r.name,
      phone: r.phone,
      grade: r.grade,
      reason: ctx.smsFail.has(r.id) ? 'sms_failed' : 'sms_missing',
    })
  }

  return { round_no: ctx.targetRound, checked: rows.length, expected, misses, excluded }
}

export interface MemberScanRow {
  id: string
  grade: string
  name: string | null
  phone: string | null
  meta: Record<string, unknown> | null
  registered_at: string | null
  assigned_staff_id?: string | null
}

/**
 * 발급·대조 대상 회원 전체 스캔.
 *
 * offset(range) 이 아니라 커서(id 오름차순 + gt) 로 읽는다. offset 은 읽는 도중 회원이 추가·삭제되면
 * 페이지 경계가 밀려 같은 회원을 두 번 읽거나(문자 이중발송) 건너뛴다(발송 누락). 커서는 "마지막으로
 * 읽은 id 다음부터"라 동시 변경과 무관하게 각 행을 정확히 한 번 읽는다.
 */
export async function scanMembers(
  sb: SupabaseClient,
  page: number,
  memberIds?: string[],
  dayFilter?: { today: number },
): Promise<MemberScanRow[]> {
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('INVALID_MEMBER_SCAN_PAGE')
  if (dayFilter && (!Number.isInteger(dayFilter.today) || dayFilter.today < 0 || dayFilter.today > 6))
    throw new Error('INVALID_MEMBER_SCAN_DAY')
  // 2026-10-07: 전 회원(meta 포함 ~3.3만 행) 스캔이 4분 예산을 다 써 발급 0건으로 끝났다.
  // 정기 실행(GET, force 아님)은 오늘 요일 후보만 DB에서 거른다. recoSkipReason 의 요일 판정보다
  // 넓은 상위집합(문자열 "3" 등도 포함)이며 최종 판정은 그대로 recoSkipReason 이 한다.
  // 무료 + 요일 미설정 회원은 DEFAULT_DAY(금)에만 포함한다.
  const dayOr = dayFilter
    ? dayFilter.today === DEFAULT_DAY
      ? `meta->>weekly_reco_day.eq.${dayFilter.today},and(grade.eq.free,meta->>weekly_reco_day.is.null)`
      : `meta->>weekly_reco_day.eq.${dayFilter.today}`
    : null
  const rows: MemberScanRow[] = []
  let cursor: string | null = null
  let readPage = page
  for (;;) {
    let q = sb
      .from('members')
      .select('id, grade, name, phone, meta, registered_at, assigned_staff_id, status')
      .eq('status', 'active')
      .eq('is_deleted', false)
      .eq('is_withdrawn', false)
      .eq('is_suspended', false) // 일시정지(정지) 회원은 자동발급·문자 제외(현장 6/26)
      .order('id')
      .limit(readPage)
    if (memberIds) q = q.in('id', memberIds)
    if (dayOr) q = q.or(dayOr)
    if (cursor !== null) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) {
      // 2026-10-07: a chain's first 1,000-row read hit SQLSTATE 57014.
      // Retry this GET only, at the same cursor, with bounded smaller payloads.
      // No claims or sends start until the complete scan has succeeded.
      const smallerPage = error.code === '57014' ? [250, 100].find(size => size < readPage) : undefined
      if (smallerPage !== undefined) {
        console.warn('[weekly-reco] member_scan_timeout', { from: readPage, to: smallerPage, scoped: !!memberIds })
        readPage = smallerPage
        continue
      }
      throw error
    }
    const got = (data ?? []) as MemberScanRow[]
    rows.push(...got)
    if (got.length < readPage) break
    cursor = got[got.length - 1].id
  }
  return rows
}

type RecoContinuationResult = { status: 'pending' | 'http_accepted' | 'http_error' | 'request_error'; httpStatus?: number }

/** One request only: an uncertain continuation must never cause an automatic replay. */
export async function requestRecoContinuation(url: string, secret: string, chain: number, waitMs = 1500): Promise<RecoContinuationResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fetch(url, { method: 'GET', headers: { authorization: `Bearer ${secret}` } })
        .then((response): RecoContinuationResult => {
          if (!response.ok) console.error('[weekly-reco] continuation_http_error', { chain, httpStatus: response.status })
          return { status: response.ok ? 'http_accepted' : 'http_error', httpStatus: response.status }
        })
        .catch((): RecoContinuationResult => {
          // No URL, authorization, member IDs or provider data in runtime logs.
          console.error('[weekly-reco] continuation_request_unconfirmed', { chain })
          return { status: 'request_error' }
        }),
      new Promise<RecoContinuationResult>(resolve => {
        timer = setTimeout(() => resolve({ status: 'pending' }), waitMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface RecoRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  query?: Record<string, unknown>
  body?: unknown
}
interface RecoResponse {
  status(code: number): RecoResponse
  json(body: Record<string, unknown>): unknown
}
interface RecoOptions {
  memberIds?: string[]
  mode: 'scheduled' | 'manual'
  dryRun: boolean
  auditOnly: boolean
  chain: number
  alsoSms: boolean
  setCount?: number
  expectedRound?: number
  operationId?: string
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Mirrors fail-closed claim validation without mutating state during a preview. */
export function recoContextProblem(meta: Record<string, unknown>): string | null {
  if (meta.reco_paused === true) return 'HELD'
  if (meta.reco_paused != null && typeof meta.reco_paused !== 'boolean') return 'INVALID_HOLD'
  if (meta.source_site != null && typeof meta.source_site !== 'string') return 'INVALID_SITE'
  const site = typeof meta.source_site === 'string' && meta.source_site.trim() ? meta.source_site.trim() : 'pluslotto'
  if (!['pluslotto', 'lotto815', 'infolotto', 'cplotto', 'best'].includes(site)) return 'INVALID_SITE'
  if ('weekly_recos' in meta && !Array.isArray(meta.weekly_recos)) return 'INVALID_HISTORY'
  if (meta.weekly_reco_day != null && (!Number.isInteger(meta.weekly_reco_day) || Number(meta.weekly_reco_day) < 0 || Number(meta.weekly_reco_day) > 6)) return 'INVALID_DAY'
  if (meta.weekly_reco_count != null && (!Number.isInteger(meta.weekly_reco_count) || Number(meta.weekly_reco_count) < 0 || Number(meta.weekly_reco_count) > 9999)) return 'INVALID_COUNT'
  if (meta.end_date != null && String(meta.end_date).trim()) {
    const match = String(meta.end_date).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/)
    if (!match) return 'INVALID_END_DATE'
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) return 'INVALID_END_DATE'
  }
  return null
}

/** Unknown targeting/dry-run hints must never fall through to a whole-population run. */
export function parseRecoRequest(req: RecoRequest): RecoOptions {
  const query = req.query ?? {}
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') throw new Error('GET 또는 POST 요청만 허용됩니다.')
  if (method === 'GET') {
    if (Object.keys(query).some(k => !['audit', 'chain', 'dryRun', 'force'].includes(k)))
      throw new Error('지원하지 않는 실행 범위입니다. 명확한 회원 ID 목록은 POST로 전달해 주세요.')
    for (const key of ['audit', 'dryRun', 'force']) {
      if (query[key] !== undefined && query[key] !== '0' && query[key] !== '1') throw new Error('잘못된 실행 옵션입니다.')
    }
    if (query.force === '1') throw new Error('전체 강제 발급은 중지했습니다. 수동 발급은 정확한 회원 1명을 지정해 주세요.')
    const rawChain = query.chain ?? '0'
    if (typeof rawChain !== 'string' || !/^\d+$/.test(rawChain) || Number(rawChain) > 20) throw new Error('잘못된 연속 실행 값입니다.')
    if (query.audit === '1' && query.dryRun === '1') throw new Error('대조와 dryRun을 함께 실행할 수 없습니다.')
    return { mode: 'scheduled', dryRun: query.dryRun === '1', auditOnly: query.audit === '1', chain: Number(rawChain), alsoSms: true }
  }
  if (Object.keys(query).length) throw new Error('POST 실행 옵션은 본문에만 전달해 주세요.')
  const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  if (!object(body) || Object.keys(body).some(k => !['memberIds', 'mode', 'dryRun', 'alsoSms', 'setCount', 'expectedRound', 'operationId'].includes(k)))
    throw new Error('잘못된 실행 요청입니다.')
  const ids = body.memberIds
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) || new Set(ids).size !== ids.length)
    throw new Error('중복 없는 회원 ID 1~50개가 필요합니다.')
  const mode = body.mode ?? 'scheduled'
  if (mode !== 'scheduled' && mode !== 'manual') throw new Error('잘못된 발급 방식입니다.')
  if (mode === 'manual' && ids.length !== 1) throw new Error('수동 발급은 회원 1명만 지정할 수 있습니다.')
  for (const key of ['dryRun', 'alsoSms']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new Error('실행 옵션은 boolean 값이어야 합니다.')
  if (body.setCount !== undefined && (mode !== 'manual' || !Number.isInteger(body.setCount) || Number(body.setCount) < 1 || Number(body.setCount) > 100))
    throw new Error('수동 조합 수는 1~100의 정수여야 합니다.')
  if (body.expectedRound !== undefined && (!Number.isInteger(body.expectedRound) || Number(body.expectedRound) < 1)) throw new Error('회차는 양의 정수여야 합니다.')
  if (body.operationId !== undefined && (mode !== 'manual' || typeof body.operationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId)
    || body.setCount === undefined || typeof body.alsoSms !== 'boolean'))
    throw new Error('추가 수동 발급은 요청 UUID와 명시적 조합 수·문자 옵션이 필요합니다.')
  if (mode === 'scheduled' && body.alsoSms === false) throw new Error('예정 발급에서는 문자 옵션을 임의로 끌 수 없습니다.')
  return { memberIds: ids as string[], mode, dryRun: body.dryRun === true, auditOnly: false, chain: 0,
    alsoSms: body.alsoSms !== false, setCount: body.setCount as number | undefined, expectedRound: body.expectedRound as number | undefined, operationId: typeof body.operationId === 'string' ? body.operationId.toLowerCase() : undefined }
}

type RecoCaller = { kind: 'cron'; actor: null } | { kind: 'staff'; actor: string; role: string }
async function authorizeReco(req: RecoRequest, url: string, key: string, secret: string | undefined, scoped: boolean): Promise<RecoCaller | null> {
  const authorization = req.headers?.authorization
  if (secret && authorization === `Bearer ${secret}`) return { kind: 'cron', actor: null }
  if (!scoped || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null
  const token = authorization.slice(7)
  const sb = createClient(url, key, { auth: { persistSession: false } })
  try {
    const { data, error } = await sb.auth.getUser(token)
    if (error || !data.user?.id) return null
    const result = await sb.from('staff').select('id, role, is_active').eq('auth_user_id', data.user.id).abortSignal(AbortSignal.timeout(5_000)).maybeSingle()
    const staff: unknown = result.data
    if (result.error || !object(staff) || staff.is_active !== true || typeof staff.id !== 'string'
      || typeof staff.role !== 'string' || !['admin', 'manager', 'leader', 'rep'].includes(staff.role)) return null
    return { kind: 'staff', actor: staff.id, role: staff.role }
  } catch { return null }
}

/** 이번 회차 조합문자 발송 기록(성공/실패) 회원 id 집합. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function scanRecoSms(sb: any, sinceIso: string, page: number): Promise<{ ok: Set<string>; fail: Set<string> }> {
  const ok = new Set<string>()
  const fail = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    let q = sb
      .from('sms_sends')
      .select('id, member_id, status, meta')
      .eq('type', 'recommend')
      .gte('sent_at', sinceIso)
      .order('id')
      .limit(page)
    if (cursor !== null) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw error
    const got = (data ?? []) as { id: string; member_id: string | null; status: string | null; meta?: unknown }[]
    for (const row of got) {
      if (!row.member_id || isAdditionalManualIssue(row.meta)) continue
      // 같은 회원에 성공·실패가 섞이면(재발송) 성공을 우선한다 — 받은 사람은 누락이 아니다.
      if (row.status === '발송완료' || row.status === '발송완료(재발송)') {
        ok.add(row.member_id)
        fail.delete(row.member_id)
      } else if (!ok.has(row.member_id)) {
        fail.add(row.member_id)
      }
    }
    if (got.length < page) break
    cursor = got[got.length - 1].id
  }
  return { ok, fail }
}

export default async function handler(req: RecoRequest, res: RecoResponse) {
  let options: RecoOptions
  try { options = parseRecoRequest(req) } catch (error) {
    return res.status(400).json({ ok: false, code: 'PARAM', message: error instanceof Error ? error.message : '잘못된 요청입니다.' })
  }
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return res.status(500).json({ ok: false, code: 'CONFIG', message: 'CRON_SECRET 미설정' })
  }
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return res.status(500).json({ ok: false, code: 'CONFIG', message: 'SUPABASE_URL/SERVICE_ROLE_KEY 미설정' })
  }
  const caller = await authorizeReco(req, url, key, secret, !!options.memberIds)
  if (!caller) return res.status(401).json({ ok: false, code: 'AUTH' })
  if (options.operationId && caller.kind !== 'staff')
    return res.status(403).json({ ok: false, code: 'MANUAL_STAFF_REQUIRED' })
  const force = options.mode === 'manual'
  // 발송은 하지 않고 누락 대조만 수행(현장 9/12 요청). 발송 경로와 상호 배타 — 대조 실행이
  // 또 다른 대조를 부르지 않도록 아래 자동 트리거보다 먼저 분기한다.
  const auditOnly = options.auditOnly
  // 시간예산 초과로 나눠 실행될 때 무한 연쇄를 막는 안전장치(자기 재호출 횟수).
  const chain = options.chain
  const startedAt = Date.now()
  const sb = createClient(url, key, { auth: { persistSession: false } })
  let stage = 'preflight'

  // A request UUID belongs to one exact member, actor, quantity and SMS intent.
  // Status is read-only: not_found is never proof that a delayed original request cannot arrive.
  const readOperation = async (): Promise<Record<string, unknown>> => {
    if (!options.operationId || caller.kind !== 'staff') throw new Error('MANUAL_STAFF_REQUIRED')
    const member = await sb.from('members').select('id,assigned_staff_id').eq('id', options.memberIds![0]).maybeSingle()
    if (member.error || !member.data || (caller.role === 'rep' && member.data.assigned_staff_id !== caller.actor))
      throw new Error('TARGET_FORBIDDEN')
    const lookup = await sb.from('reco_manual_operations').select('id,member_id,actor_id,round_no,set_count,also_sms,status,reason')
      .eq('id', options.operationId).maybeSingle()
    if (lookup.error) throw new Error('OPERATION_LOOKUP_UNAVAILABLE')
    const op: unknown = lookup.data
    if (!op) return { id: options.operationId, status: 'not_found', set_count: options.setCount, also_sms: options.alsoSms, canStartNew: false }
    if (!object(op) || op.member_id !== options.memberIds![0] || op.actor_id !== caller.actor
      || op.set_count !== options.setCount || op.also_sms !== options.alsoSms
      || (options.expectedRound !== undefined && op.round_no !== options.expectedRound)) throw new Error('OPERATION_CONFLICT')
    const blocked = await sb.from('reco_issue_ledger').select('id').eq('member_id', op.member_id)
      .eq('round_no', op.round_no).in('status', ['claimed', 'unknown', 'rejected']).limit(1)
    if (blocked.error) throw new Error('OPERATION_RECEIPT_UNAVAILABLE')
    if (op.status === 'blocked') return { id: op.id, status: 'blocked', code: op.reason,
      round_no: op.round_no, set_count: op.set_count, also_sms: op.also_sms,
      canStartNew: !blocked.data?.length, confirmedNotIssued: true }
    const receipt = await sb.from('reco_issue_ledger').select('status,issue,should_send')
      .eq('manual_request_id', options.operationId).maybeSingle()
    if (receipt.error || !receipt.data) throw new Error('OPERATION_RECEIPT_UNAVAILABLE')
    const status: unknown = receipt.data.status
    if (typeof status !== 'string' || !['claimed','accepted','rejected','unknown','not_requested'].includes(status))
      throw new Error('OPERATION_RECEIPT_UNAVAILABLE')
    return { id: op.id, status, round_no: op.round_no, set_count: op.set_count, also_sms: op.also_sms,
      canStartNew: ['accepted','not_requested'].includes(status) && !blocked.data?.length }
  }
  try {
    if (options.operationId) {
      let operation: Record<string, unknown>
      try { operation = await readOperation() } catch (error) {
        const code = error instanceof Error ? error.message : 'OPERATION_LOOKUP_UNAVAILABLE'
        return res.status(code === 'TARGET_FORBIDDEN' ? 403 : code === 'OPERATION_CONFLICT' ? 409 : 503).json({ ok: false, code })
      }
      if (options.dryRun || operation.status !== 'not_found') return res.status(200).json({ ok: true,
        dryRun: options.dryRun, operation, operationId: options.operationId,
        confirmedNotIssued: operation.confirmedNotIssued === true, issued: 0, smsSent: 0, results: [] })
    }
    const nowMs = Date.now()
    const kst = new Date(nowMs + 9 * 3600_000)
    const todayKst = kstDay(nowMs)
    const today = kst.getUTCDay() // KST 보정 후 UTC 요일 = KST 요일
    const ts = new Date().toISOString()

    const { data: sData, error: se } = await sb.from('site_settings').select('*').eq('id', 1).maybeSingle()
    if (se) throw se
    const settings = sData as SiteSettingsLite
    const cfg = settings.weekly_free_reco ?? { enabled: true, set_count: DEFAULT_COUNT }
    const ratio = Math.max(0, Math.min(100, cfg.logic_ratio ?? 100)) // 로직:랜덤 비율(현장 피드백)

    // 유료회원 지정요일 조합 SMS — 전용 토글(paid_sms) + 실발송(oneshot_enabled) + 발신번호 모두 충족 시만.
    // (무료 자동발급 cfg.enabled 와 독립 — 무료만 꺼도 유료 SMS 는 계속 동작. D68 #12)
    const smsCfg = settings.sms ?? {}
    const paidSmsOn = !!smsCfg.oneshot_enabled && !!cfg.paid_sms
    const manualSmsOn = options.alsoSms && !!smsCfg.oneshot_enabled
    const senderFor = (site: string): string => String(site === 'pluslotto' ? smsCfg.sender_no ?? '' : smsCfg.by_site?.[site]?.sender_no ?? '').replace(/\D/g, '')
    // 조합문자 본문 템플릿(설정 > 기본문자 템플릿 'recommend', 현장 8/4) — 발송 전 1회 조회.
    let recoTplBody: string | null = null
    if (paidSmsOn || (options.mode === 'manual' && manualSmsOn)) {
      const { data: tplData } = await sb.from('sms_templates').select('body').eq('key', 'recommend').maybeSingle()
      recoTplBody = (tplData as { body?: string } | null)?.body ?? null
    }
    const selfBase =
      process.env.SELF_BASE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

    // 무료 자동발급도 OFF, 유료 SMS 도 OFF 면 할 일 없음 → 종료.
    if (!cfg.enabled && !paidSmsOn && !force) return res.status(200).json({ ok: true, skipped: 'disabled', dryRun: options.dryRun, issued: 0, smsSent: 0 })

    // PostgREST 1000행 캡 회피 — range 페이지네이션으로 전 회차 조회.
    const rounds: LottoRound[] = []
    for (let from = 0; ; from += 1000) {
      const { data: rData, error: re } = await sb.from('lotto_rounds').select('*').range(from, from + 999)
      if (re) throw re
      const page = (rData ?? []) as LottoRound[]
      rounds.push(...page)
      if (page.length < 1000) break
    }
    const targetRound = rounds.reduce((mx, r) => Math.max(mx, r.round_no), 0) + 1
    if (!rounds.length || (options.expectedRound !== undefined && targetRound !== options.expectedRound))
      return res.status(409).json({ ok: false, code: 'ROUND_CHANGED', message: '최신 회차를 다시 확인해 주세요.', round_no: targetRound })
    // 적재 지연 감지(D68 #13, 비차단): 최신 회차 추첨일이 8일+ 지났으면 lotto 자동적재가 밀린 상태일 수 있어
    // targetRound 가 '이미 지난 회차'를 가리킬 위험 → 발급은 막지 않되 로그로 가시화(운영 점검 신호).
    const newest = rounds.reduce<LottoRound | null>((a, r) => (!a || r.round_no > a.round_no ? r : a), null)
    const staleRound = !!newest && Date.now() - new Date(newest.draw_date).getTime() > 8 * 86400_000
    if (staleRound) {
      console.warn(`[weekly-reco] 최신 회차(${newest?.round_no}) 추첨일 8일+ 경과 — 회차 적재 지연 의심, targetRound=${targetRound}`)
    }
    if (staleRound && options.memberIds)
      return res.status(409).json({ ok: false, code: 'STALE_ROUND', message: '최신 추첨 회차가 확인되지 않아 지정 발급을 중지했습니다.' })
    const baseCount = Math.max(1, cfg.set_count || DEFAULT_COUNT)

    // ── 발송 후 누락 대조(audit=1) ───────────────────────────────────────────────
    // 발송은 하지 않고 "받아야 했는데 못 받은 회원"만 추려 로그로 남긴다.
    // 정상 발송이 끝나면 아래에서 자동으로 이 경로를 한 번 호출하고, vercel.json 의 별도 크론이
    // 백스톱으로 한 번 더 돈다(발송 함수가 로그도 못 남기고 죽은 경우를 잡기 위함 — 7/31 사고 유형).
    if (auditOnly) {
      // 대조 기준 시각 = 이번 회차 발송이 시작된 시각. 이 시각 이후 가입자는 애초에 대상이
      // 아니었으므로 누락이 아니다. 발송 로그에 기록된 실제 시작시각을 쓰고, 로그조차 없으면
      // (함수가 기록 전에 죽은 경우) KST 오늘 0시로 넉넉히 잡는다 — 넓게 잡을수록 허위가 준다.
      const { data: logData } = await sb
        .from('logs')
        .select('created_at, meta')
        .eq('action', 'reco.weekly_issue')
        .eq('meta->>round_no', String(targetRound))
        .order('created_at', { ascending: true })
        .limit(1)
      const firstLog = (logData ?? [])[0] as { created_at: string; meta: Record<string, unknown> } | undefined
      const loggedStart = firstLog?.meta?.started_at
      const sinceIso =
        typeof loggedStart === 'string' && loggedStart
          ? loggedStart
          : new Date(`${todayKst}T00:00:00+09:00`).toISOString()

      stage = 'audit_member_scan'
      const auditRows = await scanMembers(sb, 1000)
      stage = 'audit_reconciliation'
      const sms = await scanRecoSms(sb, sinceIso, 1000)
      const result = recoAuditMisses(auditRows, {
        today,
        todayKst,
        force,
        autoEnabled: !!cfg.enabled,
        paidSmsOn,
        targetRound,
        sinceIso,
        smsOk: sms.ok,
        smsFail: sms.fail,
      })

      // 목록은 현장이 바로 전화할 수 있게 회원명·번호까지 남긴다. 로그 1건이 과도하게 커지지
      // 않도록 상한을 두되, 총 건수(miss_count)는 잘리지 않은 실제 값을 남긴다.
      const MISS_LOG_CAP = 300
      await sb.from('logs').insert({
        id: `log_audit_${Date.now().toString(36)}`,
        kind: 'admin',
        actor: null,
        action: 'reco.weekly_audit',
        target_type: 'member',
        target_id: null,
        meta: {
          round_no: targetRound,
          since: sinceIso,
          checked: result.checked,
          expected: result.expected,
          miss_count: result.misses.length,
          miss_not_issued: result.misses.filter((m) => m.reason === 'not_issued').length,
          miss_sms_missing: result.misses.filter((m) => m.reason === 'sms_missing').length,
          miss_sms_failed: result.misses.filter((m) => m.reason === 'sms_failed').length,
          excluded: result.excluded,
          misses: result.misses.slice(0, MISS_LOG_CAP),
          truncated: result.misses.length > MISS_LOG_CAP,
          channel: 'cron',
        },
        created_at: ts,
      })
      if (result.misses.length > 0) {
        console.warn(
          `[weekly-reco] ${targetRound}회차 발송 누락 ${result.misses.length}명 / 대상 ${result.expected}명`,
        )
      }
      return res.status(200).json({
        ok: true,
        audit: true,
        round_no: targetRound,
        checked: result.checked,
        expected: result.expected,
        miss_count: result.misses.length,
        excluded: result.excluded,
        misses: result.misses,
      })
    }
    // 등급별 고정/제외 규칙(없으면 공통 폴백) — 등급당 1회 해석 캐시.
    const excludeByGrade = new Map<string, LottoExcludeSettings>()
    const excludeFor = (grade: string): LottoExcludeSettings => {
      let e = excludeByGrade.get(grade)
      if (!e) {
        e = resolveExcludeForGrade(settings, grade)
        excludeByGrade.set(grade, e)
      }
      return e
    }

    // 전 등급 조회 — 무료=기본 금요일, 그 외 등급=발송요일 설정된 회원만(6/11 피드백).
    // 대량(15만) 대비 페이지네이션 — 커서(키셋) 방식.
    //
    // 왜 오프셋(.range)을 쓰지 않는가 (현장 9/14 사고)
    //   오프셋은 "앞에서 N개 건너뛰고 1000개"라서, 읽는 도중 앞쪽에 행이 하나 끼어들거나
    //   빠지면 그 뒤 전체가 한 칸씩 밀린다. 밀리는 방향에 따라 페이지 경계의 회원이
    //   **두 번 읽히거나**(중복 발송) **아예 안 읽힌다**(조용한 누락). 09:00 발송 시점은
    //   신규 가입·상태 변경·레거시 적재가 함께 도는 시간이라 이 흔들림이 실제로 일어난다.
    //
    //   2026-09-14 실제 사고: 유료회원 한 명에게 1242회차 조합문자가 같은 실행에서 두 번
    //   나갔다. 증거 — sms_sends 두 행의 member_id 가 동일, sent_at 이 밀리초까지 동일
    //   (ts 는 실행당 한 번 계산되므로 같은 실행), 행 id 의 시각 접두사만 1ms 차이.
    //   즉 대상 목록에 같은 회원이 두 번 들어갔고, 멱등 검사(recos[0].round_no)는 목록을
    //   만들 때 한 번만 보므로 두 번째를 막지 못한다.
    //
    //   커서 방식은 "마지막으로 읽은 id 다음부터"라서 동시 삽입·삭제와 무관하게 각 행을
    //   정확히 한 번 읽는다. 누락 쪽도 같이 닫힌다.
    const PAGE = 1000
    stage = 'member_scan'
    const rows: MemberScanRow[] = await scanMembers(sb, PAGE, options.memberIds,
      options.memberIds || force ? undefined : { today })
    stage = 'eligibility'
    if (options.memberIds && (rows.length !== options.memberIds.length || rows.some(r => !options.memberIds!.includes(r.id))))
      return res.status(409).json({ ok: false, code: 'TARGET_CHANGED', message: '일부 회원이 없거나 삭제·탈퇴·정지 상태입니다. 발급하지 않았습니다.' })
    if (caller.kind === 'staff' && caller.role === 'rep' && rows.some(r => r.assigned_staff_id !== caller.actor))
      return res.status(403).json({ ok: false, code: 'TARGET_FORBIDDEN', message: '본인 담당 회원만 발급할 수 있습니다.' })

    // 방어선. 커서 방식이면 중복이 나올 수 없지만, 여기서 새는 순간 대가가 '유료회원에게
    // 문자 두 번 + 발송비 이중 지출'이라 값이 싼 검사를 한 겹 더 둔다. 조용히 넘기지 않고
    // 로그를 남겨, 다시 새면 원인을 바로 짚을 수 있게 한다.
    const seenIds = new Set<string>()
    const dupIds: string[] = []
    const uniqueRows = rows.filter((r) => {
      if (seenIds.has(r.id)) {
        dupIds.push(r.id)
        return false
      }
      seenIds.add(r.id)
      return true
    })
    if (dupIds.length > 0) {
      console.warn(
        `[weekly-reco] 대상 목록에 중복 ${dupIds.length}건 — 제거 후 진행: ${dupIds.slice(0, 10).join(', ')}`,
      )
    }

    let issued = 0
    let skippedRound = 0
    let skippedDay = 0
    let skippedPaused = 0
    let skippedExpired = 0
    let smsSent = 0
    let smsFail = 0
    let errCount = 0
    let reviewRequired = 0
    const results: Record<string, unknown>[] = []
    const issuedByGrade = new Map<string, number>()
    // 1) 적격 회원 선별(게이트) — CPU만, 빠름. 발급/발송은 2)에서 병렬.
    const eligible: {
      r: (typeof uniqueRows)[number]
      meta: Record<string, unknown>
      count: number
      sender: string
    }[] = []
    // 판정은 recoSkipReason 한 곳에서만 한다 — 발송 후 누락 대조와 같은 함수를 쓰기 위함.
    const gateCtx: RecoGateCtx = {
      today,
      todayKst,
      force,
      autoEnabled: !!cfg.enabled,
      paidSmsOn,
      targetRound,
    }
    for (const r of uniqueRows) {
      const meta = r.meta ?? {}
      const contextProblem = object(meta) ? recoContextProblem(meta) : 'INVALID_META'
      if (contextProblem && !options.operationId) {
        if (contextProblem === 'HELD') skippedPaused++
        else errCount++
        if (options.memberIds) results.push({ member_id: r.id, status: 'skipped', code: contextProblem, round_no: targetRound })
        continue
      }
      // Manual issuance is a single identified member. It bypasses the weekday only;
      // hold, expiration and an existing issue still prevent a new issue. An explicit
      // one-off count may override count-zero without changing the member setting.
      const manualMeta = { ...meta, weekly_reco_day: today,
        ...(options.setCount !== undefined ? { weekly_reco_count: options.setCount } : {}) }
      const skip = options.operationId ? null : recoSkipReason(options.mode === 'manual' ? { ...r, meta: manualMeta } : r, gateCtx)
      if (skip && options.memberIds) results.push({ member_id: r.id, status: 'skipped', code: skip.toUpperCase(), round_no: targetRound })
      if (skip === 'day' || skip === 'count-zero') {
        skippedDay++
        continue
      }
      if (skip === 'paused') {
        skippedPaused++
        continue
      }
      if (skip === 'expired') {
        skippedExpired++
        continue
      }
      if (skip === 'already') {
        skippedRound++
        continue
      }
      const configuredCount =
        typeof meta.weekly_reco_count === 'number' && (meta.weekly_reco_count as number) > 0
          ? (meta.weekly_reco_count as number)
          : baseCount
      const count = options.setCount ?? configuredCount
      if (!Number.isInteger(count) || count < 1 || count > (options.mode === 'manual' ? 100 : 1000)) {
        errCount++
        if (options.memberIds) results.push({ member_id: r.id, status: 'error', code: 'INVALID_COUNT', round_no: targetRound })
        continue
      }
      const sourceSite = typeof meta.source_site === 'string' && meta.source_site.trim() ? meta.source_site.trim() : 'pluslotto'
      const wantsSms = options.mode === 'manual' ? manualSmsOn : expectsComboSms(r, { paidSmsOn })
      const memberSender = senderFor(sourceSite)
      if (wantsSms && !memberSender && !options.operationId) {
        errCount++
        if (options.memberIds) results.push({ member_id: r.id, status: 'error', code: 'SMS_SENDER_UNSET', round_no: targetRound })
        continue
      }
      eligible.push({ r, meta, count, sender: memberSender })
    }

    if (options.dryRun) {
      // No claim RPC, metadata update, audit log, provider request or self-chain.
      const priorClaims = new Map<string, string>()
      let claimCursor: string | null = null
      for (;;) {
        let query = sb.from('reco_issue_ledger').select('id,member_id,status,manual_request_id').eq('round_no', targetRound).order('id').limit(1000)
        if (options.memberIds) query = query.in('member_id', options.memberIds)
        if (claimCursor) query = query.gt('id', claimCursor)
        const receiptState = await query
        if (receiptState.error) return res.status(503).json({ ok: false, dryRun: true, code: 'RECEIPT_LOOKUP_UNAVAILABLE', issued: 0, smsSent: 0 })
        const claimRows = receiptState.data ?? []
        for (const row of claimRows) if (typeof row.member_id === 'string' && typeof row.status === 'string'
          && (!row.manual_request_id || ['claimed','unknown','rejected'].includes(row.status))) priorClaims.set(row.member_id, row.status)
        if (claimRows.length < 1000 || options.memberIds) break
        const nextCursor: unknown = claimRows[claimRows.length - 1]?.id
        if (typeof nextCursor !== 'string' || nextCursor === claimCursor) return res.status(503).json({ ok: false, dryRun: true, code: 'RECEIPT_SCAN_INVALID', issued: 0, smsSent: 0 })
        claimCursor = nextCursor
      }
      // Reset legacy issues have no provider claim; their private archive is also a tombstone.
      // Query only current candidates, in bounded pages, and fail closed when the archive is unavailable.
      const resetIssued = new Set<string>()
      for (let start = 0; start < eligible.length; start += 200) {
        const ids = eligible.slice(start, start + 200).map(({ r }) => r.id)
        for (let offset = 0; ; offset += 1000) {
          const archived = await sb.from('member_reco_reset_archive').select('operation_id,member_id,issues')
            .in('member_id', ids).order('operation_id').order('member_id').range(offset, offset + 999)
          if (archived.error) return res.status(503).json({ ok: false, dryRun: true, code: 'RESET_ARCHIVE_LOOKUP_UNAVAILABLE', issued: 0, smsSent: 0 })
          const rows = archived.data ?? []
          for (const row of rows) {
            if (typeof row.member_id !== 'string' || !Array.isArray(row.issues)) {
              return res.status(503).json({ ok: false, dryRun: true, code: 'RESET_ARCHIVE_INVALID', issued: 0, smsSent: 0 })
            }
            if (row.issues.some((issue: unknown) => issue && typeof issue === 'object' &&
              'round_no' in issue && String(issue.round_no) === String(targetRound) && !isAdditionalManualIssue(issue))) resetIssued.add(row.member_id)
          }
          if (rows.length < 1000) break
        }
      }
      const preview = eligible.map(({ r, count, sender: registeredSender }) => {
        const site = typeof r.meta?.source_site === 'string' && r.meta.source_site.trim() ? r.meta.source_site.trim() : 'pluslotto'
        const wantsSms = options.mode === 'manual' ? manualSmsOn : expectsComboSms(r, { paidSmsOn })
        const senderMissing = wantsSms && !registeredSender?.replace(/\D/g, '')
        const prior = priorClaims.get(r.id)
        const reset = resetIssued.has(r.id)
        return { member_id: r.id, source_site: site, status: prior ? 'review_required' : reset || senderMissing ? 'skipped' : 'dry_run',
          code: prior ? 'EXISTING_CLAIM' : reset ? 'ALREADY_ISSUED_BEFORE_RESET' : senderMissing ? 'SMS_SENDER_UNSET' : 'READY_TO_CLAIM', round_no: targetRound, set_count: count,
          would_request_sms: wantsSms && !senderMissing && !prior && !reset, approval_verified: false }
      })
      return res.status(200).json({ ok: true, dryRun: true, round_no: targetRound, issued: 0, smsSent: 0, smsFail: 0,
        wouldIssue: preview.filter(r => r.status === 'dry_run').length, wouldSend: preview.filter(r => r.would_request_sms).length,
        skippedDay, skippedPaused, skippedExpired, skippedRound, errors: errCount,
        results: options.memberIds ? [...results, ...preview] : [],
        message: '읽기 전용 사전점검입니다. 승인·업체 접수·수신을 확인한 결과가 아닙니다.' })
    }

    // 유료회원 우선 처리(현장 피드백 7/31) — 금요일은 무료회원 기본요일과 겹쳐 대상이 수천 명대로
    // 커지는데, 실제로 이 함수가 Vercel maxDuration(300초)에 걸려 중간에 강제 종료되면서 뒤쪽 순서의
    // 회원은 그날 발급·문자를 통째로 못 받는 사고가 있었다(이 실행분은 마지막 로그 기록조차 남기지
    // 못한 채 끊겼다 — 완주 실패의 증거). 유료(결제) 회원은 수가 훨씬 적으니 배열 맨 앞으로 보내
    // 타임아웃이 나더라도 무료회원 쪽에서 잘리게 한다(유료회원 발급 누락을 최소화).
    eligible.sort((a, b) => Number(PAID_GRADES.has(b.r.grade)) - Number(PAID_GRADES.has(a.r.grade)))

    // 2) 발급 + (유료)SMS — 동시성 제한 병렬. 순차로는 1000+명 발송이 함수 타임아웃(수십분)에 걸려
    //    일부만 나가던 위험을 차단(현장 6/24, 이윤선 1883명 대비). 단건 실패는 격리(잔여 진행).
    const CONC = 12
    const processOne = async ({ r, meta, count, sender }: (typeof eligible)[number]) => {
      const exclude = excludeFor(r.grade)
      // 실버·골드·다이아는 특허 제외수 로직, 그 외 등급은 기존 통계 로직 + 완전랜덤 보충(현장 피드백 7/23).
      const sets = generateIssueSetsForGrade(rounds, r.grade, exclude, count, ratio)
      const issue: WeeklyRecoIssue = { round_no: targetRound, issued_at: ts, sets }
      const wantsSms = options.mode === 'manual' ? manualSmsOn : expectsComboSms(r, { paidSmsOn })
      const sourceSite = typeof meta.source_site === 'string' && meta.source_site.trim() ? meta.source_site.trim() : 'pluslotto'
      const claimed = await sb.rpc(options.operationId ? 'reco_issue_manual_claim' : 'reco_issue_claim', {
        ...(options.operationId ? { p_operation_id: options.operationId } : {}),
        p_member_id: r.id, p_round_no: targetRound, p_expected_meta: meta, p_issue: issue,
        p_expected_site: sourceSite, p_today: todayKst, p_weekday: today, p_mode: options.mode,
        p_also_sms: options.operationId ? options.alsoSms : wantsSms, p_actor: caller.actor, p_set_count: options.setCount ?? null,
        p_expected_grade: r.grade, p_expected_phone: r.phone,
      })
      const claim: unknown = claimed.data
      if (claimed.error || !object(claim) || claim.ok !== true) {
        errCount++; reviewRequired++
        if (options.memberIds) results.push({ member_id: r.id, status: 'review_required', code: 'CLAIM_UNCONFIRMED', round_no: targetRound })
        return
      }
      if (claim.claimed === false) {
        if (claim.status === 'review_required') reviewRequired++
        if (options.memberIds) results.push({ member_id: r.id, status: claim.status === 'review_required' ? 'review_required' : 'skipped',
          code: typeof claim.reason === 'string' ? claim.reason : 'NOT_CLAIMED', round_no: targetRound })
        return
      }
      const claimedMember = object(claim.member) && claim.member.meta === null ? { ...claim.member, meta: {} } : claim.member
      const claimedIssue = claim.issue
      if (claim.claimed !== true || (typeof claim.claim_id !== 'string' && typeof claim.claim_id !== 'number')
        || typeof claim.claim_token !== 'string' || !claim.claim_token || typeof claim.should_send !== 'boolean'
        || !object(claimedMember) || claimedMember.id !== r.id || (claimedMember.name !== null && typeof claimedMember.name !== 'string')
        || (claimedMember.phone !== null && typeof claimedMember.phone !== 'string') || !object(claimedMember.meta)
        || (claim.should_send && typeof claimedMember.phone !== 'string')
        || (typeof claimedMember.meta.source_site === 'string' && claimedMember.meta.source_site.trim() ? claimedMember.meta.source_site.trim() : 'pluslotto') !== sourceSite
        || !object(claimedIssue) || claimedIssue.round_no !== targetRound
        || (options.operationId !== undefined && claimedIssue.manual_request_id !== options.operationId)
        || JSON.stringify(claimedIssue.sets) !== JSON.stringify(sets)) {
        errCount++; reviewRequired++
        if (options.memberIds) results.push({ member_id: r.id, status: 'review_required', code: 'CLAIM_CONTRACT_INVALID', round_no: targetRound })
        return
      }
      issued++
      issuedByGrade.set(r.grade, (issuedByGrade.get(r.grade) ?? 0) + 1)
      let outcome: 'accepted' | 'rejected' | 'unknown' | 'not_requested' = 'not_requested'
      let receipt: Record<string, unknown> = { code: 'NOT_REQUESTED' }
      if (claim.should_send) {
        const smsBody = formatComboSms(typeof claimedMember.name === 'string' ? claimedMember.name : '', targetRound, sets, recoTplBody, claimedMember.meta)
        const sent = await sendComboSms(selfBase, r.id, String(claimedMember.phone), smsBody, sender, sourceSite)
        outcome = sent.outcome; receipt = sent.receipt
        if (outcome === 'accepted') smsSent++
        else { smsFail++; reviewRequired++ }
      }
      const finished = await sb.rpc('reco_issue_finish', {
        p_claim_id: claim.claim_id, p_claim_token: claim.claim_token, p_outcome: outcome, p_receipt: receipt,
      })
      const finish: unknown = finished.data
      if (finished.error || !object(finish) || finish.ok !== true || finish.outcome !== outcome) {
        errCount++; reviewRequired++
        if (options.memberIds) results.push({ member_id: r.id, status: 'review_required', code: 'RECEIPT_UNCONFIRMED',
          sms_outcome: outcome, round_no: targetRound, sets })
        return
      }
      if (options.memberIds) results.push({ member_id: r.id, status: 'issued', code: outcome === 'accepted' ? 'PROVIDER_ACCEPTED' : outcome.toUpperCase(),
        sms_outcome: outcome, round_no: targetRound, sets })
    }
    // 시간예산 가드(현장 피드백 7/31) — 대상이 수천 명이면 전체 처리가 Vercel maxDuration(300초)을
    // 넘겨 함수가 통째로 강제 종료되고, 뒤쪽 회원은 발급도 로그도 없이 조용히 누락됐다(7/31 사고).
    // 예산을 넘기면 남은 대상을 남겨둔 채 정상 종료(로그 기록)하고, 이어서 처리할 후속 실행을
    // 스스로 트리거한다 — 한 번에 다 못 해도 여러 번에 나눠 반드시 완주하게 한다.
    // (재실행은 같은 회차의 이력 및 영구 선점 원장으로 이미 처리한 회원을 건너뛴다.)
    stage = 'issuance'
    const BUDGET_MS = 240_000 // maxDuration 300초 중 안전 여유를 남긴 값
    let processed = 0
    for (let i = 0; i < eligible.length; i += CONC) {
      if (Date.now() - startedAt > BUDGET_MS) break
      const slice = eligible.slice(i, i + CONC)
      await Promise.all(slice.map(async row => {
        try { await processOne(row) } catch {
          // A lost claim/finish response can mean the transaction committed. Never retry.
          errCount++; reviewRequired++
          if (options.memberIds) results.push({ member_id: row.r.id, status: 'review_required', code: 'EXECUTION_UNCONFIRMED', round_no: targetRound })
        }
      }))
      processed += slice.length
    }
    const remaining = Math.max(0, eligible.length - processed)

    // 회차·등급별 로직 스냅샷 — 특정 회원 조합은 저장하지 않고 공통 제외 과정만 1건씩 기록한다.
    stage = 'issuance_audit'
    if (issuedByGrade.size > 0 && !options.memberIds) {
      let generationRecords = [...(settings.generation_records ?? [])]
      for (const [grade, gradeIssued] of issuedByGrade) {
        const exclude = excludeFor(grade)
        let record: GenerationRecordLite
        if (isPatentGrade(grade)) {
          // 실버·골드·다이아 — 특허 제외수 로직 스냅샷(현장 피드백 7/23).
          const patent = generatePatentSets(rounds, grade, exclude, 1, targetRound)
          const manualExcluded = patent.excluded.filter((n) => !patent.autoExcluded.includes(n))
          record = {
            id: `genrec_cron_${targetRound}_${grade}_${Date.now().toString(36)}`,
            created_at: ts,
            created_by: null,
            grade,
            target_round: targetRound,
            mode: patent.autoExcluded.length,
            source: 'weekly_auto',
            fixed: patent.fixed,
            excluded: patent.excluded,
            reasons: [
              ...patent.autoExcluded.map((number) => ({ number, rule: 'patent' as ExclusionRuleKey })),
              ...manualExcluded.map((number) => ({ number, rule: 'manual' as ExclusionRuleKey })),
            ],
            stages: [
              { rule: 'patent', candidates: patent.autoExcluded, selected: patent.autoExcluded },
              { rule: 'manual', candidates: manualExcluded, selected: manualExcluded },
            ],
            pool: patent.pool,
            basis: {
              roundsUsed: patent.window,
              prevRound: patent.prevRound,
              prevNumbers: patent.prevNumbers,
              prevBonus: patent.prevBonus,
              sumBand: [100, 175],
              relaxed: false,
            },
            set_count: baseCount,
            logic_ratio: ratio,
            issued_count: gradeIssued,
          }
        } else {
          const trace = generateRecommendation(rounds, exclude, { mode: 20, setCount: 1, seed: targetRound })
          record = {
            id: `genrec_cron_${targetRound}_${grade}_${Date.now().toString(36)}`,
            created_at: ts,
            created_by: null,
            grade,
            target_round: targetRound,
            mode: trace.mode,
            source: 'weekly_auto',
            fixed: trace.fixed,
            excluded: trace.excluded,
            reasons: trace.reasons,
            stages: trace.stages,
            pool: trace.pool,
            basis: trace.basis,
            set_count: baseCount,
            logic_ratio: ratio,
            issued_count: gradeIssued,
          }
        }
        generationRecords = [
          record,
          ...generationRecords.filter(
            (existing) =>
              existing.target_round !== targetRound || (existing.grade ?? null) !== grade,
          ),
        ]
      }
      generationRecords.sort(
        (a, b) => b.target_round - a.target_round || b.created_at.localeCompare(a.created_at),
      )
      const { error: ge } = await sb
        .from('site_settings')
        .update({ generation_records: generationRecords })
        .eq('id', 1)
      if (ge) throw ge
    }

    const auditLog = await sb.from('logs').insert({
      id: `log_reco_${randomUUID()}`,
      kind: 'admin',
      actor: caller.actor,
      action: options.mode === 'manual' ? 'reco.manual_issue' : 'reco.weekly_issue',
      target_type: 'member',
      target_id: null,
      // started_at — 누락 대조(audit=1)가 '이 시각 이후 가입자는 대상 아님'을 판정하는 기준.
      meta: { count: issued, skipped: skippedRound, skipped_day: skippedDay, skipped_paused: skippedPaused, skipped_expired: skippedExpired, errors: errCount, review_required: reviewRequired, round_no: targetRound, stale_round: staleRound,
        channel: options.memberIds ? 'scoped' : 'cron', force, sms_sent: smsSent, sms_fail: smsFail, remaining, chain,
        ...(options.memberIds ? { member_ids: options.memberIds } : {}), started_at: new Date(startedAt).toISOString() },
      created_at: ts,
    })
    if (auditLog.error) {
      errCount++; reviewRequired++
      // Issuance may already be durable: report the audit gap, never replay claims.
      if (options.memberIds) results.push({ status: 'review_required', code: 'AUDIT_LOG_UNCONFIRMED', round_no: targetRound })
    }

    // 남은 대상이 있으면 후속 실행을 트리거해 이어서 처리한다(연쇄 상한으로 폭주 방지).
    // 응답을 기다리지 않고(자기 자신을 await 하면 타임아웃) 요청만 띄운다.
    const MAX_CHAIN = 20
    let continuation: RecoContinuationResult | { status: 'limit_reached' } | undefined
    stage = 'continuation'
    if (!options.memberIds && remaining > 0 && chain < MAX_CHAIN) {
      const nextUrl = `${selfBase}/api/weekly-reco?chain=${chain + 1}`
      continuation = await requestRecoContinuation(nextUrl, secret, chain + 1)
    } else if (!options.memberIds && remaining > 0) {
      continuation = { status: 'limit_reached' }
      console.error('[weekly-reco] continuation_limit_reached', { chain, remaining })
    } else if (!options.memberIds && remaining === 0) {
      // 이번 회차 처리가 끝났다 → 곧바로 누락 대조를 한 번 돌린다(현장 9/12 요청).
      // 별도 요청으로 띄워 이 실행이 maxDuration 에 걸리지 않게 한다. 실패해도 vercel.json 의
      // 대조 크론이 같은 날 다시 돈다.
      try {
        await Promise.race([
          fetch(`${selfBase}/api/weekly-reco?audit=1`, {
            method: 'GET',
            headers: { authorization: `Bearer ${secret}` },
          }),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ])
      } catch {
        /* 대조 트리거 실패는 대조 크론이 회수 */
      }
    }

    let operation: Record<string, unknown> | undefined
    if (options.operationId) {
      try { operation = await readOperation() } catch {
        errCount++; reviewRequired++
      }
    }
    return res.status(200).json({ ok: errCount === 0 && reviewRequired === 0,
      ...(operation ? { operation, operationId: options.operationId, confirmedNotIssued: operation.confirmedNotIssued === true } : {}),
      code: reviewRequired > 0 ? 'RECEIPT_CONFIRMATION_REQUIRED' : remaining > 0 ? 'INCOMPLETE' : 'COMPLETE', dryRun: false,
      complete: errCount === 0 && reviewRequired === 0 && remaining === 0,
      ...(continuation ? { continuation } : {}),
      round_no: targetRound, issued, skippedRound, skippedDay, skippedPaused, skippedExpired, errors: errCount,
      reviewRequired, staleRound, smsSent, smsFail, remaining, chain, results })
  } catch (e) {
    const errorCode = object(e) && typeof e.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code) ? e.code : 'UNEXPECTED'
    // DB errors are plain objects; String(e) loses their code as [object Object].
    // Log only the stage and machine code, never a query, member payload or secret.
    console.error('[weekly-reco] execution_failed', { stage, chain, error_code: errorCode })
    const message = e instanceof Error ? e.message : '데이터 조회 또는 처리에 실패했습니다. 접수 이력을 확인해 주세요.'
    return res.status(500).json({ ok: false, code: 'ERROR', stage, error_code: errorCode, message })
  }
}
