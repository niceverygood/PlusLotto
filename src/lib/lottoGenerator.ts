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
import type { LottoExcludeSettings, LottoRound } from '@/types/db'
import { LOTTO_MAX, LOTTO_MIN, LOTTO_PICK } from './lotto'

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
  candidates: number[] // 규칙이 최초로 추린 후보(중복 제거 전 흐름 확인용)
  selected: number[] // 이 규칙 후보 중 최종 제외수에 포함된 번호(규칙 간 중복 가능)
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
// lib/lottoPatentExclude.ts(특허 제외수 로직)도 동일 PRNG·정렬·조합필터 헬퍼를 재사용한다(§2 lib 내부 공유).
export function makeRng(seed: number): () => number {
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
export function sortedRoundsDesc(rounds: readonly LottoRound[]): LottoRound[] {
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
export function decadeBucket(n: number): number {
  return Math.min(4, Math.floor(n / 10))
}

export function maxConsecutiveRun(sortedAsc: readonly number[]): number {
  let best = 1
  let cur = 1
  for (let i = 1; i < sortedAsc.length; i++) {
    cur = sortedAsc[i] === sortedAsc[i - 1] + 1 ? cur + 1 : 1
    if (cur > best) best = cur
  }
  return best
}

export function consecutivePairCount(sortedAsc: readonly number[]): number {
  let c = 0
  for (let i = 1; i < sortedAsc.length; i++) if (sortedAsc[i] === sortedAsc[i - 1] + 1) c++
  return c
}

export function oddCount(nums: readonly number[]): number {
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

export function key(nums: readonly number[]): string {
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
export function drawCombo(pool: readonly number[], fixed: readonly number[], rng: () => number): number[] {
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

// ── 발급용 조합 생성(현장 피드백 <추천번호> 6) ────────────────────────────────
// 로직 적용 비율(%)에 따라 [통계 로직 조합 + 완전랜덤 조합]을 섞어 count 개를 만든다.
// 예) count=10, ratio=70 → 로직 7 + 랜덤 3. 랜덤 조합은 제외수/품질필터 미적용(완전 무작위),
// 단 로직 조합과의 중복만 회피한다. ratio 기본 100(전부 로직).

const setKey = (s: readonly number[]) => s.join('-')

/** 완전 랜덤 6/45 조합 count 개(avoid 와 중복 회피). */
export function generateRandomSets(count: number, avoid: ReadonlySet<string> = new Set()): number[][] {
  const out: number[][] = []
  const seen = new Set(avoid)
  let guard = 0
  while (out.length < count && guard++ < count * 200) {
    const pool = Array.from({ length: LOTTO_MAX - LOTTO_MIN + 1 }, (_, i) => i + LOTTO_MIN)
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    const set = pool.slice(0, LOTTO_PICK).sort((a, b) => a - b)
    const k = setKey(set)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(set)
  }
  return out
}

/** 발급 조합 = 로직 round(count×ratio%) + 완전랜덤 나머지. 모든 발급 경로(주간/수동/등급일괄)가 공유. */
export function generateIssueSets(
  rounds: readonly LottoRound[],
  exclude: LottoExcludeSettings,
  count: number,
  logicRatio = 100,
  seed?: number,
): number[][] {
  const total = Math.max(1, count)
  const ratio = Math.max(0, Math.min(100, Math.round(logicRatio)))
  const logicCount = Math.max(0, Math.min(total, Math.round((total * ratio) / 100)))
  const sets =
    logicCount > 0
      ? generateRecommendation(rounds, exclude, { mode: 20, setCount: logicCount, seed }).sets
      : []
  const randomCount = total - sets.length
  if (randomCount > 0) sets.push(...generateRandomSets(randomCount, new Set(sets.map(setKey))))
  return sets
}
