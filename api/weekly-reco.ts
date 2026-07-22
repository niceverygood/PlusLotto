// Vercel 크론 함수 — 회원 추천조합 자동발급(현장 피드백, 문자발송 X).
// vercel.json crons 가 매일 00:00 UTC(=09:00 KST) 호출.
// 대상(현장 피드백 6/11 <추천번호> 7): ① 무료회원 = 기본 금요일(회원별 weekly_reco_day 우선)
// ② 유료 등 그 외 등급 = 회원정보창에 발송요일이 '설정된' 회원만, 그 요일에 발급.
// 세트수 = 회원별 weekly_reco_count(없으면 전역), 등급별 고정/제외 규칙 적용. 멱등(동일 회차 skip).
//
// ⚠️ 완전 자급자족 단일 파일: Vercel 함수 런타임(ESM)이 api/ 상대 import 를 해석하지 못해
// src/lib/lottoGenerator.ts 의 생성 로직 사본 + 최소 타입을 인라인한다(원본 수정 시 동기화).
//
// Vercel 환경변수: SUPABASE_URL(또는 VITE_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET
// 수동 테스트: GET /api/weekly-reco?force=1 (Authorization: Bearer $CRON_SECRET)
import { createClient } from '@supabase/supabase-js'

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
  sms?: { oneshot_enabled?: boolean; sender_no?: string }
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
  const effective = (settings.lotto_exclude_history ?? [])
    .filter((r) => r.effective_from <= today)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.round_no - a.round_no)
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

export type ExclusionRuleKey = 'prev' | 'bonus' | 'month' | 'freq' | 'forties' | 'manual'

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
}

export const MODE_OPTIONS: ExclusionMode[] = [10, 15, 20]

// ── 유료회원 지정요일 조합 SMS 자동발송(현장 피드백 6/18) ────────────────────────
// 유료 등급(골드/골드+/VIP/로얄)만 대상. 무료는 발급만(문자 X).
const PAID_GRADES = new Set(['gold', 'goldp', 'vip', 'royal'])

// 멀티테넌트 브랜드(배포별 VITE_BRAND/VITE_BRAND_SHORT). 서버함수라 process.env 사용
// (클라 lib/brand.ts 와 동일 로직 — api/ 밖 모듈 import 불가라 인라인 복제, DECISIONS 참조).
const BRAND_NAME = process.env.VITE_BRAND || '플러스로또'
const BRAND_SHORT =
  process.env.VITE_BRAND_SHORT || (BRAND_NAME.endsWith('로또') ? BRAND_NAME.slice(0, -2) : BRAND_NAME)

/**
 * 조합 목록 → SMS 본문(LMS). src/lib/sms.ts recoSmsBody 와 동일 포맷(자급자족 중복, 상단 참조).
 * 회차 숫자는 통신사 스팸 필터 회피를 위해 1233 → 12.33회차로 표기한다(현장 7/22).
 */
function formatComboSms(name: string, roundNo: number, sets: number[][]): string {
  const digits = String(Math.max(0, Math.trunc(roundNo)))
  const safeRound = digits.length > 2 ? `${digits.slice(0, -2)}.${digits.slice(-2)}` : digits
  const lines = sets.map((s, i) => `[${i + 1}] ${s.join(',')}`)
  return `[${BRAND_SHORT}]\n${safeRound}회차\n${name || '회원'}님\n${lines.join('\n')}`
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
  dest: string,
  body: string,
  sender: string,
): Promise<{ ok: boolean; code?: string }> {
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
        dest_phone: dest,
        msg_body: body,
        send_phone: sender,
        msgType: koByteLength(body) <= 90 ? 'SMS' : 'LMS',
      }),
    })
    const d = (await r.json()) as { ok?: boolean; code?: string }
    return { ok: !!d.ok, code: d.code }
  } catch {
    return { ok: false, code: 'NET' }
  }
}

// ── 크론 핸들러 ───────────────────────────────────────────────────────────────
const DEFAULT_DAY = 5 // 금요일(0=일..6=토)
const DEFAULT_COUNT = 30
const KEEP = 8

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  // fail-closed(D68): CRON_SECRET 미설정이면 '열림'이 아니라 '차단'. 미설정을 가시화.
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return res.status(500).json({ ok: false, code: 'CONFIG', message: 'CRON_SECRET 미설정' })
  }
  if (req.headers?.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, code: 'AUTH' })
  }
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return res.status(500).json({ ok: false, code: 'CONFIG', message: 'SUPABASE_URL/SERVICE_ROLE_KEY 미설정' })
  }
  const force = String(req.query?.force ?? '') === '1'
  const sb = createClient(url, key, { auth: { persistSession: false } })

  try {
    const kst = new Date(Date.now() + 9 * 3600_000)
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
    const paidSmsOn = !!smsCfg.oneshot_enabled && !!smsCfg.sender_no && !!cfg.paid_sms
    const sender = smsCfg.sender_no ?? ''
    const selfBase =
      process.env.SELF_BASE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

    // 무료 자동발급도 OFF, 유료 SMS 도 OFF 면 할 일 없음 → 종료.
    if (!cfg.enabled && !paidSmsOn && !force) return res.status(200).json({ ok: true, skipped: 'disabled' })

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
    // 적재 지연 감지(D68 #13, 비차단): 최신 회차 추첨일이 8일+ 지났으면 lotto 자동적재가 밀린 상태일 수 있어
    // targetRound 가 '이미 지난 회차'를 가리킬 위험 → 발급은 막지 않되 로그로 가시화(운영 점검 신호).
    const newest = rounds.reduce<LottoRound | null>((a, r) => (!a || r.round_no > a.round_no ? r : a), null)
    const staleRound = !!newest && Date.now() - new Date(newest.draw_date).getTime() > 8 * 86400_000
    if (staleRound) {
      console.warn(`[weekly-reco] 최신 회차(${newest?.round_no}) 추첨일 8일+ 경과 — 회차 적재 지연 의심, targetRound=${targetRound}`)
    }
    const baseCount = Math.max(1, cfg.set_count || DEFAULT_COUNT)
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
    // 대량(15만) 대비 range 페이지네이션.
    const rows: {
      id: string
      grade: string
      name: string | null
      phone: string | null
      meta: Record<string, unknown> | null
    }[] = []
    for (let from = 0; ; from += 1000) {
      const { data: mData, error: me } = await sb
        .from('members')
        .select('id, grade, name, phone, meta')
        .eq('is_deleted', false)
        .eq('is_withdrawn', false)
        .eq('is_suspended', false) // 일시정지(정지) 회원은 자동발급·문자 제외(현장 6/26)
        .order('id')
        .range(from, from + 999)
      if (me) throw me
      const page = (mData ?? []) as typeof rows
      rows.push(...page)
      if (page.length < 1000) break
    }

    let issued = 0
    let skippedRound = 0
    let skippedDay = 0
    let smsSent = 0
    let smsFail = 0
    let errCount = 0
    const issuedByGrade = new Map<string, number>()
    // 1) 적격 회원 선별(게이트) — CPU만, 빠름. 발급/발송은 2)에서 병렬.
    const eligible: {
      r: (typeof rows)[number]
      meta: Record<string, unknown>
      recos: WeeklyRecoIssue[]
      count: number
    }[] = []
    for (const r of rows) {
      const meta = r.meta ?? {}
      const day =
        typeof meta.weekly_reco_day === 'number'
          ? (meta.weekly_reco_day as number)
          : r.grade === 'free'
            ? DEFAULT_DAY
            : null // 유료 등 — 발송요일 미설정이면 자동발급 대상 아님
      if (day === null || (!force && day !== today)) {
        skippedDay++
        continue
      }
      // 무료 자동발급 OFF 시: 유료 지정요일 SMS 대상(paidSmsOn+유료등급)만 계속, 그 외(무료·기타)는 발급 안 함(D68 #12).
      if (!cfg.enabled && !force && !(paidSmsOn && PAID_GRADES.has(r.grade))) {
        skippedDay++
        continue
      }
      // 일시정지(조합발송 중단) 또는 발송갯수 명시적 0 → 발급·문자 제외(현장 6/26).
      // (count=0 은 기존엔 전역기본으로 폴백돼 발송됐으나, '0=중단' 직관에 맞게 차단)
      if (meta.reco_paused === true || meta.weekly_reco_count === 0) {
        skippedDay++
        continue
      }
      const recos = Array.isArray(meta.weekly_recos) ? (meta.weekly_recos as WeeklyRecoIssue[]) : []
      if (recos[0]?.round_no === targetRound) {
        skippedRound++
        continue
      }
      const count =
        typeof meta.weekly_reco_count === 'number' && (meta.weekly_reco_count as number) > 0
          ? (meta.weekly_reco_count as number)
          : baseCount
      eligible.push({ r, meta, recos, count })
    }

    // 2) 발급 + (유료)SMS — 동시성 제한 병렬. 순차로는 1000+명 발송이 함수 타임아웃(수십분)에 걸려
    //    일부만 나가던 위험을 차단(현장 6/24, 이윤선 1883명 대비). 단건 실패는 격리(잔여 진행).
    const CONC = 12
    const processOne = async ({ r, meta, recos, count }: (typeof eligible)[number]) => {
      const exclude = excludeFor(r.grade)
      // 로직 round(count×ratio%) + 완전랜덤 나머지(소스: src/lib/lottoGenerator.generateIssueSets)
      const logicCount = Math.max(0, Math.min(count, Math.round((count * ratio) / 100)))
      const sets =
        logicCount > 0
          ? generateRecommendation(rounds, exclude, { mode: 20, setCount: logicCount }).sets
          : []
      const seen = new Set(sets.map((s) => s.join('-')))
      let guard = 0
      while (sets.length < count && guard++ < count * 200) {
        const pool = Array.from({ length: LOTTO_MAX - LOTTO_MIN + 1 }, (_, i) => i + LOTTO_MIN)
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[pool[i], pool[j]] = [pool[j], pool[i]]
        }
        const set = pool.slice(0, LOTTO_PICK).sort((a, b) => a - b)
        const k = set.join('-')
        if (seen.has(k)) continue
        seen.add(k)
        sets.push(set)
      }
      const issue: WeeklyRecoIssue = { round_no: targetRound, issued_at: ts, sets }
      const nextMeta = { ...meta, weekly_recos: [issue, ...recos].slice(0, KEEP) }
      const { error } = await sb.from('members').update({ meta: nextMeta }).eq('id', r.id)
      if (error) {
        errCount++ // 단건 실패가 잔여 회원 발급을 막지 않도록 격리(D68 #8)
        return
      }
      issued++
      issuedByGrade.set(r.grade, (issuedByGrade.get(r.grade) ?? 0) + 1)

      // 유료회원(골드/골드+/VIP/로얄) 지정요일 조합 SMS 자동발송 — 신규 발급분만(멱등).
      if (paidSmsOn && PAID_GRADES.has(r.grade) && r.phone) {
        const smsBody = formatComboSms(r.name ?? '', targetRound, sets)
        const sres = await sendComboSms(selfBase, r.phone, smsBody, sender)
        await sb.from('sms_sends').insert({
          // 병렬 동시삽입 PK 충돌 방지: 시간+난수+회원 꼬리.
          id: `sms_cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${r.id.slice(-6)}`,
          member_id: r.id,
          template_key: null,
          phone: r.phone,
          body: smsBody,
          type: 'recommend',
          status: sres.ok ? '발송완료' : `실패(${sres.code ?? '?'})`,
          sent_at: ts,
        })
        if (sres.ok) smsSent++
        else smsFail++
      }
    }
    for (let i = 0; i < eligible.length; i += CONC) {
      await Promise.all(eligible.slice(i, i + CONC).map(processOne))
    }

    // 회차·등급별 로직 스냅샷 — 특정 회원 조합은 저장하지 않고 공통 제외 과정만 1건씩 기록한다.
    if (issuedByGrade.size > 0) {
      let generationRecords = [...(settings.generation_records ?? [])]
      for (const [grade, gradeIssued] of issuedByGrade) {
        const trace = generateRecommendation(rounds, excludeFor(grade), {
          mode: 20,
          setCount: 1,
          seed: targetRound,
        })
        const record: GenerationRecordLite = {
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

    await sb.from('logs').insert({
      id: `log_cron_${Date.now().toString(36)}`,
      kind: 'admin',
      actor: null,
      action: 'reco.weekly_issue',
      target_type: 'member',
      target_id: null,
      meta: { count: issued, skipped: skippedRound, skipped_day: skippedDay, errors: errCount, round_no: targetRound, stale_round: staleRound, channel: 'cron', force, sms_sent: smsSent, sms_fail: smsFail },
      created_at: ts,
    })

    return res.status(200).json({ ok: true, round_no: targetRound, issued, skippedRound, skippedDay, errors: errCount, staleRound, smsSent, smsFail })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return res.status(500).json({ ok: false, code: 'ERROR', message })
  }
}
